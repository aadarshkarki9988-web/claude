// Royal Inn gallery backend — Cloudflare Worker (JS, zero dependencies).
// NO-CARD stack: files live in Supabase Storage (free plan), metadata in D1 (free plan).
//
// Routes:
//   GET    /api/gallery                public media list as URL strings (cached 60s)
//   POST   /api/login                  verify admin password -> HMSAFE session cookie
//   POST   /api/upload                 multipart upload (auth required)
//   GET    /api/admin/media            admin list with ids (auth required)
//   DELETE /api/admin/media/:id        delete item (auth required)
//   GET    /media/<key>                redirect to the public Supabase object URL (video Range via their CDN)
//   GET    /admin                      admin page (served from this Worker)
//   GET    /                           redirect -> /admin
//
// Deploy: npx wrangler deploy   (see BACKEND-SETUP.md / WORKLOG)

const API_PREFIX = '/media/';

const ALLOW = /\.(jpg|jpeg|png|webp|gif|mp4|webm|mov)$/i;
const MAX_BYTES = 48 * 1024 * 1024; // Supabase free plan caps uploads at 50 MB; keep margin

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
  return { 'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY };
}

async function supabasePut(env, key, buf, mime) {
  const headers = storageHeaders(env);
  headers['Content-Type'] = mime;
  const res = await fetch(storageBase(env) + '/' + key, { method: 'POST', headers, body: buf });
  if (!res.ok) throw new Error('Supabase upload failed with status ' + res.status);
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
  if (!ALLOW.test(name)) return json({ error: 'unsupported type' }, { status: 415 });
  const ext = getExt(name);
  const mime = file.type || EXT_TYPE[ext] || 'application/octet-stream';
  const size = file.size;
  if (size > MAX_BYTES) return json({ error: 'too large (max 85 MB)' }, { status: 413 });
  const buf = new Uint8Array(await file.arrayBuffer());
  const key = Date.now() + '-' + name.replace(/[^\w.\-]+/g, '_');
  await supabasePut(env, key, buf, mime);
  const kind = mime.startsWith('video/') ? 'video' : 'image';
  await env.DB.prepare('INSERT INTO media (file_key, kind, mime, size) VALUES (?, ?, ?, ?)')
    .bind(key, kind, mime, size).run();
  return json({ file: name, key, url: API_PREFIX + key, size, kind });
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
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }
    if (path === '/' && method === 'GET') return Response.redirect(url.origin + '/admin', 302);
    if ((path === '/admin' || path === '/admin.html') && method === 'GET') {
      return new Response(ADMIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (path === '/api/gallery' && method === 'GET') return listGallery(env, url.origin);
    if (path === '/api/login' && method === 'POST') return login(request, env);
    if (path === '/api/upload' && method === 'POST') return upload(request, env);
    if (path === '/api/admin/media' && method === 'GET') return adminList(request, env);

    const del = /^\/api\/admin\/media\/(\d+)$/.exec(path);
    if (del && method === 'DELETE') return adminDelete(request, env, del[1]);

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
<title>Royal Inn — Gallery Admin</title>
<style>
  :root { --bg:#0e0d0b; --panel:#171512; --line:#2b261f; --gold:#b08d57; --text:#e9e3d8; --muted:#9c9388; --danger:#c0503f; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:Georgia, 'Times New Roman', serif; }
  .wrap { max-width:900px; margin:0 auto; padding:32px 20px 80px; }
  h1 { font-weight:500; letter-spacing:.5px; font-size:26px; }
  h1 small { display:block; color:var(--muted); font-size:13px; letter-spacing:2px; margin-top:4px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:22px; margin-top:22px; }
  label { display:block; color:var(--muted); font-size:12px; letter-spacing:1.5px; text-transform:uppercase; margin-bottom:8px; }
  input[type=password] { width:100%; padding:12px 14px; border:1px solid var(--line); border-radius:8px; background:#201d1a; color:var(--text); font-size:15px; }
  input[type=password]:focus { outline:none; border-color:var(--gold); }
  button { cursor:pointer; border:none; border-radius:8px; padding:12px 20px; font-size:14px; background:var(--gold); color:#17130d; font-weight:700; letter-spacing:.5px; }
  button.ghost { background:transparent; color:var(--danger); border:1px solid var(--danger); padding:6px 10px; font-size:12px; font-weight:500; }
  .err { color:var(--danger); font-size:13px; min-height:18px; margin-top:10px; }
  .drop { border:2px dashed var(--line); border-radius:10px; padding:40px 20px; text-align:center; color:var(--muted); transition:.15s; }
  .drop.drag { border-color:var(--gold); color:var(--gold); background:#1d1a16; }
  .drop b { color:var(--text); }
  .status { margin-top:14px; font-size:13px; color:var(--muted); white-space:pre-line; }
  .badge { display:inline-block; font-size:11px; letter-spacing:1px; padding:3px 8px; border-radius:20px; border:1px solid var(--line); color:var(--muted); }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:14px; margin-top:16px; }
  .item { border:1px solid var(--line); border-radius:10px; overflow:hidden; background:#12100d; }
  .item .thumb { aspect-ratio:4/3; background:#000; display:block; }
  .item .thumb img, .item .thumb video { width:100%; height:100%; object-fit:cover; display:block; }
  .item .meta { padding:10px 12px; font-size:12px; color:var(--muted); }
  .item .meta .name { color:var(--text); word-break:break-all; }
  .item .row { display:flex; justify-content:space-between; align-items:center; margin-top:8px; }
  .muted { color:var(--muted); }
  [hidden] { display:none !important; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Royal Inn <small>Gallery Admin — add photos &amp; videos</small></h1>

  <section class="card" id="loginCard">
    <label for="pwd">Password</label>
    <input type="password" id="pwd" placeholder="Enter admin password" autocomplete="current-password" />
    <div style="margin-top:14px"><button id="loginBtn">Log in</button></div>
    <div class="err" id="loginErr"></div>
  </section>

  <section class="card" id="panel" hidden>
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
      if (!r.ok) throw { status: r.status };
      return r;
    });
  }

  function showLogin() { loginCard.hidden = false; panel.hidden = true; }
  function showPanel() { loginCard.hidden = true; panel.hidden = false; }

  loginBtn.addEventListener('click', function () {
    var pwd = pwdInput.value;
    if (!pwd) return;
    loginErr.textContent = '';
    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd })
    }).then(function (r) {
      if (r.ok) { pwdInput.value = ''; load(); }
      else { loginErr.textContent = 'Wrong password.'; }
    }).catch(function () { loginErr.textContent = 'Login failed — try again.'; });
  });
  pwdInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') loginBtn.click(); });

  function load() {
    return req('/api/admin/media').then(function (r) { return r.json(); }).then(function (items) {
      render(items || []);
      showPanel();
    }).catch(function (e) { if (e.auth) showLogin(); });
  }

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
          load();
        }).catch(function () { statusEl.textContent = 'Delete failed.'; });
      });
      row.appendChild(del);
      meta.appendChild(name); meta.appendChild(sub); meta.appendChild(row);
      el.appendChild(thumb); el.appendChild(meta);
      grid.appendChild(el);
    });
  }

  function uploadFile(file) {
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
    var chain = Promise.resolve();
    for (var i = 0; i < files.length; i++) {
      (function (f) { chain = chain.then(function () { return uploadFile(f); }); })(files[i]);
    }
    chain.then(load).catch(function () { statusEl.textContent = 'Upload failed — file too large or invalid type.'; });
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

  load();
})();
</script>
</body>
</html>`;