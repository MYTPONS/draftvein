-- draftvein schema
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  genre         TEXT NOT NULL DEFAULT '',
  premise       TEXT NOT NULL DEFAULT '',
  audience      TEXT NOT NULL DEFAULT '',
  style_id      TEXT NOT NULL DEFAULT 'default',
  target_words  INTEGER NOT NULL DEFAULT 2600,
  data          TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 设定集：世界 / 人物 / 势力 / 地点 / 物品 / 规则
CREATE TABLE IF NOT EXISTS bible (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT '背景设定',
  name        TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '',
  importance  INTEGER NOT NULL DEFAULT 2,
  locked      INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bible_book ON bible(book_id, kind);

-- 卷（= arcs）：分卷再分章。start/end 只是默认范围，章节可显式指定 volume_id
-- 大纲文档：总纲 / 章纲 / 自定义纲（可无限加）
CREATE TABLE IF NOT EXISTS outline_docs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'custom',   -- master|chapter|custom
  name       TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  sort       INTEGER NOT NULL DEFAULT 100,
  updated_at TEXT NOT NULL,
  UNIQUE(book_id, name)
);

-- 角色分类（默认：主要角色 / 次要角色，可加）
CREATE TABLE IF NOT EXISTS character_categories (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  sort    INTEGER NOT NULL DEFAULT 100,
  UNIQUE(book_id, name)
);

-- 设定分类（默认：背景设定 / 其他设定，可加）
CREATE TABLE IF NOT EXISTS bible_categories (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  sort    INTEGER NOT NULL DEFAULT 100,
  UNIQUE(book_id, name)
);

-- 人物卡：长篇连载最容易崩的东西。名字/说话方式/禁忌都要有据可查
CREATE TABLE IF NOT EXISTS characters (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id      INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  aliases      TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL DEFAULT 'support',   -- protagonist/support/antagonist/extra
  category     TEXT NOT NULL DEFAULT '主要角色',   -- 角色分类（主要角色/次要角色/自定义）
  identity     TEXT NOT NULL DEFAULT '',
  appearance   TEXT NOT NULL DEFAULT '',
  personality  TEXT NOT NULL DEFAULT '',
  goal         TEXT NOT NULL DEFAULT '',
  fear         TEXT NOT NULL DEFAULT '',
  speech       TEXT NOT NULL DEFAULT '',          -- 说话方式
  catchphrase  TEXT NOT NULL DEFAULT '',          -- 口头禅
  taboo        TEXT NOT NULL DEFAULT '',          -- 禁忌/雷点
  relations    TEXT NOT NULL DEFAULT '[]',        -- [{"name":"","relation":""}]
  status       TEXT NOT NULL DEFAULT 'alive',     -- alive/dead/missing
  first_idx    INTEGER,
  last_idx     INTEGER,
  mentions     INTEGER NOT NULL DEFAULT 0,
  importance   INTEGER NOT NULL DEFAULT 3,
  notes        TEXT NOT NULL DEFAULT '',
  updated_at   TEXT NOT NULL,
  UNIQUE(book_id, name)
);
CREATE INDEX IF NOT EXISTS idx_characters_book ON characters(book_id, importance DESC);

-- 故事结构阶段（三幕 / 起点连载 / 英雄之旅…），按全书百分比切
CREATE TABLE IF NOT EXISTS structure_stages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id   INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  sort      INTEGER NOT NULL DEFAULT 0,
  name      TEXT NOT NULL,
  start_pct REAL NOT NULL DEFAULT 0,
  end_pct   REAL NOT NULL DEFAULT 100,
  goal      TEXT NOT NULL DEFAULT ''
);

-- 期待-兑现台账：读者先被勾住（羞辱/立旗/约定/威胁/悬念），后给兑现（打脸/收获/反转）
CREATE TABLE IF NOT EXISTS expectations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id      INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  code         TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT '悬念',
  title        TEXT NOT NULL,
  detail       TEXT NOT NULL DEFAULT '',
  strength     INTEGER NOT NULL DEFAULT 3,
  planted_idx  INTEGER,
  plant_quote  TEXT NOT NULL DEFAULT '',
  due_from     INTEGER,
  due_to       INTEGER,
  fulfilled_idx INTEGER,
  fulfill_quote TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open',
  note         TEXT NOT NULL DEFAULT '',
  updated_at   TEXT NOT NULL,
  UNIQUE(book_id, code)
);

-- 爆点/爽点台账：hook=章末钩子，beat=中段爽点，climax=卷级高潮
CREATE TABLE IF NOT EXISTS highlights (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chapter_idx INTEGER NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'beat',       -- hook|beat|climax
  type        TEXT NOT NULL DEFAULT '爽感',       -- 打脸/反转/揭秘/突破/危机/情感/智斗/收获
  intensity   INTEGER NOT NULL DEFAULT 3,         -- 1-5
  title       TEXT NOT NULL DEFAULT '',
  quote       TEXT NOT NULL DEFAULT '',
  setup_note  TEXT NOT NULL DEFAULT '',
  pays_code   TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_highlights_book ON highlights(book_id, chapter_idx);

-- 人物关系：当前值 + 变更历史（每章可追加一条，天然是历史）
CREATE TABLE IF NOT EXISTS relations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  from_name   TEXT NOT NULL,
  to_name     TEXT NOT NULL,
  relation    TEXT NOT NULL,
  chapter_idx INTEGER,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relations_book ON relations(book_id, from_name);

-- 卷：只有宏观意图，不预生成全本书的章节标题
CREATE TABLE IF NOT EXISTS arcs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id        INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  idx            INTEGER NOT NULL,
  title          TEXT NOT NULL,
  premise        TEXT NOT NULL DEFAULT '',
  start_chapter  INTEGER NOT NULL,
  end_chapter    INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'planned',
  UNIQUE(book_id, idx)
);

