// Royal Inn gallery backend — Cloudflare Worker (JS, zero dependencies).
// NO-CARD stack: files live in Supabase Storage (free plan), metadata in D1 (free plan).
//
// Routes:
//   GET    /api/gallery                public media list as URL strings (cached 60s)
//   GET    /api/menu                   public menu (sections + items) (cached 300s)
//   POST   /api/login                  verify admin password -> HMSAFE session cookie
//   POST   /api/upload                 multipart upload (auth required)
//   POST   /api/admin/logo             section-logo image upload (auth required)
//   GET    /api/admin/media            admin list with ids (auth required)
//   DELETE /api/admin/media/:id        delete item (auth required)
//   GET    /api/admin/menu             admin menu with ids (auth required)
//   POST   /api/admin/menu/sections    create section (auth required)
//   PUT    /api/admin/menu/sections/:id   update section (auth required)
//   DELETE /api/admin/menu/sections/:id   delete section + its items (auth required)
//   POST   /api/admin/menu/items       create item (auth required)
//   PUT    /api/admin/menu/items/:id   update item (auth required)
//   DELETE /api/admin/menu/items/:id   delete item (auth required)
//   GET    /media/<key>                redirect to the public Supabase object URL (video Range via their CDN)
//   GET    /admin                      admin page (served from this Worker)
//   GET    /                           redirect -> /admin
//
// Deploy: npx wrangler deploy   (see BACKEND-SETUP.md / WORKLOG)

const API_PREFIX = '/media/';

const ALLOW = /\.(jpg|jpeg|png|webp|gif|mp4|webm|mov)$/i;
const MAX_BYTES = 48 * 1024 * 1024; // Supabase free plan caps uploads at 50 MB; keep margin

// Section logo uploads: images only, small, stored in the same public bucket
// under a logos/ prefix (never registered in the media table, so the Gallery
// tab and /api/gallery stay untouched).
const LOGO_ALLOW = /\.(jpg|jpeg|png|webp|gif)$/i;
const LOGO_MAX_BYTES = 5 * 1024 * 1024;

const EXT_TYPE = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime'
};

const enc = new TextEncoder();

// ---------- helpers ----------

function getExt(name) {
  const i = name.lastIndexOf('.');
  return i > -1 ? name.slice(i).toLowerCase() : '';
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function bytesToHex(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
  return s;
}

function b64url(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function constTimeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(data, extra) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };
  if (extra && extra.headers) Object.assign(headers, extra.headers);
  return new Response(JSON.stringify(data), { status: (extra && extra.status) || 200, headers });
}

function parseCookie(str) {
  const out = {};
  str.split(';').forEach(function (pair) {
    const i = pair.indexOf('=');
    if (i > -1) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  });
  return out;
}

// ---------- auth ----------

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
}

// stored format: pbkdf2-sha256$iterations$saltHex$hashHex   (produced by hash-password.mjs)
async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1000 || iterations > 100000) return false;
  const saltHex = parts[2];
  const expected = parts[3].toLowerCase();
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(expected)) return false;
  const bits = await pbkdf2(password, hexToBytes(saltHex), iterations);
  return constTimeEq(bytesToHex(new Uint8Array(bits)), expected);
}

async function hmac(msg, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, msg);
}

function signToken(exp, secret) {
  return hmac(enc.encode(String(exp)), secret).then(function (sig) {
    return String(exp) + '.' + b64url(new Uint8Array(sig));
  });
}

async function verifyToken(token, secret) {
  if (!token || typeof token !== 'string' || !secret) return false;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = await signToken(exp, secret);
  return constTimeEq(token, expected);
}

async function isAuthed(request, env) {
  if (!env.SESSION_SECRET) return false;
  const cookie = parseCookie(request.headers.get('Cookie') || '');
  return verifyToken(cookie.admin_session, env.SESSION_SECRET);
}

// ---------- Supabase storage (files) ----------

function storageBase(env) {
  return env.SUPABASE_URL + '/storage/v1/object/' + env.SUPABASE_BUCKET;
}

function storageHeaders(env) {
  // Supabase's newer sb_secret_ keys are rejected with 401 "No API key found in
  // request" unless they also travel in the apikey header; legacy service_role
  // JWTs ignore the extra header, so sending both is safe for either key type.
  const key = env.SUPABASE_SERVICE_KEY || '';
  const headers = { 'Authorization': 'Bearer ' + key };
  if (key) headers['apikey'] = key;
  return headers;
}

async function supabasePut(env, key, buf, mime) {
  const headers = storageHeaders(env);
  headers['Content-Type'] = mime;
  const res = await fetch(storageBase(env) + '/' + key, { method: 'POST', headers, body: buf });
  if (!res.ok) {
    const detail = await res.text().catch(function () { return ''; });
    throw new Error('Supabase upload failed (' + res.status + '): ' + detail.slice(0, 300));
  }
}

async function supabaseDelete(env, key) {
  const res = await fetch(storageBase(env) + '/' + key, { method: 'DELETE', headers: storageHeaders(env) });
  if (!res.ok && res.status !== 404) throw new Error('Supabase delete failed with status ' + res.status);
}

function publicMediaUrl(env, key) {
  return env.SUPABASE_URL + '/storage/v1/object/public/' + env.SUPABASE_BUCKET + '/' + key;
}

// ---------- handlers ----------

async function listGallery(env, origin) {
  const { results } = await env.DB.prepare('SELECT file_key FROM media ORDER BY id ASC').all();
  return json(results.map(function (r) { return origin + API_PREFIX + r.file_key; }), {
    headers: { 'Cache-Control': 'public, max-age=60' }
  });
}

