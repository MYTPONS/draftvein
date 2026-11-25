/**
 * 书籍 / 章节 / 人物 / 关系 / 设定 / 大纲 / 分类 / 卷 的数据访问层。
 * 所有表都以 book_id 隔离。
 */
import type { Store } from '../db/index.ts';
import { nowIso } from '../config.ts';
import { seedStructure } from './structure.ts';

export interface Book {
  id: number;
  title: string;
  slug: string;
  genre: string;
  premise: string;
  audience: string;
  style_id: string;
  target_words: number;
  data: string;
  created_at: string;
  updated_at: string;
}

export interface Chapter {
  id: number;
  book_id: number;
  idx: number;
  plan_id: number | null;
  volume_id: number | null;
  title: string;
  content: string;
  summary: string;
  word_count: number;
  status: string;
  revision: number;
  checks: string;
  cost: string;
  created_at: string;
  updated_at: string;
}

export interface ChapterPlan {
  id: number;
  book_id: number;
  idx: number;
  arc_id: number | null;
  volume_id: number | null;
  title: string;
  goal: string;
  beats: string;
  cast: string;
  highlights: string;
  synopsis: string;
  musts: string;
  pov: string;
  status: string;
  word_target: number | null;
  created_at: string;
}

export interface Character {
  id: number;
  book_id: number;
  name: string;
  aliases: string;
  role: string;
  category: string;
  identity: string;
  appearance: string;
  personality: string;
  goal: string;
  fear: string;
  speech: string;
  catchphrase: string;
  taboo: string;
  relations: string;
  status: string;
  first_idx: number | null;
  last_idx: number | null;
  mentions: number;
  importance: number;
  notes: string;
  updated_at: string;
}

export interface Relation {
  id: number;
  book_id: number;
  from_name: string;
  to_name: string;
  relation: string;
  chapter_idx: number | null;
  note: string;
  created_at: string;
}

export interface Fact {
  id: number;
  book_id: number;
  idx: number;
  kind: string;
  visibility: string;
  subject: string;
  fact: string;
  quote: string;
  tags: string;
  created_at: string;
}

export interface TimelineRow {
  id: number;
  book_id: number;
  idx: number;
  scene: string;
  story_time: string;
  location: string;
  actors: string;
  event: string;
}

export interface OutlineDoc {
  id: number;
  book_id: number;
  kind: string;
  name: string;
  content: string;
  sort: number;
  updated_at: string;
}

export interface Category {
  id: number;
  book_id: number;
  name: string;
  sort: number;
}

const DEFAULT_CHAR_CATS = ['主要角色', '次要角色'];
const DEFAULT_BIBLE_CATS = ['背景设定', '其他设定'];

const CHAR_FIELDS = [
  'aliases', 'role', 'category', 'identity', 'appearance', 'personality', 'goal', 'fear',
  'speech', 'catchphrase', 'taboo', 'relations', 'status', 'first_idx', 'last_idx',
  'mentions', 'importance', 'notes',
];

function slugify(title: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20);
  const rand = Math.random().toString(36).slice(2, 6);
  return `book-${ascii || 'novel'}-${rand}`;
}

export function listBooks(store: Store): (Book & { chapters: number; words: number; openThreads: number })[] {
  return store.all<any>(
    `SELECT b.*,
       (SELECT COUNT(*) FROM chapters c WHERE c.book_id=b.id) AS chapters,
       (SELECT COALESCE(SUM(word_count),0) FROM chapters c WHERE c.book_id=b.id) AS words,
       (SELECT COUNT(*) FROM threads t WHERE t.book_id=b.id AND t.status='open') AS openThreads
     FROM books b ORDER BY b.id DESC`,
  );
}

export function getBook(store: Store, id: number): Book | undefined {
  return store.get<Book>('SELECT * FROM books WHERE id=?', id);
}

