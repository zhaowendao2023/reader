-- v4: tag kind — tags are naturally heterogeneous (author / series /
-- character / genre). A shared vocabulary with a kind lets the tag page
-- group them. Empty string = unclassified (frontend may auto-suggest).
ALTER TABLE tags ADD COLUMN kind TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_tags_kind ON tags(kind);