# Royal Inn Website — Owner's Guide

Everything you need to publish and update your site **yourself**, with no code
and no subscription. Keep this file — it lives inside your website folder.

The project folder is:
`D:\RolayInn\claude`
Everything below refers to files inside that folder. It is a **Git repository
connected to GitHub**, and Netlify publishes it automatically.

---

## 1. First, understand how the site works

There are now **two separate things**, and they never touch:

**A. The website** (this folder) — a **static site**: just files — pages
(`.html`), styling (`styles.css`), a little bit of behaviour (`script.js`), and
your photos/videos (in the `assets` folder). The visitor's browser simply
downloads these files. Nothing runs on a server. This is hosted by **Netlify**.

**B. The photo/video + menu backend** (the `backend` folder) — a small program
running on **Cloudflare** that stores the photos and videos you upload and
serves the menu. It has its own admin panel. It is hosted by **Cloudflare
Workers**, *not* by Netlify.

> The `backend` folder is **never** published as website files. `build-site.mjs`
> copies across only the website parts into `dist/`, which is what Netlify
> publishes. Don't worry about this — it happens automatically on every deploy.

The website *reads* photos and the menu from the backend, but everything else
works on its own. On your computer, a tiny helper (`server.mjs`) previews the
site locally at `http://localhost:4322`.

---

## 2. Publishing online (automatic)

The site publishes itself from GitHub. You don't upload anything by hand.

1. Push your change to the `main` branch on GitHub.
2. Netlify notices and rebuilds within ~30 seconds.
3. Your **same link** updates. Visitors need to do nothing.

If you ever need to rebuild without a code change: Netlify dashboard → your
site → **Deploys** → **Trigger deploy** → **Deploy site**.

> **First-time setup only:** Netlify → **Add new site** → **Import an existing
> project** → choose this repository. Build command `node build-site.mjs` and
> publish directory `dist` are read automatically from `netlify.toml`.

---

## 3. Update the site later (add photos / videos / change text)

The flow is always the same: **change the files → push to `main`.**

### Add or replace a photo/video used by the site's own artwork
1. Put your new file into the right folder inside `assets\`
   (see the folder map in section 5).
2. If you are **replacing** an existing image, give the new file the **exact same
   name** as the old one — it will just swap in, no other change needed.
3. Push to `main`. Netlify rebuilds in ~30 seconds.

### Add photos/videos to the Gallery or Menu
Use the **admin panel** instead — see section 6. No files, no rebuild.

### Change wording (prices, hours, phone, etc.)
- Open the page file in **Notepad** (right-click → Open with → Notepad):
  - Home text: `index.html`
  - Menu items/prices: `menu\index.html`
- Find the words you want to change, type the new words, **Save**.
- Push to `main`.
- (Always keep a backup copy before editing, just in case.)

---

## 4. Re-publish after any change

Normally you don't do anything — pushing to `main` publishes automatically
(section 2).

To rebuild **without** changing any code: Netlify dashboard → your site →
**Deploys** → **Trigger deploy** → **Deploy site**.

> Drag-and-drop uploading (the old "Netlify Drop" method) is no longer used.
> It is also worth avoiding: dropping the whole project folder would publish the
> `backend` folder as public web files.


---

## 5. Where each thing lives (folder map)

```
D:\RolayInn\claude\
  index.html            <- Home page (text + which photos/videos show)
  menu\index.html       <- The full menu (items, prices, section logos)
  gallery\index.html    <- Gallery page
  about\index.html      <- About page
  contact\index.html    <- Contact page
  faq\index.html        <- FAQ page
  styles.css            <- All the colours, fonts, spacing (design)
  script.js             <- Menu button, video play, lightbox
  assets\
    img\                <- Photos used across the site
    video\              <- Videos / reels (.mp4)
    menu\               <- The little dish photos + section logos on the menu
    gallery\            <- Gallery photos  (see section 6 — adding photos)
    brand\              <- The Royal Inn logo
    poster\             <- Still images shown before a video starts playing

  backend\              <- The photo/menu backend. NEVER published to the web.
  build-site.mjs        <- Copies the website parts into dist\ for Netlify
  netlify.toml          <- Tells Netlify to publish dist\
  dist\                 <- Build output (created automatically, not in git)
```

---

## 6. Adding photos & videos to the GALLERY

Gallery photos and videos are **not** files you add to this folder any more. They
live in Cloudflare D1 + Supabase Storage and are served from the Worker, so there
is **no `gallery.json` and no `rebuild-gallery.bat`** — nothing to rebuild and no
HTML to edit.

**To add or remove a photo/video:** open the admin panel and use it.

1. Deploy the backend once (see `backend/BACKEND-SETUP.md`).
2. Open `https://<your-worker>.workers.dev/admin` and sign in.
3. Drag the file onto the drop zone (or click to browse), then **Save**.

The item appears on the Home and Gallery pages within seconds. Deleting it in the
admin panel removes it everywhere.

Limits: **48 MB per file**, types `.jpg .jpeg .png .webp .gif .mp4 .webm .mov`.

> The static `assets/gallery/` photos still exist and are used as the site's own
> artwork. They are no longer what drives the Gallery page.

---

## 7. Custom domain (e.g. royalinn.com.np) — optional

1. Buy the domain from any registrar.
2. In your Netlify site: **Domain settings → Add a custom domain**, type your
   domain, and follow the steps (it tells you exactly what to paste at your
   registrar).
3. Netlify gives you free HTTPS (the padlock) automatically.

---

## 8. Golden rules

- **Keep a backup** of the whole project folder before you edit anything.
- **Never rename** the `assets` folder or move files out of it.
- To **replace** an image, reuse the **same filename** — simplest possible update.
- The link/URL **never changes** when you re-publish (if you use a Netlify
  account) — so share it once and keep it forever.

That's it. Static site = files in, website out. You've got this. 👑
