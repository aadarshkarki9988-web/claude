// One-time backfill: uploads the existing photos/videos from assets\gallery
// into Supabase Storage and registers them in D1, so the admin panel starts
// with the current medium.
//
// Prereqs:
//   1. Worker deployed (npx wrangler deploy)
//   2. D1 schema applied (npx wrangler d1 execute royalinn-gallery-db --remote --file schema.sql)
//   3. Supabase project + public "gallery" bucket + service_role key (see BACKEND-SETUP.md)
//
// Env vars:
//   SUPABASE_URL            e.g. https://xxxx.supabase.co   (no trailing slash)
//   SUPABASE_SERVICE_KEY    the service_role key
//   SUPABASE_BUCKET         optional, default "gallery"
//
// Usage:  node seed.mjs
import { readdirSync, statSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve('..'); // repo root (seed.mjs lives in backend/)
const GALLERY_DIR = join(ROOT, 'assets', 'gallery');
const DB = 'royalinn-gallery-db';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || 'gallery';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY first. Example:');
  console.error('  $env:SUPABASE_URL="https://xxxx.supabase.co"');
  console.error('  $env:SUPABASE_SERVICE_KEY="eyJ..."  ');
  console.error('  node seed.mjs');
  process.exit(1);
}

const ALLOW = /\.(jpg|jpeg|png|webp|gif|mp4|webm|mov)$/i;
const EXT_TYPE = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime'
};

function npx(args) {
  // Directly spawning .cmd (npx.cmd) throws EINVAL on Windows/Node 20+;
  // go through cmd.exe instead.
  if (process.platform === 'win32') {
    execFileSync('cmd.exe', ['/c', 'npx'].concat(args), { stdio: 'inherit' });
  } else {
    execFileSync('npx', args, { stdio: 'inherit' });
  }
}

async function upload(url, key, data, contentType) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + SERVICE_KEY,
      // Newer sb_secret_ keys are rejected with 401 "No API key found in request"
      // unless they are also sent as apikey; legacy service_role JWTs ignore it.
      'apikey': SERVICE_KEY,
      'Content-Type': contentType,
      'x-upsert': 'true'
    },
    body: data
  });
  if (!res.ok) {
    const detail = await res.text().catch(function () { return ''; });
    console.error('  upload failed (' + res.status + ' ' + res.statusText + '): ' + key);
    console.error('  -> ' + detail.slice(0, 300));
    if (res.status === 401) {
      console.error('  -> Key rejected. Copy the CURRENT secret key from Supabase (Project Settings -> API).');
    }
    if (res.status === 400) {
      console.error('  -> Check SUPABASE_URL / that bucket "' + BUCKET + '" exists.');
    }
    process.exit(1);
  }
}

const files = readdirSync(GALLERY_DIR)
  .filter((f) => ALLOW.test(f))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

if (!files.length) {
  console.log('No media found in ' + GALLERY_DIR);
  process.exit(0);
}

console.log('Found ' + files.length + ' media file(s) to seed.\n');
console.log('Target: ' + SUPABASE_URL + '/storage/v1/object/public/' + BUCKET);

// 1) Upload each file to Supabase Storage.
for (const f of files) {
  const ext = f.slice(f.lastIndexOf('.')).toLowerCase();
  const ct = EXT_TYPE[ext] || 'application/octet-stream';
  process.stdout.write('[upload] ' + f + ' (' + ct + ') … ');
  await upload(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + f, f, readFileSync(join(GALLERY_DIR, f)), ct);
  console.log('ok');
}

// 2) Insert rows into D1 with real byte sizes.
const rows = files.map((f) => {
  const ext = f.slice(f.lastIndexOf('.')).toLowerCase();
  const mime = EXT_TYPE[ext] || 'application/octet-stream';
  const kind = mime.startsWith('video/') ? 'video' : 'image';
  const size = statSync(join(GALLERY_DIR, f)).size;
  return `('${f}', '${kind}', '${mime}', ${size}, datetime('now'))`;
});
const sql = `INSERT OR IGNORE INTO media (file_key, kind, mime, size, uploaded_at) VALUES ` + rows.join(',\n') + ';';
const tmp = join(import.meta.dirname, '.seed-inserts.sql');
writeFileSync(tmp, sql, 'utf8');

try {
  console.log('\n[d1] inserting ' + files.length + ' row(s) into ' + DB);
  npx(['wrangler', 'd1', 'execute', DB, '--remote', '--file', tmp]);
} finally {
  try { unlinkSync(tmp); } catch (e) { /* already removed */ }
}

console.log('\nDone. Gallery registered ' + files.length + ' item(s).');
console.log('Admin:  http://<your-worker>.workers.dev/admin');