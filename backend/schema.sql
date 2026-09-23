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