async function login(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad request' }, { status: 400 }); }
  const ok = await verifyPassword(String(body.password || ''), env.ADMIN_PASSWORD_HASH);
  if (!ok) return json({ error: 'unauthorized' }, { status: 401 });
  const exp = Date.now() + 12 * 60 * 60 * 1000;
  const token = await signToken(exp, env.SESSION_SECRET);
  return json({ ok: true }, {
    headers: { 'Set-Cookie': 'admin_session=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200' }
  });
}

async function upload(request, env) {
  if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, { status: 401 });
  let fd;
  try { fd = await request.formData(); } catch (e) { return json({ error: 'bad request' }, { status: 400 }); }
  const file = fd.get('file');
  if (!file || typeof file.size !== 'number') return json({ error: 'no file' }, { status: 400 });
  const name = String(file.name || '').split('/').pop().split('\\').pop();
  if (!ALLOW.test(name)) return json({ error: 'unsupported type (allowed: jpg, jpeg, png, webp, gif, mp4, webm, mov)' }, { status: 415 });
  const ext = getExt(name);
  const mime = file.type || EXT_TYPE[ext] || 'application/octet-stream';
  const size = file.size;
  if (size > MAX_BYTES) return json({ error: 'too large (max 48 MB)' }, { status: 413 });
  const buf = new Uint8Array(await file.arrayBuffer());
  const key = Date.now() + '-' + name.replace(/[^\w.\-]+/g, '_');
  try {
    await supabasePut(env, key, buf, mime);
  } catch (e) {
    return json({ error: String(e.message || e) }, { status: 502 });
  }
  const kind = mime.startsWith('video/') ? 'video' : 'image';
  try {
    await env.DB.prepare('INSERT INTO media (file_key, kind, mime, size) VALUES (?, ?, ?, ?)')
      .bind(key, kind, mime, size).run();
  } catch (e) {
    return json({ error: 'database error: ' + String(e.message || e) }, { status: 500 });
  }
  return json({ file: name, key, url: API_PREFIX + key, size, kind });
}

async function logoUpload(request, env) {
  if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, { status: 401 });
  let fd;
  try { fd = await request.formData(); } catch (e) { return json({ error: 'bad request' }, { status: 400 }); }
  const file = fd.get('file');
  if (!file || typeof file.size !== 'number') return json({ error: 'no file' }, { status: 400 });
  const name = String(file.name || '').split('/').pop().split('\\').pop();
  if (!LOGO_ALLOW.test(name)) return json({ error: 'images only (jpg, png, webp, gif)' }, { status: 415 });
  const ext = getExt(name);
  const mime = file.type || EXT_TYPE[ext] || 'application/octet-stream';
  if (file.size > LOGO_MAX_BYTES) return json({ error: 'too large (max 5 MB)' }, { status: 413 });
  const buf = new Uint8Array(await file.arrayBuffer());
  const key = 'logos/' + Date.now() + '-' + name.replace(/[^\w.\-]+/g, '_');
  try {
    await supabasePut(env, key, buf, mime);
  } catch (e) {
    return json({ error: String(e.message || e) }, { status: 502 });
  }
  return json({ file: name, key, url: publicMediaUrl(env, key) });
}

async function adminList(request, env) {
  if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, { status: 401 });
  const { results } = await env.DB.prepare(
    'SELECT id, file_key AS file, kind, mime, size, uploaded_at FROM media ORDER BY id ASC').all();
  return json(results.map(function (r) {
    return { id: r.id, file: r.file, url: API_PREFIX + r.file, kind: r.kind, mime: r.mime, size: r.size, uploaded_at: r.uploaded_at };
  }));
}

async function adminDelete(request, env, id) {
  if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, { status: 401 });
  const row = await env.DB.prepare('SELECT file_key FROM media WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'not found' }, { status: 404 });
  await supabaseDelete(env, row.file_key);
  await env.DB.prepare('DELETE FROM media WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

// ---------- menu ----------

function splitTags(tags) {
  return tags ? tags.split(',').map(function (t) { return t.trim(); }).filter(Boolean) : [];
}

async function menuAll(env) {
  const sections = (await env.DB.prepare(
    'SELECT id, slug, title, blurb, img FROM menu_sections ORDER BY sort_order, id').all()).results;
  const items = (await env.DB.prepare(
    'SELECT id, section_id, name, price, note, tags, matrix FROM menu_items ORDER BY sort_order, id').all()).results;
  const bySec = {};
  items.forEach(function (it) { (bySec[it.section_id] = bySec[it.section_id] || []).push(it); });
  return sections.map(function (s) {
    return {
      id: s.id,
      slug: s.slug,
      title: s.title,
      blurb: s.blurb,
      img: s.img,
      items: (bySec[s.id] || []).map(function (it) {
        return {
          id: it.id,
          name: it.name,
          price: it.price,
          note: it.note,
          tags: splitTags(it.tags),
          matrix: !!it.matrix
        };
      })
    };
  });
}

async function getMenu(env) {
  return json(await menuAll(env), { headers: { 'Cache-Control': 'public, max-age=300' } });
}

async function adminMenu(request, env) {
  if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, { status: 401 });
  return json(await menuAll(env), { headers: { 'Cache-Control': 'no-store' } });
}

async function menuSectionCreate(request, env) {
  if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, { status: 401 });
  let body; try { body = await request.json(); } catch (e) { return json({ error: 'bad request' }, { status: 400 }); }
  const slug = String(body.slug || '').trim().toLowerCase().replace(/\s+/g, '-');
  const title = String(body.title || '').trim();
  const blurb = String(body.blurb || '').trim();
  const img = String(body.img || '').trim();
  if (!/^[a-z0-9][a-z0-9\-]*$/.test(slug) || !title) return json({ error: 'bad request' }, { status: 400 });
  const exists = await env.DB.prepare('SELECT id FROM menu_sections WHERE slug = ?').bind(slug).first();
  if (exists) return json({ error: 'slug already in use' }, { status: 409 });
  const row = await env.DB.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM menu_sections').first();
  const res = await env.DB.prepare('INSERT INTO menu_sections (slug, title, blurb, img, sort_order) VALUES (?, ?, ?, ?, ?)')
    .bind(slug, title, blurb, img, row.m + 1).run();
  return json({ id: res.meta.last_row_id, slug, title, blurb, img, items: [] });
}

