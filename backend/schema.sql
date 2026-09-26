-- D1 schema for the Royal Inn gallery backend.
-- Run once: npx wrangler d1 execute royalinn-gallery-db --remote --file schema.sql

DROP TABLE IF EXISTS media;

CREATE TABLE media (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_key    TEXT NOT NULL UNIQUE,          -- object key in the R2 bucket (unique filename)
  kind        TEXT NOT NULL DEFAULT 'image', -- 'image' | 'video'
  mime        TEXT NOT NULL DEFAULT '',
  size        INTEGER NOT NULL DEFAULT 0,    -- bytes
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_media_uploaded_at ON media (uploaded_at);

-- Menu: sections hold a heading + optional circular logo image; items hang off them.
CREATE TABLE menu_sections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,             -- url anchor, e.g. 'specials'
  title       TEXT NOT NULL,
  blurb       TEXT NOT NULL DEFAULT '',
  img         TEXT NOT NULL DEFAULT '',         -- image url/alt path for the round logo
  sort_order  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE menu_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  section_id  INTEGER NOT NULL,
  name        TEXT NOT NULL,
  price       TEXT NOT NULL DEFAULT '',         -- rendered price string, e.g. 'Rs 495' or 'S 480 · L 550'
  note        TEXT NOT NULL DEFAULT '',         -- optional second line (descriptors / matrix prices)
  tags        TEXT NOT NULL DEFAULT '',         -- comma-separated, e.g. 'Spicy,Signature'
  matrix      INTEGER NOT NULL DEFAULT 0,       -- 1 = note-style row (no separate price column)
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_menu_items_section ON menu_items (section_id, sort_order);
CREATE INDEX idx_menu_sections_sort ON menu_sections (sort_order);