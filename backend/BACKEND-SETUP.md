# Royal Inn Gallery Backend — Setup Guide (NO-CARD version)

Stack: **Cloudflare Worker + D1 (SQLite)** for the API/metadata/admin and
**Supabase Storage** (free plan) for the photo/video files.

**No credit card needed anywhere.** Everything is free forever (usage-capped).

| Part | Provider | Free allowance | Cost |
|---|---|---|---|
| API + login + admin page | Cloudflare Worker | 100k requests/day | $0 |
| Metadata database | Cloudflare D1 | 5 GB, 5M reads/day | $0 |
| Photo/video files | Supabase Storage | 1 GB, 50 MB/file, 5 GB egress/mo | $0 |

At your sizes (photos ~0.7 MB, reels ~8 MB) that's ~100+ reels of storage —
years at 1–2 uploads/month.

---

## 1. Software you need (already installed)

- **Node.js** (v18+) — you have it.
- **git** — you have it.

No database server, no `npm install`.

---

## 2. One-time setup (mostly from `backend/`)

### A. Cloudflare part (terminal, in `backend/`)
```bash
# 1) log in to Cloudflare (opens a browser)
npx wrangler login

# 2) create the database — the id is ALREADY pasted into wrangler.toml for you
npx wrangler d1 create royalinn-gallery-db

# 3) apply the database table
npx wrangler d1 execute royalinn-gallery-db --remote --file schema.sql
```
`schema.sql` is **re-runnable** — it creates the media tables **and the menu
tables** (`menu_sections`, `menu_items`). If you already ran it before the menu
feature existed, just run the command again (adds/recreates the menu tables;
existing gallery data is untouched).

### B. Supabase part (browser — FREE, no card)
1. Go to **supabase.com** → **Start your project** → sign up (email) or log in.
2. **New project** → pick a name (e.g. `royalinn-gallery`), choose a password,
   pick a region (nearest to you), click **Create project**.
   Wait ~1 minute for it to build.
3. In the left sidebar click **Storage** → **New bucket** →
   - Name: `gallery`
   - **Public bucket: ON**
   - Max file size: leave default (or set max 50000 = 50 MB)
   - → Create bucket
4. Click **Project Settings** (gear icon, bottom-left) → **API**.
   Copy these two values (they stay secret — only you use them):
   - **Project URL** — looks like `https://abcdefgh.supabase.co`
   - **service_role / secret key** — long JWT string.
     (Tip: the `service_role` key is hidden by default at the bottom; use
     **Reveal** / it may need re-generating.)

### C. Back to the terminal (`backend/`)
```bash
# 4) put your project URL into wrangler.toml
#    open wrangler.toml, find  SUPABASE_URL = "https://..."  and paste yours
#    (no trailing slash)

# 5) admin password — decide it, then produce the hash
node hash-password.mjs yourAdminPassword     # prints one long line -> copy it
npx wrangler secret put ADMIN_PASSWORD_HASH   # paste that long line, Enter

# 6) session secret — any long random text
npx wrangler secret put SESSION_SECRET

# 7) Supabase service key — paste from step B.4
npx wrangler secret put SUPABASE_SERVICE_KEY

# 8) deploy the backend
npx wrangler deploy
```
The last line shows your Worker URL, e.g. `https://royalinn-gallery.<sub>.workers.dev` — copy it.

### D. Backfill your existing photos (one time, `backend/`)
```powershell
$env:SUPABASE_URL = "https://abcdefgh.supabase.co"   # your project URL
$env:SUPABASE_SERVICE_KEY = "eyJ..."                 # your service_role key
node seed.mjs
```
You should see all 24 files upload then 24 rows inserted.

---

## 3. Point the website at the backend

In three files replace the API placeholder with your Worker URL from step C.8:
- `gallery/index.html`
- `index.html`
- `menu/index.html`

```js
var API = 'https://royalinn-gallery.<your-subdomain>.workers.dev';
```

The gallery and menu pages keep a fallback chain (Worker → static files), so
local `node server.mjs` preview still works untouched.

Then **re-publish the site to Netlify** as usual.

---

## 4. Daily use (no developer needed)

1. Open `https://<your-worker-url>/admin` and log in.
2. **Gallery tab** — drag photos/videos into the drop zone (multiple; each file
   up to **50 MB**). They appear on the Gallery page within seconds. Delete from
   the admin panel any time.
3. **Menu tab** — full menu editor:
   - **+ Add menu section** creates a heading (e.g. "Soup"). Slug = the page
     anchor, title, blurb, and an optional round logo image — **drag & drop**
     it into the box (or click to browse); it uploads automatically.
   - Inside each section: **+ Item** adds a dish (name, price, optional note,
     tags like `Spicy,Popular`, and a **Matrix** tick for rows where the note
     carries the prices instead of a separate price column, e.g. Mo:Mo).
   - **Edit / Delete** on every section and item. Saving updates the public
     Menu page within ~5 minutes (backend caches it for 5 min).

No `gallery.json`, no `rebuild-gallery.bat`, no editing HTML, no Claude round-trip.

---

## 5. Limits to keep in mind

- **50 MB / file** — your photos (~1 MB) and reels (~8 MB) are far below this.
  If a phone video is larger, compress it first (the site already prefers
  compressed reels). Menu section logos upload at max **5 MB** (images only) and
  live in the same **`gallery` bucket under a `logos/` prefix** — they never
  appear in the Gallery because they aren't registered in the `media` table.
- **1 GB storage** — ~100+ reels. Delete old items from the admin panel to free space.
- **5 GB egress / month** — fine for a small-site gallery; heavy video traffic is
  the only thing that could approach it.
- **Supabase pauses after ~1 week of no use** — it wakes automatically on the
  next visit (adds a second or two). Nothing is deleted.

---

## 6. Files in `backend/`

```
schema.sql            D1 table definitions (gallery media + menu)
wrangler.toml         Worker config + D1 binding + SUPABASE vars
worker/index.js       The backend API + embedded admin page (single deployable)
admin.html            Source copy of the admin page (for readability)
hash-password.mjs     Tool: node hash-password.mjs <password>
seed.mjs              Tool: node seed.mjs   (backfill existing media to Supabase + D1)
BACKEND-SETUP.md      This guide
```

## 7. Housekeeping

- **Change password later:** re-run `node hash-password.mjs <newPassword>` →
  `npx wrangler secret put ADMIN_PASSWORD_HASH` (no redeploy needed after a secret).
- **Redeploy after code changes:** `npx wrangler deploy`.
- **Secrets are never in git** (they live in Cloudflare secrets / your Supabase
  dashboard only).
- All medium is also still in your git repo (`assets/gallery/`) — the backend is
  the live copy, the repo is your backup.
- When you ever have a card and want 10× more storage + free video bandwidth,
  the R2 upgrade is a small code change (same Worker, different storage layer).