export function requireBook(store: Store, id: number): Book {
  const book = getBook(store, id);
  if (!book) throw new Error(`书不存在：${id}`);
  return book;
}
export function seedBookDefaults(store: Store, bookId: number, premise: string) {
  DEFAULT_CHAR_CATS.forEach((name, i) => {
    store.run('INSERT OR IGNORE INTO character_categories (book_id, name, sort) VALUES (?,?,?)', bookId, name, i + 1);
  });
  DEFAULT_BIBLE_CATS.forEach((name, i) => {
    store.run('INSERT OR IGNORE INTO bible_categories (book_id, name, sort) VALUES (?,?,?)', bookId, name, i + 1);
  });
  store.run(
    'INSERT OR IGNORE INTO outline_docs (book_id, kind, name, content, sort, updated_at) VALUES (?,?,?,?,?,?)',
    bookId, 'master', '总纲', premise || '', 1, nowIso(),
  );
  store.run(
    'INSERT OR IGNORE INTO outline_docs (book_id, kind, name, content, sort, updated_at) VALUES (?,?,?,?,?,?)',
    bookId, 'chapter', '章纲', '', 2, nowIso(),
  );
}

export function createBook(
  store: Store,
  input: { title: string; genre?: string; premise?: string; audience?: string; targetWords?: number },
): Book {
  const now = nowIso();
  const r = store.run(
    'INSERT INTO books (title, slug, genre, premise, audience, target_words, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    input.title,
    slugify(input.title),
    input.genre ?? '',
    input.premise ?? '',
    input.audience ?? '',
    input.targetWords ?? 2600,
    '{}',
    now,
    now,
  );
  const book = getBook(store, r.lastInsertRowid)!;
  seedBookDefaults(store, book.id, input.premise ?? '');
  try {
    seedStructure(store, book.id, 'three_act');
  } catch {
    /* 结构表未迁移时跳过 */
  }
  return book;
}

export function updateBook(
  store: Store,
  id: number,
  patch: Partial<Pick<Book, 'title' | 'genre' | 'premise' | 'audience' | 'style_id' | 'target_words' | 'data'>>,
): Book {
  const allowed = ['title', 'genre', 'premise', 'audience', 'style_id', 'target_words', 'data'];
  const sets: string[] = [];
  const vals: any[] = [];
  for (const k of allowed) {
    const v = (patch as any)[k];
    if (v !== undefined) {
      sets.push(`${k}=?`);
      vals.push(v);
    }
  }
  if (sets.length) store.run(`UPDATE books SET ${sets.join(',')}, updated_at=? WHERE id=?`, ...vals, nowIso(), id);
  return requireBook(store, id);
}

// ── 人物卡 ─────────────────────────────────────────────
export function listCharacters(store: Store, bookId: number): Character[] {
  return store.all<Character>('SELECT * FROM characters WHERE book_id=? ORDER BY importance DESC, id', bookId);
}

