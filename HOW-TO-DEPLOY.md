# Royal Inn Website — Owner's Guide

Everything you need to publish and update your site **yourself**, with no code
and no subscription. Keep this file — it lives inside your website folder.

The website folder is:
`C:\Users\ACER\OneDrive\Desktop\Royalinn\royalinn-site`
Everything below refers to files inside that folder.

---

## 1. First, understand how the site works (the "backend")

**Good news: this website has no backend to maintain.**

- A "backend" normally means a server running code + a database (the thing that
  breaks, needs updates, and costs money). **Your site doesn't use one.**
- Your site is a **static site**: just files — pages (`.html`), styling
  (`styles.css`), a little bit of behaviour (`script.js`), and your
  photos/videos (in the `assets` folder). The visitor's browser simply
  downloads these files and shows them. Nothing runs on a server.
- On your computer, a tiny helper (`server.mjs`) is used **only to preview** the
  site locally at `http://localhost:4322`. You do **not** upload `server.mjs`
  anywhere — real hosting serves the files directly.

Because it's static, hosting is **free**, **fast**, and there's nothing to
patch or keep alive.

---

## 2. Publish it online (do it yourself, free)

The easiest way — no account required, works in any browser:

1. Go to **https://app.netlify.com/drop**
2. Open your file explorer to the Desktop, find the **`royalinn-site`** folder.
3. **Drag the whole `royalinn-site` folder** onto the Netlify Drop page.
4. Wait ~30 seconds. Netlify gives you a **live link** like
   `https://royal-inn-tansen.netlify.app` — that's your website, online, and it
   works on phones and for anyone you share it with.

> Tip: make a **free Netlify account** first (with your email/Google). Then your
> site stays under your account so you can manage it, keep the same link, and
> add a custom domain later. Without an account the link still works but is
> harder to update later.

Other free options that work the same way: **Cloudflare Pages**, **Vercel**,
**GitHub Pages**. Netlify Drop is the simplest.

---

## 3. Update the site later (add photos / videos / change text)

The flow is always the same: **change the files → publish again.**

### Add or replace a photo/video
1. Put your new file into the right folder inside `royalinn-site\assets\`
   (see the folder map in section 5).
2. If you're **replacing** an existing image, give the new file the **exact same
   name** as the old one — it will just swap in, no other change needed.
3. Publish again (section 4).

### Change wording (prices, hours, phone, etc.)
- Open the page file in **Notepad** (right-click → Open with → Notepad):
  - Home text: `index.html`
  - Menu items/prices: `menu\index.html`
- Find the words you want to change, type the new words, **Save**.
- Publish again.
- (Always keep a backup copy of the folder before editing, just in case.)

---

## 4. Re-publish after any change

**If you used Netlify Drop (no account):** go back to
`https://app.netlify.com/drop` and drag the `royalinn-site` folder on again —
it creates a fresh link.

**If you made a Netlify account (recommended):**
1. Open your site in the Netlify dashboard.
2. Go to the **Deploys** tab.
3. Drag the `royalinn-site` folder onto the **"drag and drop"** area there.
4. Your **same link** updates in ~30 seconds. Visitors need to do nothing.

---

## 5. Where each thing lives (folder map)

```
royalinn-site\
  index.html            <- Home page (text + which photos/videos show)
  menu\index.html       <- The full menu (items, prices, section logos)
  gallery\index.html    <- Gallery page
  styles.css            <- All the colours, fonts, spacing (design)
  script.js             <- Menu button, video play, lightbox
  assets\
    img\                <- Photos used across the site
    video\              <- Videos / reels (.mp4)
    menu\               <- The little dish photos + section logos on the menu
    gallery\            <- Gallery photos  (see section 6 — special step)
    brand\              <- The Royal Inn logo
    poster\             <- Still images shown before a video starts playing
```

---

## 6. Special step for the GALLERY page

The gallery reads a list file called **`assets\gallery\gallery.json`**.
When you **add or remove** a gallery photo, that list must be rebuilt so the new
photo appears. Two ways:

**Easiest:** double-click **`rebuild-gallery.bat`** (in the `royalinn-site`
folder). It updates the list automatically. Then publish again.
*(This needs Node.js installed — it already is on the computer we built this on.
Get it free at https://nodejs.org if you're on a new computer.)*

**Or by hand:** open `assets\gallery\gallery.json` in Notepad. It's a list like:
```
["/assets/gallery/01.jpg","/assets/gallery/02.jpg", ... ]
```
Add your new file the same way, e.g. add `,"/assets/gallery/25.jpg"` before the
closing `]`. Save, then publish.

> Photos used on the **Home** and **Menu** pages are NOT affected by this — only
> the Gallery page needs this list.

---

## 7. Custom domain (e.g. royalinn.com.np) — optional

1. Buy the domain from any registrar.
2. In your Netlify site: **Domain settings → Add a custom domain**, type your
   domain, and follow the steps (it tells you exactly what to paste at your
   registrar).
3. Netlify gives you free HTTPS (the padlock) automatically.

---

## 8. Golden rules

- **Keep a backup** of the whole `royalinn-site` folder before you edit anything.
- **Never rename** the `assets` folder or move files out of it.
- To **replace** an image, reuse the **same filename** — simplest possible update.
- The link/URL **never changes** when you re-publish (if you use a Netlify
  account) — so share it once and keep it forever.

That's it. Static site = files in, website out. You've got this. 👑
