//   Stages the public website into dist/ for Netlify to publish.
//
//   Why: this repo is both the website AND the Cloudflare Worker backend. The
//   Worker source (backend/), the admin panel and the repo tooling have no
//   business being served as public web files, but Netlify has no equivalent of
//   .vercelignore — it publishes the whole publish directory. So we copy across
//   an explicit allowlist and point Netlify at the result.
//
//   Everything not listed below stays private: backend/, .claude/, the docs,
//   server.mjs (local preview only) and the deploy configs themselves.
//
//   Run:  node build-site.mjs
//   Netlify: wired up via netlify.toml ([build] publish = "dist")

import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = 'dist';

// Root-level files the site actually loads.
const FILES = ['index.html', 'script.js', 'styles.css'];

// Folders that make up the public site.
const DIRS = ['assets', 'about', 'contact', 'faq', 'gallery', 'menu'];

// Never publish these, even if someone adds them to FILES/DIRS by mistake.
const PRIVATE = ['backend', '.claude', '.git', 'node_modules', 'dist'];

function assertPublishable(name) {
  if (PRIVATE.includes(name)) throw new Error('refusing to publish private path: ' + name);
}

async function countFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  let total = 0;
  for (const e of entries) {
    total += e.isDirectory() ? await countFiles(join(dir, e.name)) : 1;
  }
  return total;
}

async function main() {
  for (const name of [...FILES, ...DIRS]) assertPublishable(name);

  const missing = [];
  for (const name of [...FILES, ...DIRS]) {
    try {
      await stat(name);
    } catch {
      missing.push(name);
    }
  }
  if (missing.length) {
    console.error('build-site: missing from the repo root: ' + missing.join(', '));
    process.exit(1);
  }

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  for (const f of FILES) await cp(f, join(OUT, f));
  for (const d of DIRS) await cp(d, join(OUT, d), { recursive: true });

  const staged = (await readdir(OUT)).sort();
  const leaked = staged.filter((n) => PRIVATE.includes(n));
  if (leaked.length) {
    console.error('build-site: private path leaked into ' + OUT + ': ' + leaked.join(', '));
    process.exit(1);
  }

  console.log('build-site: staged ' + staged.length + ' entries -> ' + OUT + '/');
  console.log('  ' + staged.join('  '));
  console.log('  ' + (await countFiles(OUT)) + ' files total');
}

main().catch((e) => {
  console.error('build-site failed: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