export function upsertCharacter(store: Store, bookId: number, input: Partial<Character> & { name: string }): Character {
  const exist = store.get<Character>('SELECT * FROM characters WHERE book_id=? AND name=?', bookId, input.name);
  const now = nowIso();
  if (exist) {
    const sets: string[] = [];
    const vals: any[] = [];
    for (const f of CHAR_FIELDS) {
      const v = (input as any)[f];
      if (v !== undefined) {
        sets.push(`${f}=?`);
        vals.push(v);
      }
    }
    sets.push('updated_at=?');
    vals.push(now);
    store.run(`UPDATE characters SET ${sets.join(',')} WHERE id=?`, ...vals, exist.id);
    return store.get<Character>('SELECT * FROM characters WHERE id=?', exist.id)!;
  }
  const r = store.run(
    `INSERT INTO characters (book_id, name, aliases, role, category, identity, appearance, personality, goal, fear, speech, catchphrase, taboo, relations, status, first_idx, last_idx, mentions, importance, notes, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    bookId,
    input.name,
    input.aliases ?? '',
    input.role ?? 'support',
    input.category ?? '主要角色',
    input.identity ?? '',
    input.appearance ?? '',
    input.personality ?? '',
    input.goal ?? '',
    input.fear ?? '',
    input.speech ?? '',
    input.catchphrase ?? '',
    input.taboo ?? '',
    input.relations ?? '[]',
    input.status ?? 'alive',
    input.first_idx ?? null,
    input.last_idx ?? null,
    input.mentions ?? 0,
    input.importance ?? 3,
    input.notes ?? '',
    now,
  );
  return store.get<Character>('SELECT * FROM characters WHERE id=?', r.lastInsertRowid)!;
}

export function touchCharacters(store: Store, bookId: number, chapterIdx: number, names: string[]) {
  const seen = new Set<string>();
  for (const raw of names || []) {
    const name = String(raw || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const c = store.get<Character>('SELECT * FROM characters WHERE book_id=? AND name=?', bookId, name);
    if (!c) continue;
    store.run(
      'UPDATE characters SET first_idx=COALESCE(first_idx,?), last_idx=?, mentions=mentions+1, updated_at=? WHERE id=?',
      chapterIdx, chapterIdx, nowIso(), c.id,
    );
  }
}

const STOP_NAMES = new Set([
  '有人', '他', '她', '我', '你', '大家', '两人', '三人', '那人', '这人', '众人', '对方', '自己',
  '外头', '楼上', '隔壁', '远处', '桌上', '屋里', '门外', '地下', '门口', '里面', '外面', '上头',
  '声音', '时候', '什么', '怎么', '为什么', '忽然', '然后', '接着', '于是', '如果', '但是',
  '因为', '所以', '只是', '已经', '还是', '就是', '不是', '没有', '可以', '应该', '知道',
  '明白', '看见', '听见', '回过', '低声', '轻声', '沉声', '冷声', '笑着', '一面', '一边',
  '老人', '男人', '女人', '少年', '姑娘', '掌柜', '伙计', '警探', '法医', '医生', '警察',
]);

export function suspectNames(store: Store, bookId: number, text: string): string[] {
  const chars = listCharacters(store, bookId);
  const known = new Set<string>();
  for (const c of chars) {
    known.add(c.name);
    for (const a of String(c.aliases || '').split(/[、,，\s]+/)) if (a) known.add(a);
  }
  const counts = new Map<string, number>();
  const re = /([\u4e00-\u9fa5]{2,3})(?=说|道|问|答|喊|笑|叹|低声|沉声|冷声|轻声)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const n = m[1];
    if (known.has(n) || STOP_NAMES.has(n)) continue;
    if (/[有是在的了着过]/.test(n)) continue;
    if (/^(了|的|着|一|他|她|我|你|这|那|不|没|就|都|也|还|又|再)/.test(n)) continue;
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  return [...counts.entries()].filter(([, c]) => c >= 2).map(([n]) => n);
}

/** 正文里已反复出现、但人物页漏登的名字：先补一张“待完善”的次要人物卡，避免下一章继续失忆。 */
export function ensureSuspectCharacters(store: Store, bookId: number, names: string[]): string[] {
  const added: string[] = [];
  for (const raw of names || []) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const exist = store.get<{ id: number }>('SELECT id FROM characters WHERE book_id=? AND name=?', bookId, name);
    if (exist) continue;
    upsertCharacter(store, bookId, {
      name,
      role: 'support',
      category: '次要角色',
      importance: 2,
      notes: '正文自动补卡，待完善身份、性格和说话方式',
    });
    added.push(name);
  }
  return added;
}

export function repairStoredSuspectCharacters(store: Store, bookId: number): string[] {
  const names = new Set<string>();
  for (const ch of store.all<{ checks: string }>('SELECT checks FROM chapters WHERE book_id=?', bookId)) {
    try {
      const checks = JSON.parse(ch.checks || '{}');
      for (const name of checks.suspects || []) if (name) names.add(String(name));
      for (const issue of checks.review?.issues || []) {
        const raw = `${issue.message || ''} ${issue.why || ''}`;
        const m = raw.match(/([\u4e00-\u9fa5]{2,3})是人物卡外/);
        if (m) names.add(m[1]);
      }
    } catch {
      /* 旧 checks 损坏就跳过，不影响正文 */
    }
  }
  return ensureSuspectCharacters(store, bookId, [...names]);
}

export function aliasConflicts(store: Store, bookId: number): { alias: string; owner: string; name: string }[] {
  const chars = listCharacters(store, bookId);
  const out: { alias: string; owner: string; name: string }[] = [];
  const aliasOwner = new Map<string, string>();
  for (const c of chars) {
    const list = String(c.aliases || '').split(/[、,，\s]+/).filter(Boolean);
    for (const a of list) {
      const owner = aliasOwner.get(a);
      if (owner && owner !== c.name) out.push({ alias: a, owner, name: c.name });
      else aliasOwner.set(a, c.name);
      const other = chars.find((x) => x.name === a && x.name !== c.name);
      if (other) out.push({ alias: a, owner: other.name, name: c.name });
    }
  }
  return out;
}

// ── 关系 ───────────────────────────────────────────────
export function listRelations(store: Store, bookId: number): Relation[] {
  return store.all<Relation>('SELECT * FROM relations WHERE book_id=? ORDER BY id DESC', bookId);
}

export function currentRelations(store: Store, bookId: number): Relation[] {
  const rows = listRelations(store, bookId);
  const seen = new Set<string>();
  const out: Relation[] = [];
  for (const r of rows) {
    const k = `${r.from_name}->${r.to_name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

export function addRelation(
  store: Store,
  bookId: number,
  input: { from_name: string; to_name: string; relation: string; chapter_idx?: number | null; note?: string },
): Relation {
  const r = store.run(
    'INSERT INTO relations (book_id, from_name, to_name, relation, chapter_idx, note, created_at) VALUES (?,?,?,?,?,?,?)',
    bookId, input.from_name, input.to_name, input.relation, input.chapter_idx ?? null, input.note ?? '', nowIso(),
  );
  const row = store.get<Relation>('SELECT * FROM relations WHERE id=?', r.lastInsertRowid)!;
  const c = store.get<Character>('SELECT * FROM characters WHERE book_id=? AND name=?', bookId, input.from_name);
  if (c) {
    let list: { name: string; relation: string }[] = [];
    try {
      list = JSON.parse(c.relations || '[]');
    } catch {
      list = [];
    }
    list = list.filter((x) => x.name !== input.to_name);
    list.push({ name: input.to_name, relation: input.relation });
    store.run('UPDATE characters SET relations=?, updated_at=? WHERE id=?', JSON.stringify(list), nowIso(), c.id);
  }
  return row;
}

// ── 章节 ───────────────────────────────────────────────
export function listChapters(store: Store, bookId: number): Chapter[] {
  return store.all<Chapter>('SELECT * FROM chapters WHERE book_id=? ORDER BY idx', bookId);
}

export function getChapter(store: Store, bookId: number, idx: number): Chapter | undefined {
  return store.get<Chapter>('SELECT * FROM chapters WHERE book_id=? AND idx=?', bookId, idx);
}

export function nextChapterIdx(store: Store, bookId: number): number {
  const row = store.get<{ m: number | null }>('SELECT MAX(idx) m FROM chapters WHERE book_id=?', bookId);
  return (row?.m ?? 0) + 1;
}

export function saveChapter(
  store: Store,
  bookId: number,
  idx: number,
  data: { title: string; content: string; summary?: string; status?: string; checks?: any; cost?: any; revision?: number; volume_id?: number | null },
): Chapter {
  const now = nowIso();
  const exist = getChapter(store, bookId, idx);
  if (exist) {
    if (exist.content && exist.content !== data.content) {
      store.run(
        'INSERT INTO chapter_versions (book_id, chapter_idx, revision, title, content, word_count, checks, created_at) VALUES (?,?,?,?,?,?,?,?)',
        bookId, idx, exist.revision || 1, exist.title, exist.content, exist.word_count, exist.checks, now,
      );
    }
    let checks = '{}';
    if (data.checks !== undefined) checks = JSON.stringify(data.checks);
    else checks = exist.checks || '{}';
    store.run(
      'UPDATE chapters SET title=?, content=?, summary=?, word_count=?, status=?, revision=?, checks=?, cost=?, volume_id=COALESCE(?,volume_id), updated_at=? WHERE id=?',
      data.title, data.content, data.summary ?? exist.summary, data.content.length,
      data.status ?? exist.status, data.revision ?? (exist.revision || 0) + 1,
      checks, JSON.stringify(data.cost ?? {}), data.volume_id ?? null, now, exist.id,
    );
  } else {
    store.run(
      'INSERT INTO chapters (book_id, idx, plan_id, volume_id, title, content, summary, word_count, status, revision, checks, cost, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      bookId, idx, data.status === 'planned' ? null : (getPlan(store, bookId, idx)?.id ?? null),
      data.volume_id ?? null, data.title, data.content, data.summary ?? '', data.content.length,
      data.status ?? 'draft', data.revision ?? 1, JSON.stringify(data.checks ?? {}), JSON.stringify(data.cost ?? {}), now, now,
    );
  }
  try {
    store.run('DELETE FROM chapters_fts WHERE book_id=? AND idx=?', bookId, idx);
    store.run('INSERT INTO chapters_fts (content, book_id, idx) VALUES (?,?,?)', data.content, bookId, idx);
  } catch {
    /* FTS 不可用 */
  }
  return getChapter(store, bookId, idx)!;
}

// ── 章节计划 ────────────────────────────────────────────
export function getPlan(store: Store, bookId: number, idx: number): ChapterPlan | undefined {
  return store.get<ChapterPlan>('SELECT * FROM chapter_plans WHERE book_id=? AND idx=?', bookId, idx);
}

export function listPlans(store: Store, bookId: number): ChapterPlan[] {
  return store.all<ChapterPlan>('SELECT * FROM chapter_plans WHERE book_id=? ORDER BY idx', bookId);
}

export function savePlan(
  store: Store,
  bookId: number,
  idx: number,
  plan: {
    title: string;
    goal: string;
    beats: any[];
    cast?: string[];
    highlights?: any[];
    synopsis?: string;
    musts?: string[];
    pov?: string;
    word_target?: number;
    volume_id?: number | null;
  },
): ChapterPlan {
  const exist = getPlan(store, bookId, idx);
  const cast = JSON.stringify(plan.cast ?? []);
  if (exist) {
    store.run(
      'UPDATE chapter_plans SET title=?, goal=?, beats=?, cast=?, highlights=?, synopsis=COALESCE(?,synopsis), musts=COALESCE(?,musts), pov=?, word_target=?, volume_id=COALESCE(?,volume_id) WHERE id=?',
      plan.title,
      plan.goal,
      JSON.stringify(plan.beats ?? []),
      cast,
      JSON.stringify(plan.highlights ?? []),
      plan.synopsis ?? null,
      plan.musts ? JSON.stringify(plan.musts) : null,
      plan.pov ?? '',
      plan.word_target ?? null,
      plan.volume_id ?? null,
      exist.id,
    );
  } else {
    store.run(
      'INSERT INTO chapter_plans (book_id, idx, volume_id, title, goal, beats, cast, highlights, synopsis, musts, pov, status, word_target, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      bookId,
      idx,
      plan.volume_id ?? null,
      plan.title,
      plan.goal,
      JSON.stringify(plan.beats ?? []),
      cast,
      JSON.stringify(plan.highlights ?? []),
      plan.synopsis ?? '',
      JSON.stringify(plan.musts ?? []),
      plan.pov ?? '',
      'planned',
      plan.word_target ?? null,
      nowIso(),
    );
  }
  return getPlan(store, bookId, idx)!;
}

export function setPlanStatus(store: Store, bookId: number, idx: number, status: string) {
  store.run('UPDATE chapter_plans SET status=? WHERE book_id=? AND idx=?', status, bookId, idx);
}

// ── 事实 / 时间线 ───────────────────────────────────────
export function addFacts(
  store: Store,
  bookId: number,
  idx: number,
  rows: { kind?: string; visibility?: string; subject?: string; fact: string; quote?: string; tags?: string }[],
) {
  for (const r of rows || []) {
    if (!r || !r.fact) continue;
    store.run(
      'INSERT INTO facts (book_id, idx, kind, visibility, subject, fact, quote, tags, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      bookId,
      idx,
      r.kind ?? 'fact',
      r.visibility === 'author' ? 'author' : 'reader',
      r.subject ?? '',
      r.fact,
      r.quote ?? '',
      r.tags ?? '',
      nowIso(),
    );
  }
}

export function listFacts(store: Store, bookId: number, limit = 200): Fact[] {
  return store.all<Fact>('SELECT * FROM facts WHERE book_id=? ORDER BY idx DESC, id DESC LIMIT ?', bookId, limit);
}

export function addTimeline(
  store: Store,
  bookId: number,
  idx: number,
  rows: { scene?: string; story_time?: string; location?: string; actors?: string; event: string }[],
) {
  for (const r of rows || []) {
    if (!r || !r.event) continue;
    store.run(
      'INSERT INTO timeline (book_id, idx, scene, story_time, location, actors, event) VALUES (?,?,?,?,?,?,?)',
      bookId,
      idx,
      r.scene ?? '',
      r.story_time ?? '',
      r.location ?? '',
      r.actors ?? '',
      r.event,
    );
  }
}

export function listTimeline(store: Store, bookId: number): TimelineRow[] {
  return store.all<TimelineRow>('SELECT * FROM timeline WHERE book_id=? ORDER BY idx, id', bookId);
}

// ── 大纲文档 ───────────────────────────────────────────
export function listOutlineDocs(store: Store, bookId: number): OutlineDoc[] {
  return store.all<OutlineDoc>('SELECT * FROM outline_docs WHERE book_id=? ORDER BY sort, id', bookId);
}

export function upsertOutlineDoc(
  store: Store,
  bookId: number,
  input: { id?: number; kind?: string; name: string; content?: string; sort?: number },
): OutlineDoc {
  if (input.id) {
    store.run(
      'UPDATE outline_docs SET name=?, content=COALESCE(?,content), kind=COALESCE(?,kind), sort=COALESCE(?,sort), updated_at=? WHERE id=? AND book_id=?',
      input.name,
      input.content ?? null,
      input.kind ?? null,
      input.sort ?? null,
      nowIso(),
      input.id,
      bookId,
    );
    return store.get<OutlineDoc>('SELECT * FROM outline_docs WHERE id=?', input.id)!;
  }
  const r = store.run(
    'INSERT INTO outline_docs (book_id, kind, name, content, sort, updated_at) VALUES (?,?,?,?,?,?)',
    bookId,
    input.kind ?? 'custom',
    input.name,
    input.content ?? '',
    input.sort ?? 100,
    nowIso(),
  );
  return store.get<OutlineDoc>('SELECT * FROM outline_docs WHERE id=?', r.lastInsertRowid)!;
}

export function deleteOutlineDoc(store: Store, bookId: number, id: number) {
  store.run("DELETE FROM outline_docs WHERE id=? AND book_id=? AND kind='custom'", id, bookId);
}

// ── 分类 ───────────────────────────────────────────────
const CAT_TABLES: Record<string, string> = { character: 'character_categories', bible: 'bible_categories' };

export function listCategories(store: Store, bookId: number, scope: 'character' | 'bible') {
  const t = CAT_TABLES[scope];
  return store.all<{ id: number; name: string; sort: number }>(`SELECT * FROM ${t} WHERE book_id=? ORDER BY sort, id`, bookId);
}

export function addCategory(store: Store, bookId: number, scope: 'character' | 'bible', name: string) {
  const t = CAT_TABLES[scope];
  const max = store.get<{ m: number }>(`SELECT COALESCE(MAX(sort),0) m FROM ${t} WHERE book_id=?`, bookId)!;
  store.run(`INSERT OR IGNORE INTO ${t} (book_id, name, sort) VALUES (?,?,?)`, bookId, name, max.m + 1);
  return listCategories(store, bookId, scope);
}

export function removeCategory(store: Store, bookId: number, scope: 'character' | 'bible', name: string) {
  const t = CAT_TABLES[scope];
  store.run(`DELETE FROM ${t} WHERE book_id=? AND name=?`, bookId, name);
  return listCategories(store, bookId, scope);
}

// ── 卷 ────────────────────────────────────────────────
export interface Volume {
  id: number;
  book_id: number;
  idx: number;
  title: string;
  premise: string;
  start_chapter: number;
  end_chapter: number;
  status: string;
}

export function listVolumes(store: Store, bookId: number): Volume[] {
  return store.all<Volume>('SELECT * FROM arcs WHERE book_id=? ORDER BY idx', bookId);
}

export function createVolume(store: Store, bookId: number, input: { title: string; premise?: string; start?: number; end?: number }): Volume[] {
  const last = store.get<{ idx: number; end_chapter: number }>(
    'SELECT idx, end_chapter FROM arcs WHERE book_id=? ORDER BY idx DESC LIMIT 1',
    bookId,
  );
  const start = input.start ?? (last?.end_chapter ?? 0) + 1;
  const end = input.end ?? start + 19;
  store.run(
    'INSERT INTO arcs (book_id, idx, title, premise, start_chapter, end_chapter, status) VALUES (?,?,?,?,?,?,?)',
    bookId,
    (last?.idx ?? 0) + 1,
    input.title,
    input.premise ?? '',
    start,
    end,
    'planned',
  );
  return listVolumes(store, bookId);
}

export function updateVolume(
  store: Store,
  bookId: number,
  id: number,
  patch: { title?: string; premise?: string; start_chapter?: number; end_chapter?: number; realign?: boolean },
): Volume[] {
  if (patch.realign) {
    store.run('UPDATE chapters SET volume_id=NULL WHERE book_id=?', bookId);
    store.run('UPDATE chapter_plans SET volume_id=NULL WHERE book_id=?', bookId);
  }
  store.run(
    'UPDATE arcs SET title=COALESCE(?,title), premise=COALESCE(?,premise), start_chapter=COALESCE(?,start_chapter), end_chapter=COALESCE(?,end_chapter) WHERE id=? AND book_id=?',
    patch.title ?? null,
    patch.premise ?? null,
    patch.start_chapter ?? null,
    patch.end_chapter ?? null,
    id,
    bookId,
  );
  return listVolumes(store, bookId);
}

export function volumeIdForIndex(store: Store, bookId: number, idx: number): number | null {
  const v = store.get<{ id: number }>(
    'SELECT id FROM arcs WHERE book_id=? AND start_chapter<=? AND end_chapter>=? ORDER BY idx DESC LIMIT 1',
    bookId,
    idx,
    idx,
  );
  return v ? v.id : null;
}

export function chapterTree(store: Store, bookId: number) {
  const volumes = listVolumes(store, bookId);
  const chapters = store.all<any>('SELECT * FROM chapters WHERE book_id=? ORDER BY idx', bookId);
  const plans = store.all<any>('SELECT * FROM chapter_plans WHERE book_id=? ORDER BY idx', bookId);
  const rows = new Map<number, any>();
  for (const p of plans) rows.set(p.idx, { idx: p.idx, plan: p, chapter: null });
  for (const c of chapters) {
    if (!rows.has(c.idx)) rows.set(c.idx, { idx: c.idx, plan: null, chapter: null });
    rows.get(c.idx).chapter = c;
  }
  const all = [...rows.values()].sort((a, b) => a.idx - b.idx);
  const out = volumes.map((v) => ({
    volume: v,
    items: all.filter((r) => {
      const explicit = r.chapter && r.chapter.volume_id ? r.chapter.volume_id : (r.plan ? r.plan.volume_id : null);
      const vid = explicit || volumeIdForIndex(store, bookId, r.idx);
      return vid === v.id;
    }),
  }));
  const known = new Set<number>();
  for (const o of out) for (const i of o.items) known.add(i.idx);
  return { volumes: out, unassigned: all.filter((r) => !known.has(r.idx)) };
}

// ── 章节版本 ───────────────────────────────────────────
export function listVersions(store: Store, bookId: number, idx: number) {
  return store.all<{ id: number; revision: number; title: string; word_count: number; created_at: string }>(
    'SELECT id, revision, title, word_count, created_at FROM chapter_versions WHERE book_id=? AND chapter_idx=? ORDER BY id DESC',
    bookId,
    idx,
  );
}

export function restoreVersion(store: Store, bookId: number, idx: number, versionId: number): Chapter {
  const v = store.get<{ content: string; title: string; checks: string }>(
    'SELECT content, title, checks FROM chapter_versions WHERE id=? AND book_id=? AND chapter_idx=?',
    versionId,
    bookId,
    idx,
  );
  if (!v) throw new Error('版本不存在');
  const cur = getChapter(store, bookId, idx);
  let checks: any = {};
  try {
    checks = JSON.parse(v.checks || '{}');
  } catch {
    checks = {};
  }
  return saveChapter(store, bookId, idx, {
    title: v.title,
    content: v.content,
    status: cur ? cur.status : 'draft',
    revision: (cur?.revision ?? 0) + 1,
    checks,
  });
}

// ── 人物出场时间线（计划 vs 实际） ─────────────────────
export interface CharacterTimelineRow {
  name: string;
  planned: number[];
  actual: number[];
  missing: number[];
  unexpected: number[];
  firstIdx: number | null;
  lastIdx: number | null;
  gap: number | null;
}

export function characterTimeline(store: Store, bookId: number): CharacterTimelineRow[] {
  const chars = listCharacters(store, bookId);
  const chapters = store.all<{ idx: number; content: string }>(
    'SELECT idx, content FROM chapters WHERE book_id=? ORDER BY idx',
    bookId,
  );
  const plans = store.all<{ idx: number; cast: string }>('SELECT * FROM chapter_plans WHERE book_id=? ORDER BY idx', bookId);
  const rows: CharacterTimelineRow[] = [];
  for (const c of chars) {
    const planned: number[] = [];
    for (const p of plans) {
      let cast: string[] = [];
      try {
        cast = JSON.parse(p.cast || '[]');
      } catch {
        cast = [];
      }
      if (Array.isArray(cast) && cast.includes(c.name)) planned.push(p.idx);
    }
    const actual = chapters.filter((ch) => String(ch.content || '').includes(c.name)).map((ch) => ch.idx);
    const missing = planned.filter((i) => !actual.includes(i));
    const unexpected = actual.filter((i) => !planned.includes(i));
    const last = actual.length ? actual[actual.length - 1] : null;
    const first = actual.length ? actual[0] : null;
    const gap = last !== null ? plans.length - last : null;
    rows.push({ name: c.name, planned, actual, missing, unexpected, firstIdx: first, lastIdx: last, gap });
  }
  return rows.sort((a, b) => (b.actual.length - a.actual.length) || a.name.localeCompare(b.name));
}