async function menuSectionUpdate(request, env, id) {
  if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, { status: 401 });
  const cur = await env.DB.prepare('SELECT * FROM menu_sections WHERE id = ?').bind(id).first();
  if (!cur) return json({ error: 'not found' }, { status: 404 });
  let body; try { body = await request.json(); } catch (e) { return json({ error: 'bad request' }, { status: 400 }); }
  let slug = String(body.slug === undefined ? cur.slug : body.slug).trim().toLowerCase().replace(/\s+/g, '-');
  const title = String(body.title === undefined ? cur.title : body.title).trim();
  const blurb = String(body.blurb === undefined ? cur.blurb : body.blurb).trim();
  const img = String(body.img === undefined ? cur.img : body.img).trim();
  if (!/^[a-z0-9][a-z0-9\-]*$/.test(slug) || !title) return json({ error: 'bad request' }, { status: 400 });
  if (slug !== cur.slug) {
    const clash = await env.DB.prepare('SELECT id FROM menu_sections WHERE slug = ? AND id != ?').bind(slug, id).first();
    if (clash) return json({ error: 'slug already in use' }, { status: 409 });
  }
  await env.DB.prepare('UPDATE menu_sections SET slug = ?, title = ?, blurb = ?, img = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .bind(slug, title, blurb, img, id).run();
  return json({ ok: true, id: Number(id), slug, title, blurb, img });
}

async function menuSectionDelete(request, env, id) {
  if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, { status: 401 });
  const sec = await env.DB.prepare('SELECT id FROM menu_sections WHERE id = ?').bind(id).first();
  if (!sec) return json({ error: 'not found' }, { status: 404 });
  await env.DB.prepare('DELETE FROM menu_items WHERE section_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM menu_sections WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

async function menuItemCreate(request, env) {
  if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, { status: 401 });
  let body; try { body = await request.json(); } catch (e) { return json({ error: 'bad request' }, { status: 400 }); }
  const sectionId = Number(body.section_id);
  const name = String(body.name || '').trim();
  if (!Number.isFinite(sectionId) || !name) return json({ error: 'bad request' }, { status: 400 });
  const sec = await env.DB.prepare('SELECT id FROM menu_sections WHERE id = ?').bind(sectionId).first();
  if (!sec) return json({ error: 'not found' }, { status: 404 });
  const price = String(body.price || '').trim();
  const note = String(body.note || '').trim();
  const tags = Array.isArray(body.tags) ? body.tags.filter(function (t) { return String(t).trim(); }).join(',') : String(body.tags || '').trim();
  const matrix = body.matrix ? 1 : 0;
  const row = await env.DB.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM menu_items WHERE section_id = ?').bind(sectionId).first();
  const res = await env.DB.prepare('INSERT INTO menu_items (section_id, name, price, note, tags, matrix, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(sectionId, name, price, note, tags, matrix, row.m + 1).run();
  return json({ id: res.meta.last_row_id, section_id: sectionId, name, price, note, tags: splitTags(tags), matrix: !!matrix });
}

async function menuItemUpdate(request, env, id) {
  if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, { status: 401 });
  const cur = await env.DB.prepare('SELECT * FROM menu_items WHERE id = ?').bind(id).first();
  if (!cur) return json({ error: 'not found' }, { status: 404 });
  let body; try { body = await request.json(); } catch (e) { return json({ error: 'bad request' }, { status: 400 }); }
  const name = String(body.name === undefined ? cur.name : body.name).trim();
  if (!name) return json({ error: 'bad request' }, { status: 400 });
  const price = String(body.price === undefined ? cur.price : body.price).trim();
  const note = String(body.note === undefined ? cur.note : body.note).trim();
  const tags = Array.isArray(body.tags) ? body.tags.filter(function (t) { return String(t).trim(); }).join(',')
    : String(body.tags === undefined ? cur.tags : body.tags).trim();
  const matrix = body.matrix === undefined ? cur.matrix : (body.matrix ? 1 : 0);
  await env.DB.prepare('UPDATE menu_items SET name = ?, price = ?, note = ?, tags = ?, matrix = ? WHERE id = ?')
    .bind(name, price, note, tags, matrix, id).run();
  return json({ ok: true, id: Number(id), name, price, note, tags: splitTags(tags), matrix: !!matrix });
}

