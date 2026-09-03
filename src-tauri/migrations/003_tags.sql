-- v3: tag system. Tags are a shared vocabulary; item_tags links them to
-- items. item_id is items.id = sha256(lowercase path), which is stable across
-- rescan upserts. FKs cascade so removing a favorite subtree or deleting a tag
-- never leaves orphan links.

CREATE TABLE IF NOT EXISTS tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS item_tags (
    item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (item_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags(tag_id);