-- 滚动章节计划：只保持"已写 + LOOKAHEAD"的窗口，窗口外不生成
CREATE TABLE IF NOT EXISTS chapter_plans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id      INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL,
  arc_id       INTEGER,
  volume_id    INTEGER,
  title        TEXT NOT NULL DEFAULT '',
  goal         TEXT NOT NULL DEFAULT '',
  beats        TEXT NOT NULL DEFAULT '[]',
  cast         TEXT NOT NULL DEFAULT '[]',
  highlights   TEXT NOT NULL DEFAULT '[]',
  synopsis     TEXT NOT NULL DEFAULT '',
  musts        TEXT NOT NULL DEFAULT '[]',
  pov          TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'planned',
  word_target  INTEGER,
  created_at   TEXT NOT NULL,
  UNIQUE(book_id, idx)
);

CREATE TABLE IF NOT EXISTS chapters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  plan_id     INTEGER,
  volume_id   INTEGER,
  title       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  summary     TEXT NOT NULL DEFAULT '',
  word_count  INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'draft',
  revision    INTEGER NOT NULL DEFAULT 0,
  checks      TEXT NOT NULL DEFAULT '{}',
  cost        TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(book_id, idx)
);

-- 伏笔台账：每条线索有埋入章、到期窗口、实际回收章
CREATE TABLE IF NOT EXISTS threads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id       INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  title         TEXT NOT NULL,
  detail        TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL DEFAULT 'setup',
  planted_idx   INTEGER,
  plant_quote   TEXT NOT NULL DEFAULT '',
  due_from      INTEGER,
  due_to        INTEGER,
  resolved_idx  INTEGER,
  resolve_quote TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'open',
  priority      INTEGER NOT NULL DEFAULT 2,
  note          TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL,
  UNIQUE(book_id, code)
);
CREATE INDEX IF NOT EXISTS idx_threads_book_status ON threads(book_id, status, due_to);

-- 世界硬事实：谁死了 / 谁不知道什么 / 时间线
CREATE TABLE IF NOT EXISTS facts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'fact',
  visibility TEXT NOT NULL DEFAULT 'reader',
  subject    TEXT NOT NULL DEFAULT '',
  fact       TEXT NOT NULL,
  quote      TEXT NOT NULL DEFAULT '',
  tags       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_book ON facts(book_id, idx);

CREATE TABLE IF NOT EXISTS timeline (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  scene      TEXT NOT NULL DEFAULT '',
  story_time TEXT NOT NULL DEFAULT '',
  location   TEXT NOT NULL DEFAULT '',
  actors     TEXT NOT NULL DEFAULT '',
  event      TEXT NOT NULL
);

-- 拆书模板：从参考小说里拆出来的"写法指纹"
CREATE TABLE IF NOT EXISTS writing_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  genre       TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT '',
  chapters    INTEGER NOT NULL DEFAULT 0,
  avg_words   INTEGER NOT NULL DEFAULT 0,
  dialogue    REAL NOT NULL DEFAULT 0,
  para_avg    REAL NOT NULL DEFAULT 0,
  hook_dist   TEXT NOT NULL DEFAULT '{}',
  opening_dist TEXT NOT NULL DEFAULT '{}',
  top_names   TEXT NOT NULL DEFAULT '[]',
  beat_rhythm TEXT NOT NULL DEFAULT '',
  samples     TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  UNIQUE(name)
);

-- 章节版本历史（每次落库存一份快照，可回退）
CREATE TABLE IF NOT EXISTS chapter_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chapter_idx INTEGER NOT NULL,
  revision   INTEGER NOT NULL DEFAULT 1,
  title      TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL DEFAULT '',
  word_count INTEGER NOT NULL DEFAULT 0,
  checks     TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS chapters_fts USING fts5(content, book_id UNINDEXED, idx UNINDEXED);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running',
  detail      TEXT NOT NULL DEFAULT '',
  started_at  TEXT NOT NULL,
  ended_at    TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     INTEGER,
  book_id    INTEGER,
  level      TEXT NOT NULL DEFAULT 'info',
  stage      TEXT NOT NULL DEFAULT '',
  message    TEXT NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_book ON events(book_id, id);

CREATE TABLE IF NOT EXISTS llm_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER,
  book_id       INTEGER,
  purpose       TEXT NOT NULL DEFAULT '',
  provider      TEXT NOT NULL DEFAULT '',
  model         TEXT NOT NULL DEFAULT '',
  prompt_chars  INTEGER NOT NULL DEFAULT 0,
  output_chars  INTEGER NOT NULL DEFAULT 0,
  ms            INTEGER NOT NULL DEFAULT 0,
  ok            INTEGER NOT NULL DEFAULT 1,
  error         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pushes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id           INTEGER NOT NULL,
  chapter_idx       INTEGER NOT NULL,
  platform          TEXT NOT NULL DEFAULT 'zuojia',
  remote_book_id    TEXT NOT NULL DEFAULT '',
  remote_volume_id  TEXT NOT NULL DEFAULT '',
  remote_chapter_id TEXT NOT NULL DEFAULT '',
  action            TEXT NOT NULL DEFAULT 'draft',
  status            TEXT NOT NULL DEFAULT 'ok',
  response          TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL
);