async function menuItemDelete(request, env, id) {
  if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, { status: 401 });
  const it = await env.DB.prepare('SELECT id FROM menu_items WHERE id = ?').bind(id).first();
  if (!it) return json({ error: 'not found' }, { status: 404 });
  await env.DB.prepare('DELETE FROM menu_items WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

// ---------- worker entry ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }
    if (path === '/' && method === 'GET') return Response.redirect(url.origin + '/admin', 302);
    if ((path === '/admin' || path === '/admin.html') && method === 'GET') {
      return new Response(ADMIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (path === '/api/gallery' && method === 'GET') return listGallery(env, url.origin);
    if (path === '/api/menu' && method === 'GET') return getMenu(env);
    if (path === '/api/login' && method === 'POST') return login(request, env);
    if (path === '/api/upload' && method === 'POST') return upload(request, env);
    if (path === '/api/admin/logo' && method === 'POST') return logoUpload(request, env);
    if (path === '/api/admin/media' && method === 'GET') return adminList(request, env);

    const del = /^\/api\/admin\/media\/(\d+)$/.exec(path);
    if (del && method === 'DELETE') return adminDelete(request, env, del[1]);

    if (path === '/api/admin/menu' && method === 'GET') return adminMenu(request, env);
    if (path === '/api/admin/menu/sections' && method === 'POST') return menuSectionCreate(request, env);
    if (path === '/api/admin/menu/items' && method === 'POST') return menuItemCreate(request, env);
    const secPatch = /^\/api\/admin\/menu\/sections\/(\d+)$/.exec(path);
    if (secPatch && method === 'PUT') return menuSectionUpdate(request, env, secPatch[1]);
    if (secPatch && method === 'DELETE') return menuSectionDelete(request, env, secPatch[1]);
    const itemPatch = /^\/api\/admin\/menu\/items\/(\d+)$/.exec(path);
    if (itemPatch && method === 'PUT') return menuItemUpdate(request, env, itemPatch[1]);
    if (itemPatch && method === 'DELETE') return menuItemDelete(request, env, itemPatch[1]);

    if (path.startsWith(API_PREFIX)) {
      const key = decodeURIComponent(path.slice(API_PREFIX.length));
      return Response.redirect(publicMediaUrl(env, key), 307);
    }

    return new Response('Not found', { status: 404 });
  }
};

// ---------- embedded admin page (source kept in backend/admin.html) ----------

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Royal Inn — Admin (Gallery &amp; Menu)</title>
<style>
  :root { --bg:#0e0d0b; --panel:#171512; --line:#2b261f; --gold:#b08d57; --text:#e9e3d8; --muted:#9c9388; --danger:#c0503f; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:Georgia, 'Times New Roman', serif; }
  .wrap { max-width:940px; margin:0 auto; padding:32px 20px 80px; }
  h1 { font-weight:500; letter-spacing:.5px; font-size:26px; }
  h1 small { display:block; color:var(--muted); font-size:13px; letter-spacing:2px; margin-top:4px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:22px; margin-top:22px; }
  label { display:block; color:var(--muted); font-size:12px; letter-spacing:1.5px; text-transform:uppercase; margin-bottom:8px; }
  input[type=password] { width:100%; padding:12px 14px; border:1px solid var(--line); border-radius:8px; background:#201d1a; color:var(--text); font-size:15px; }
  input[type=text] { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:#201d1a; color:var(--text); font-size:14px; }
  input[type=text]:focus, input[type=password]:focus { outline:none; border-color:var(--gold); }
  button { cursor:pointer; border:none; border-radius:8px; padding:12px 20px; font-size:14px; background:var(--gold); color:#17130d; font-weight:700; letter-spacing:.5px; }
  button.secondary { background:#2b261f; color:var(--text); border:1px solid var(--line); font-weight:500; }
  button.ghost { background:transparent; color:var(--danger); border:1px solid var(--danger); padding:6px 10px; font-size:12px; font-weight:500; }
  button.mini { padding:7px 12px; font-size:12px; }
  .err { color:var(--danger); font-size:13px; min-height:18px; margin-top:10px; }
  .drop { border:2px dashed var(--line); border-radius:10px; padding:40px 20px; text-align:center; color:var(--muted); transition:.15s; }
  .drop.drag { border-color:var(--gold); color:var(--gold); background:#1d1a16; }
  .drop b { color:var(--text); }
  .logo-drop { border:2px dashed var(--line); border-radius:8px; padding:18px 14px; text-align:center; color:var(--muted); transition:.15s; cursor:pointer; }
  .logo-drop.drag { border-color:var(--gold); color:var(--gold); background:#1d1a16; }
  .logo-drop b { color:var(--text); }
  .logo-preview-row { display:flex; align-items:center; gap:14px; margin-top:10px; }
  .logo-preview-row img { width:64px; height:64px; border-radius:50%; object-fit:cover; border:1px solid var(--line); }
  .status { margin-top:14px; font-size:13px; color:var(--muted); white-space:pre-line; }
  .badge { display:inline-block; font-size:11px; letter-spacing:1px; padding:3px 8px; border-radius:20px; border:1px solid var(--line); color:var(--muted); }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:14px; margin-top:16px; }
  .item { border:1px solid var(--line); border-radius:10px; overflow:hidden; background:#12100d; }
  .item .thumb { aspect-ratio:4/3; background:#000; display:block; }
  .item .thumb img, .item .thumb video { width:100%; height:100%; object-fit:cover; display:block; }
  .item .meta { padding:10px 12px; font-size:12px; color:var(--muted); }
  .item .meta .name { color:var(--text); word-break:break-all; }
  .item .row { display:flex; justify-content:space-between; align-items:center; margin-top:8px; }
  .tabs { display:flex; gap:8px; margin-top:22px; border-bottom:1px solid var(--line); padding-bottom:12px; }
  .tab { background:transparent; color:var(--muted); border:1px solid var(--line); font-weight:500; padding:9px 18px; font-size:13px; letter-spacing:1px; text-transform:uppercase; }
  .tab.active { background:var(--gold); color:#17130d; border-color:var(--gold); }
  .tab-panel { margin-top:18px; }
  .add-btn { width:100%; padding:14px; background:transparent; border:1px dashed var(--line); color:var(--muted); font-weight:500; border-radius:10px; font-family:inherit; }
  .add-btn:hover { border-color:var(--gold); color:var(--gold); }
  .sec { border:1px solid var(--line); border-radius:10px; background:#12100d; padding:16px 18px; margin-top:14px; }
  .sec:last-child { margin-bottom:4px; }
  .sec-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
  .sec-title { font-size:18px; color:var(--text); font-weight:500; }
  .sec-title .muted { display:inline-block; margin-left:8px; font-size:12px; letter-spacing:1px; text-transform:uppercase; }
  .sec-blurb { color:var(--muted); font-size:13px; margin-top:4px; }
  .sec-actions { display:flex; gap:6px; flex-wrap:wrap; }
  .sec-actions button.add-item { color:var(--gold); border-color:var(--gold); }
  .sec-items { border-top:1px solid var(--line); margin-top:12px; padding-top:6px; }
  .row-item { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:9px 0; border-bottom:1px dashed rgba(43,38,31,.6); }
  .row-item:last-child { border-bottom:0; }
  .row-item .txt { min-width:0; }
  .row-item .nm { font-size:15px; color:var(--text); }
  .row-item .pt { font-size:13px; color:var(--gold); margin-left:8px; white-space:nowrap; }
  .row-item .nt { font-size:12px; color:var(--muted); display:block; margin-top:2px; }
  .tag { display:inline-block; font-size:10px; letter-spacing:1px; text-transform:uppercase; padding:2px 6px; border-radius:20px; border:1px solid var(--gold); color:var(--gold); margin-left:6px; vertical-align:middle; }
  .mini-form { background:#0e0d0b; border:1px solid var(--line); border-radius:8px; padding:14px; margin-top:12px; }
  .mini-form .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .mini-form .grid2 .full { grid-column:1 / -1; }
  .check { display:flex; align-items:center; gap:8px; color:var(--muted); font-size:13px; text-transform:none; letter-spacing:.3px; margin:10px 0; }
  .check input { width:auto; }
  .form-row { display:flex; gap:10px; margin-top:12px; }
  .muted { color:var(--muted); }
  .hint { font-size:11px; color:var(--muted); opacity:.8; letter-spacing:.3px; text-transform:none; margin-top:-4px; margin-bottom:10px; }
  .empty { color:var(--muted); font-size:13px; padding:14px 0; }
  .inline { display:flex; gap:10px; align-items:center; }
  [hidden] { display:none !important; }
  @media (max-width:560px) { .mini-form .grid2 { grid-template-columns:1fr; } .row-item { flex-direction:column; align-items:flex-start; } }
</style>
</head>
<body>
<div class="wrap">
  <h1>Royal Inn <small>Admin — gallery &amp; menu</small></h1>

  <section class="card" id="loginCard">
    <label for="pwd">Password</label>
    <input type="password" id="pwd" placeholder="Enter admin password" autocomplete="current-password" />
    <div style="margin-top:14px"><button id="loginBtn">Log in</button></div>
    <div class="err" id="loginErr"></div>
  </section>

  <div id="panel" hidden>
    <div class="tabs">
      <button class="tab active" data-tab="gallery">Gallery</button>
      <button class="tab" data-tab="menu">Menu</button>
    </div>

    <section class="tab-panel" id="tab-gallery">
      <div id="drop" class="drop">
        <p style="margin:0">
          <b>Drag photos or videos here</b><br />
          or <span class="muted">click to browse — multiple files supported</span>
        </p>
        <input type="file" id="fileInput" accept=".jpg,.jpeg,.png,.webp,.gif,.mp4,.webm,.mov" multiple hidden />
      </div>
      <div class="status" id="status"></div>
      <hr style="border-color:var(--line); margin:20px 0 0" />
      <p class="muted" style="font-size:12px; letter-spacing:1.5px; text-transform:uppercase; margin-bottom:0">
        Saved media <span class="badge" id="count"></span>
      </p>
      <div class="grid" id="grid"></div>
    </section>

    <section class="tab-panel" id="tab-menu" hidden>
      <button class="add-btn" id="addSecBtn">+ Add menu section</button>

      <div class="card mini-form" id="secForm" hidden style="margin-top:14px">
        <div class="grid2">
          <div>
            <label for="secSlug">Slug (url anchor)</label>
            <input type="text" id="secSlug" placeholder="e.g. specials" />
            <div class="hint">lowercase letters, numbers, dashes. The in-page anchor.</div>
          </div>
          <div>
            <label for="secTitle">Title</label>
            <input type="text" id="secTitle" placeholder="e.g. Chef's Specials" />
          </div>
          <div class="full">
            <label for="secBlurb">Blurb (one-liner under the title)</label>
            <input type="text" id="secBlurb" placeholder="The plates we're known for—straight from the coals." />
          </div>
          <div class="full">
            <label>Round logo image (drag &amp; drop or click)</label>
            <div class="logo-drop" id="secLogoDrop">
              <p style="margin:0"><b>Drop the logo here</b><br /><span class="muted">or click to browse · jpg, png, webp, gif · max 5 MB</span></p>
              <input type="file" id="secLogoInput" accept=".jpg,.jpeg,.png,.webp,.gif" hidden />
            </div>
            <div class="logo-preview-row" id="secLogoPreview" hidden>
              <img src="" alt="Section logo" id="secLogoPreviewImg" />
              <div>
                <button class="ghost" id="secLogoRemove">Remove image</button>
                <div class="hint" style="margin:6px 0 0" id="secLogoStatus"></div>
              </div>
            </div>
            <div class="hint" id="secLogoSaveNote"></div>
          </div>
        </div>
        <div class="form-row">
          <button id="secSave" class="secondary">Add section</button>
          <button id="secCancel" class="ghost" hidden>Cancel</button>
        </div>
        <div class="err" id="secErr"></div>
      </div>

      <div id="secList"></div>
      <div class="empty" id="secEmpty">No menu sections yet — click "+ Add menu section".</div>
    </section>
  </div>
</div>

<script>
(function () {
  var loginCard = document.getElementById('loginCard');
  var pwdInput = document.getElementById('pwd');
  var loginBtn = document.getElementById('loginBtn');
  var loginErr = document.getElementById('loginErr');
  var panel = document.getElementById('panel');
  var drop = document.getElementById('drop');
  var fileInput = document.getElementById('fileInput');
  var statusEl = document.getElementById('status');
  var grid = document.getElementById('grid');
  var countEl = document.getElementById('count');

  var tabBtns = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var secForm = document.getElementById('secForm');
  var secSlug = document.getElementById('secSlug');
  var secTitle = document.getElementById('secTitle');
  var secBlurb = document.getElementById('secBlurb');
  var secLogoDrop = document.getElementById('secLogoDrop');
  var secLogoInput = document.getElementById('secLogoInput');
  var secLogoPreview = document.getElementById('secLogoPreview');
  var secLogoPreviewImg = document.getElementById('secLogoPreviewImg');
  var secLogoRemove = document.getElementById('secLogoRemove');
  var secLogoStatus = document.getElementById('secLogoStatus');
  var secSave = document.getElementById('secSave');
  var secCancel = document.getElementById('secCancel');
  var secErr = document.getElementById('secErr');
  var secList = document.getElementById('secList');
  var secEmpty = document.getElementById('secEmpty');
  var addSecBtn = document.getElementById('addSecBtn');

  var menuData = [];
  var editingSecId = null;
  var secLogoUrl = '';

  function updateSecLogoPreview() {
    if (secLogoUrl) {
      secLogoPreview.hidden = false;
      secLogoPreviewImg.src = secLogoUrl;
      secLogoPreviewImg.style.display = '';
      secLogoPreviewImg.onerror = function () { secLogoPreviewImg.style.display = 'none'; };
    } else {
      secLogoPreview.hidden = true;
      secLogoPreviewImg.src = '';
      secLogoPreviewImg.onerror = null;
    }
  }

  function uploadSecLogo(file) {
    if (!/\\.(jpe?g|png|webp|gif)$/i.test(file.name)) { secLogoStatus.textContent = 'Images only (jpg, png, webp, gif).'; return; }
    if (file.size > 5 * 1024 * 1024) { secLogoStatus.textContent = 'Too large — max 5 MB.'; return; }
    var fd = new FormData();
    fd.append('file', file, file.name);
    secLogoStatus.textContent = 'Uploading logo …';
    req('/api/admin/logo', { method: 'POST', body: fd }).then(function (r) { return r.json(); })
      .then(function (res) {
        secLogoUrl = res.url;
        updateSecLogoPreview();
        secLogoStatus.textContent = 'Logo uploaded.';
      })
      .catch(function (e) { secLogoStatus.textContent = 'Upload failed — ' + (e.message || 'try again.'); });
  }

  if (secLogoDrop) {
    secLogoDrop.addEventListener('click', function () { secLogoInput.click(); });
    secLogoInput.addEventListener('change', function () { if (secLogoInput.files.length) uploadSecLogo(secLogoInput.files[0]); secLogoInput.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) {
      secLogoDrop.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); secLogoDrop.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      secLogoDrop.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); secLogoDrop.classList.remove('drag'); });
    });
    secLogoDrop.addEventListener('drop', function (e) { if (e.dataTransfer.files.length) uploadSecLogo(e.dataTransfer.files[0]); });
  }
  if (secLogoRemove) {
    secLogoRemove.addEventListener('click', function () { secLogoUrl = ''; secLogoStatus.textContent = ''; updateSecLogoPreview(); });
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function fmtDate(s) {
    if (!s) return '';
    return String(s).replace('T', ' ').slice(0, 16) + ' UTC';
  }

  function req(url, opts) {
    return fetch(url, opts).then(function (r) {
      if (r.status === 401) throw { auth: true };
      if (r.ok) return r;
      return r.text().then(function (t) {
        var msg = null;
        try { var j = JSON.parse(t); msg = j && j.error; } catch (e) { msg = null; }
        throw new Error(msg || t || ('HTTP ' + r.status));
      });
    });
  }

  function showLogin() { loginCard.hidden = false; panel.hidden = true; }
  function showPanel() { loginCard.hidden = true; panel.hidden = false; }

  function showTab(name) {
    tabBtns.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === name); });
    document.getElementById('tab-gallery').hidden = name !== 'gallery';
    document.getElementById('tab-menu').hidden = name !== 'menu';
  }
  tabBtns.forEach(function (b) {
    b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
  });

  loginBtn.addEventListener('click', function () {
    var pwd = pwdInput.value;
    if (!pwd) return;
    loginErr.textContent = '';
    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd })
    }).then(function (r) {
      if (r.ok) { pwdInput.value = ''; loadAll(); }
      else { loginErr.textContent = 'Wrong password.'; }
    }).catch(function () { loginErr.textContent = 'Login failed — try again.'; });
  });
  pwdInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') loginBtn.click(); });

  function loadAll() {
    return Promise.all([req('/api/admin/media').then(function (r) { return r.json(); }),
                        req('/api/admin/menu').then(function (r) { return r.json(); })])
      .then(function (res) {
        render(res[0] || []);
        menuData = res[1] || [];
        renderMenu();
        showPanel();
      }).catch(function (e) {
        if (e && e.auth) showLogin();
        else statusEl.textContent = 'Could not load — ' + ((e && e.message) || 'try again.');
      });
  }

  // ---------- gallery ----------
  function render(items) {
    countEl.textContent = items.length + ' item' + (items.length === 1 ? '' : 's');
    grid.innerHTML = '';
    items.forEach(function (it) {
      var el = document.createElement('div');
      el.className = 'item';
      var thumb = document.createElement('div');
      thumb.className = 'thumb';
      if (it.kind === 'video') {
        var v = document.createElement('video');
        v.src = it.url; v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'metadata';
        thumb.appendChild(v);
      } else {
        var im = document.createElement('img');
        im.src = it.url; im.loading = 'lazy'; im.alt = '';
        thumb.appendChild(im);
      }
      var meta = document.createElement('div');
      meta.className = 'meta';
      var name = document.createElement('div');
      name.className = 'name'; name.textContent = it.file;
      var sub = document.createElement('div');
      sub.textContent = fmtBytes(it.size) + ' · ' + fmtDate(it.uploaded_at);
      var row = document.createElement('div');
      row.className = 'row';
      var del = document.createElement('button');
      del.className = 'ghost'; del.textContent = 'Delete';
      del.addEventListener('click', function () {
        if (!confirm('Delete "' + it.file + '"?')) return;
        req('/api/admin/media/' + it.id, { method: 'DELETE' }).then(function () {
          statusEl.textContent = 'Deleted ' + it.file;
          loadAll();
        }).catch(function () { statusEl.textContent = 'Delete failed.'; });
      });
      row.appendChild(del);
      meta.appendChild(name); meta.appendChild(sub); meta.appendChild(row);
      el.appendChild(thumb); el.appendChild(meta);
      grid.appendChild(el);
    });
  }

  var MAX_BYTES_UI = 48 * 1024 * 1024;
  var ALLOW_UI = /\\.(jpg|jpeg|png|webp|gif|mp4|webm|mov)$/i;

  function uploadFile(file) {
    if (!ALLOW_UI.test(file.name)) {
      return Promise.reject(new Error('"' + file.name + '" is not a supported type (jpg, jpeg, png, webp, gif, mp4, webm, mov)'));
    }
    if (file.size > MAX_BYTES_UI) {
      return Promise.reject(new Error('"' + file.name + '" is too large (' + fmtBytes(file.size) + ', max 48 MB)'));
    }
    var fd = new FormData();
    fd.append('file', file, file.name);
    statusEl.textContent = 'Uploading ' + file.name + ' …';
    return req('/api/upload', { method: 'POST', body: fd }).then(function (r) {
      return r.json();
    }).then(function (saved) {
      statusEl.textContent = 'Saved ' + saved.file + ' (' + fmtBytes(saved.size) + ')';
    });
  }

  function uploadFiles(files) {
    if (!files || !files.length) return;
    var problems = [];
    var chain = Promise.resolve();
    for (var i = 0; i < files.length; i++) {
      (function (f) {
        chain = chain.then(function () {
          return uploadFile(f).then(null, function (e) { problems.push((e && e.message) || 'unknown error'); });
        });
      })(files[i]);
    }
    chain.then(function () { return loadAll(); })
      .then(function () { if (problems.length) statusEl.textContent = 'Finished with errors — ' + problems.join('; '); })
      .catch(function (e) {
        if (e && e.auth) showLogin();
        else statusEl.textContent = 'Upload failed — ' + ((e && e.message) || 'try again.');
      });
  }

  drop.addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () { uploadFiles(fileInput.files); fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); drop.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); drop.classList.remove('drag'); });
  });
  drop.addEventListener('drop', function (e) { uploadFiles(e.dataTransfer.files); });

  // ---------- menu: section form (add / edit) ----------
  function openSecForm(sec) {
    editingSecId = sec ? sec.id : null;
    secSlug.value = sec ? sec.slug : '';
    secTitle.value = sec ? sec.title : '';
    secBlurb.value = sec ? sec.blurb : '';
    secLogoUrl = sec ? sec.img : '';
    secLogoStatus.textContent = '';
    updateSecLogoPreview();
    secSave.textContent = sec ? 'Save section' : 'Add section';
    secSave.classList.toggle('secondary', !sec);
    secCancel.hidden = !sec;
    secErr.textContent = '';
    secForm.hidden = false;
    secForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function closeSecForm() { editingSecId = null; secLogoUrl = ''; secForm.hidden = true; }
  addSecBtn.addEventListener('click', function () { openSecForm(null); });
  secCancel.addEventListener('click', closeSecForm);
  secSave.addEventListener('click', function () {
    var payload = {
      slug: secSlug.value.trim(),
      title: secTitle.value.trim(),
      blurb: secBlurb.value.trim(),
      img: secLogoUrl
    };
    if (!payload.slug || !payload.title) { secErr.textContent = 'Slug and title are required.'; return; }
    var url = editingSecId ? '/api/admin/menu/sections/' + editingSecId : '/api/admin/menu/sections';
    req(url, { method: editingSecId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function () { closeSecForm(); statusEl.textContent = editingSecId ? 'Section saved.' : 'Section added.'; loadAll(); })
      .catch(function (e) { secErr.textContent = e.message || 'Save failed.'; });
  });

  // ---------- menu: rendering ----------
  function buildItemForm(secId) {
    var box = document.createElement('div');
    box.className = 'mini-form';
    box.innerHTML = '<div class="grid2">' +
      '<div><label>Name</label><input type="text" data-it="name" placeholder="e.g. Chicken Mo:Mo" /></div>' +
      '<div><label>Price</label><input type="text" data-it="price" placeholder="Rs 495  or  S 480 · L 550" /></div>' +
      '<div><label>Note (second line, optional)</label><input type="text" data-it="note" placeholder="e.g. Steam 130 · Fry 160 · Sandheko 260" /></div>' +
      '<div><label>Tags (comma separated)</label><input type="text" data-it="tags" placeholder="Spicy, Popular" /></div>' +
      '<div class="full"><label class="check"><input type="checkbox" data-it="matrix" /> Matrix row — note carries the prices, no separate price column</label></div>' +
      '</div>' +
      '<div class="form-row"><button data-act="save" class="mini">Add item</button><button data-act="cancel" class="ghost">Cancel</button></div>' +
      '<div class="err" data-it="err"></div>';
    var name = box.querySelector('[data-it=name]');
    var price = box.querySelector('[data-it=price]');
    var note = box.querySelector('[data-it=note]');
    var tags = box.querySelector('[data-it=tags]');
    var matrix = box.querySelector('[data-it=matrix]');
    var err = box.querySelector('[data-it=err]');
    box.querySelector('[data-act=cancel]').addEventListener('click', function () { renderMenu(); });
    box.querySelector('[data-act=save]').addEventListener('click', function () {
      var payload = {
        section_id: secId,
        name: name.value.trim(),
        price: price.value.trim(),
        note: note.value.trim(),
        tags: tags.value.split(',').map(function (t) { return t.trim(); }).filter(Boolean),
        matrix: matrix.checked
      };
      if (!payload.name) { err.textContent = 'Name is required.'; return; }
      var editId = Number(box.getAttribute('data-edit-id'));
      var url = editId ? '/api/admin/menu/items/' + editId : '/api/admin/menu/items';
      req(url, { method: editId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        .then(function () { statusEl.textContent = editId ? 'Item saved.' : 'Item added.'; loadAll(); })
        .catch(function (e) { err.textContent = e.message || 'Save failed.'; });
    });
    return { box: box, name: name, price: price, note: note, tags: tags, matrix: matrix };
  }

  function renderMenu() {
    secList.innerHTML = '';
    secEmpty.hidden = menuData.length > 0;
    menuData.forEach(function (sec) {
      var wrap = document.createElement('div');
      wrap.className = 'sec';

      var head = document.createElement('div');
      head.className = 'sec-head';
      var tt = document.createElement('div');
      tt.className = 'sec-title';
      tt.textContent = sec.title;
      var slug = document.createElement('span');
      slug.className = 'muted'; slug.textContent = sec.slug;
      tt.appendChild(slug);
      var actions = document.createElement('div');
      actions.className = 'sec-actions';

      var addItem = document.createElement('button');
      addItem.className = 'ghost add-item'; addItem.textContent = '+ Item';
      var editSec = document.createElement('button');
      editSec.className = 'ghost'; editSec.textContent = 'Edit';
      editSec.style.color = 'var(--gold)'; editSec.style.borderColor = 'var(--gold)';
      var delSec = document.createElement('button');
      delSec.className = 'ghost'; delSec.textContent = 'Delete';

      var blurb = document.createElement('div');
      blurb.className = 'sec-blurb';
      blurb.textContent = (sec.blurb ? sec.blurb : '') + (sec.img ? (sec.blurb ? '  ·  ' : '') + sec.img : '');

      var itemsBox = document.createElement('div');
      itemsBox.className = 'sec-items';

      addItem.addEventListener('click', function () {
        var f = buildItemForm(sec.id);
        if (itemsBox.firstChild) { itemsBox.insertBefore(f.box, itemsBox.firstChild); }
        else { itemsBox.appendChild(f.box); }
        f.box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      editSec.addEventListener('click', function () { openSecForm(sec); });
      delSec.addEventListener('click', function () {
        if (!confirm('Delete section "' + sec.title + '" and ALL its items?')) return;
        req('/api/admin/menu/sections/' + sec.id, { method: 'DELETE' })
          .then(function () { closeSecForm(); statusEl.textContent = 'Section deleted.'; loadAll(); })
          .catch(function (e) { statusEl.textContent = e.message || 'Delete failed.'; });
      });

      actions.appendChild(addItem); actions.appendChild(editSec); actions.appendChild(delSec);
      head.appendChild(tt); head.appendChild(actions);
      wrap.appendChild(head); wrap.appendChild(blurb); wrap.appendChild(itemsBox);

      sec.items.forEach(function (it) {
        var row = document.createElement('div');
        row.className = 'row-item';
        var txt = document.createElement('div');
        txt.className = 'txt';
        var nm = document.createElement('span');
        nm.className = 'nm'; nm.textContent = it.name;
        (it.tags || []).forEach(function (t) {
          var tag = document.createElement('span');
          tag.className = 'tag'; tag.textContent = t;
          nm.appendChild(tag);
        });
        txt.appendChild(nm);
        if (it.note) { var nt = document.createElement('span'); nt.className = 'nt'; nt.textContent = it.note; txt.appendChild(nt); }
        row.appendChild(txt);
        var price = document.createElement('span');
        if (it.price) { price.className = 'pt'; price.textContent = it.price; row.appendChild(price); }
        var act = document.createElement('div');
        act.className = 'sec-actions';
        var editItem = document.createElement('button');
        editItem.className = 'ghost'; editItem.textContent = 'Edit';
        editItem.style.color = 'var(--gold)'; editItem.style.borderColor = 'var(--gold)';
        var delItem = document.createElement('button');
        delItem.className = 'ghost'; delItem.textContent = 'Delete';
        editItem.addEventListener('click', function () {
          var f = buildItemForm(sec.id);
          f.box.setAttribute('data-edit-id', it.id);
          f.box.querySelector('[data-act=save]').textContent = 'Save item';
          f.name.value = it.name;
          f.price.value = it.price || '';
          f.note.value = it.note || '';
          f.tags.value = (it.tags || []).join(', ');
          f.matrix.checked = !!it.matrix;
          if (itemsBox.firstChild) { itemsBox.insertBefore(f.box, itemsBox.firstChild); }
          else { itemsBox.appendChild(f.box); }
          f.box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
        delItem.addEventListener('click', function () {
          if (!confirm('Delete "' + it.name + '"?')) return;
          req('/api/admin/menu/items/' + it.id, { method: 'DELETE' })
            .then(function () { statusEl.textContent = 'Item deleted.'; loadAll(); })
            .catch(function (e) { statusEl.textContent = e.message || 'Delete failed.'; });
        });
        act.appendChild(editItem); act.appendChild(delItem);
        row.appendChild(act);
        itemsBox.appendChild(row);
      });

      secList.appendChild(wrap);
    });
  }

  loadAll();
})();
</script>
</body>
</html>`;

