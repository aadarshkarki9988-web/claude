// Minimal zero-dependency static server for the Rivet House study build.
import { createServer } from 'node:http';
import { readFile, stat, readdir } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const ROOT = process.cwd();
const PORT = process.env.PORT || 4321;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.woff2': 'font/woff2',
};

async function resolveFile(urlPath) {
  let p = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  let full = join(ROOT, p);
  try {
    const s = await stat(full);
    if (s.isDirectory()) full = join(full, 'index.html');
  } catch {
    // Clean-URL fallback: /foo -> /foo/index.html
    if (!extname(full)) {
      try { await stat(join(full, 'index.html')); full = join(full, 'index.html'); } catch {}
    }
  }
  return full;
}

const MEDIA_RE = /\.(jpg|jpeg|png|webp|gif|mp4|webm|mov)$/i;
async function walkGallery(dir, base) {
  let out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.toLowerCase() === 'readme.txt') continue;
    const rel = base + '/' + e.name;
    if (e.isDirectory()) out = out.concat(await walkGallery(join(dir, e.name), rel));
    else if (MEDIA_RE.test(e.name)) out.push(rel);
  }
  return out;
}

createServer(async (req, res) => {
  // Gallery folder listing — auto-includes whatever media is dropped in /assets/gallery/
  if (req.url.split('?')[0] === '/api/gallery') {
    const files = await walkGallery(join(ROOT, 'assets', 'gallery'), '/assets/gallery');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(files));
    return;
  }
  try {
    const full = await resolveFile(req.url === '/' ? '/index.html' : req.url);
    const body = await readFile(full);
    res.writeHead(200, { 'Content-Type': TYPES[extname(full).toLowerCase()] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>404</h1>');
  }
}).listen(PORT, () => console.log(`Rivet House study build → http://localhost:${PORT}`));
