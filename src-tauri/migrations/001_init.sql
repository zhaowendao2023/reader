-- v1: initial schema. Items are the single entity table; progress hangs off
-- items by id. Search is intentionally not a table yet (LIKE is enough at
-- this scale); an FTS table can be added later as its own migration.

CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL
);

CREATE TABLE items (
    id          TEXT PRIMARY KEY,             -- sha256(path_key)
    kind        TEXT NOT NULL,                -- comic|video|image|pack|group|favorite
    media_type  TEXT,                         -- pack subtype: video|image|media
    name        TEXT NOT NULL,                -- full file/dir name
    ext         TEXT,                         -- cbz/zip/epub/mobi or video/image
    path_key    TEXT NOT NULL UNIQUE,         -- platform-normalized path
    parent_path TEXT,                         -- path_key of the parent container
    folder      TEXT,                         -- favorite root display name
    size        INTEGER,                      -- file size in bytes
    mtime       INTEGER,                      -- last modified timestamp (ms)
    missing     INTEGER NOT NULL DEFAULT 0,   -- 1 = not found by the last scan
    extra       TEXT NOT NULL DEFAULT '{}',   -- JSON aggregates (counts, ...)
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    CHECK (kind IN ('comic', 'video', 'image', 'pack', 'group', 'favorite')),
    CHECK (media_type IS NULL OR media_type IN ('video', 'image', 'media'))
);

CREATE INDEX idx_items_parent ON items(parent_path);
CREATE INDEX idx_items_kind ON items(kind);

CREATE TABLE progress (
    item_id    TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,                 -- comic|video|image
    page       INTEGER,                       -- comic page number
    position   REAL,                          -- video seconds / image index
    updated_at INTEGER NOT NULL,
    CHECK (kind IN ('comic', 'video', 'image'))
);
