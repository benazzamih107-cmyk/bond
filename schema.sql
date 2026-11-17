-- الفصول المحفوظة (file_ids: مصفوفة JSON من {"b": رقم البوت, "f": file_id})
CREATE TABLE IF NOT EXISTS chapters (
  manga_name     TEXT    NOT NULL COLLATE NOCASE,
  chapter_number TEXT    NOT NULL,
  source         TEXT    NOT NULL,
  file_ids       TEXT    NOT NULL,
  created_at     INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  PRIMARY KEY (manga_name, chapter_number)
);

CREATE INDEX IF NOT EXISTS idx_chapters_source ON chapters (source);

-- حالة السحب: صف واحد فقط (id = 1)
CREATE TABLE IF NOT EXISTS crawler_status (
  id                              INTEGER PRIMARY KEY CHECK (id = 1),
  current_source_index            INTEGER NOT NULL DEFAULT 0,
  last_chapter_scraped_per_source TEXT    NOT NULL DEFAULT '{}',
  bot_index                       INTEGER NOT NULL DEFAULT 0,
  updated_at                      INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

INSERT OR IGNORE INTO crawler_status (id) VALUES (1);
