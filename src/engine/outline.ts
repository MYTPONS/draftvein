import type { Store } from '../db/index.ts';
import type { Llm } from '../llm/client.ts';
import type { Book } from './book.ts';
import { getPlan, savePlan, setPlanStatus, listChapters, listCharacters, upsertCharacter, volumeIdForIndex } from './book.ts';
import { buildContext, parseBeats } from './context.ts';
import { arcPrompt, castPrompt, planPrompt } from './prompts.ts';
import { dueThreads, overdueThreads } from './ledger.ts';
import { pacingAdviceFor } from './pacing.ts';
import { structureAdvice } from './structure.ts';
import { expectationReport } from './expectations.ts';
import { ensureVoiceProfile } from './voice.ts';

export interface PlanResult {
  idx: number;
  title: string;
  goal: string;
  beats: any[];
  created: boolean;
}

/** 保证当前章有章节计划；只规划一章，永不成批生成 */
export async function ensurePlan(
  store: Store,
  llm: Llm,
  book: Book,
  chapterIdx: number,
  opts: { signal?: AbortSignal; force?: boolean; onEvent?: (m: string, d?: any) => void } = {},
): Promise<PlanResult> {
  book = await ensureVoiceProfile(store, llm, book, {
    signal: opts.signal,
    onEvent: (message) => opts.onEvent?.(message),
  });
  const exist = getPlan(store, book.id, chapterIdx);
  if (exist && !opts.force) {
    return { idx: exist.idx, title: exist.title, goal: exist.goal, beats: parseBeats(exist.beats), created: false };
  }

  await ensureArc(store, llm, book, chapterIdx, opts);
  await ensureCast(store, llm, book, opts);

  const ctx = buildContext(store, book, chapterIdx, undefined, { recapChapters: 6 });
  const overdue = overdueThreads(store, book.id, chapterIdx);
  if (overdue.length && opts.onEvent) {
    opts.onEvent(`本章有 ${overdue.length} 条过期线索必须处理：${overdue.map((t) => t.code).join('、')}`);
  }

  const pacing: any = { ...pacingAdviceFor(store, book.id, chapterIdx), structure: structureAdvice(store, book.id, chapterIdx) };
  const exp = expectationReport(store, book.id, chapterIdx);
  if (exp.overdueList.length) {
    pacing.note = `${pacing.note}；另有 ${exp.overdueList.length} 条期待逾期未兑现：${exp.overdueList.map((e) => e.title).join('、')}`;
    opts.onEvent?.(`期待逾期：${exp.overdueList.map((e) => e.code).join('、')}`);
  }
  if (pacing.dryStreak >= 2 || pacing.golden) opts.onEvent?.(`节奏：${pacing.note}${pacing.golden ? '｜' + pacing.golden : ''}`);
  const usedTitles = [
    ...store.all<{ title: string }>('SELECT title FROM chapters WHERE book_id=?', book.id).map((r) => r.title),
    ...store.all<{ title: string }>('SELECT title FROM chapter_plans WHERE book_id=?', book.id).map((r) => r.title),
  ].filter(Boolean);
  const norm = (t: string) => String(t).replace(/[\s第章节·、，。]/g, '');
  const taken = new Set(usedTitles.map(norm));
  const prefixes = new Set(usedTitles.map((t) => norm(t).slice(0, 2)).filter((x) => x.length === 2));
  const clashes = (t: string) => taken.has(norm(t)) || prefixes.has(norm(t).slice(0, 2));

  let data = await llm.json<any>(planPrompt({ ctx, chapterIdx, previousEnding: ctx.tail, pacing, usedTitles }), {
    purpose: `plan.chapter.${chapterIdx}`,
    system: '你是长篇连载的章节策划。只输出 JSON，不要解释。',
    mockKind: 'plan',
    mockSeed: `${book.slug}:${chapterIdx}`,
    signal: opts.signal,
  });

  // 标题撞了就地重来一次（明确告诉它哪些不能用）
  if (data?.title && clashes(String(data.title))) {
    opts.onEvent?.(`标题「${data.title}」重复，重出一个`);
    try {
      data = await llm.json<any>(
        planPrompt({ ctx, chapterIdx, previousEnding: ctx.tail, pacing, usedTitles }) +
          `\n\n注意：上一版标题「${data.title}」已经用过，必须换一个完全不同的意象，不要只改一两个字。`,
        {
          purpose: `plan.chapter.${chapterIdx}.retry`,
          system: '你是长篇连载的章节策划。只输出 JSON，不要解释。',
          mockKind: 'plan',
          mockSeed: `${book.slug}:${chapterIdx}:retry`,
          signal: opts.signal,
        },
      );
    } catch (err) {
      opts.onEvent?.(`重出标题失败，沿用原题：${(err as Error).message}`);
    }
  }

  const beats = Array.isArray(data.beats) ? data.beats : [];
  if (!beats.length) throw new Error(`第 ${chapterIdx} 章规划没有产出节拍`);
  const known = new Set(listCharacters(store, book.id).map((c) => c.name));
  const castFromBeats = beats.flatMap((b: any) => b.present || []).filter(Boolean);
  const declared = Array.isArray(data.characters) ? data.characters : [];
  const cast = [...new Set([...declared, ...castFromBeats])].filter((n: string) => known.has(n));
  const unknown = [...new Set([...declared, ...castFromBeats])].filter((n: string) => !known.has(n));
  if (unknown.length) opts.onEvent?.(`规划里出现了未登记人物：${unknown.join('、')}（已忽略，请先在人物页建卡）`);

  const plan = savePlan(store, book.id, chapterIdx, {
    title: String(data.title || '').slice(0, 20) || `第${chapterIdx}章`,
    goal: String(data.goal || ''),
    beats,
    cast,
    highlights: Array.isArray(data.highlights) ? data.highlights : [],
    synopsis: Array.isArray(data.synopsis) ? data.synopsis.join('') : String(data.synopsis || ''),
    musts: (Array.isArray(data.musts) ? data.musts : [])
      .flatMap((x: any) => String(x).split(/[，。；、,;]/))
      .map((x: string) => x.trim())
      .filter((x: string) => x.length >= 2 && x.length <= 24)
      .slice(0, 6),
    pov: String(data.pov || ''),
    word_target: Math.min(Math.round(book.target_words * 1.2), Math.max(Math.round(book.target_words * 0.8), Number(data.word_target) || book.target_words)),
    volume_id: volumeIdForIndex(store, book.id, chapterIdx),
  });
  if (data.hook) opts.onEvent?.(`本章钩子：${String(data.hook).slice(0, 40)}`);

  // 规划里声明要埋的线索先建档；已存在的线索不改窗口（窗口由正文证据推进）
  const { upsertThread } = await import('./ledger.ts');
  for (const t of data.threads_new || []) {
    if (!t?.code) continue;
    const exist = store.get<{ id: number }>('SELECT id FROM threads WHERE book_id=? AND code=?', book.id, String(t.code));
    if (exist) continue;
    upsertThread(store, book.id, {
      code: String(t.code),
      title: String(t.title || t.code),
      detail: String(t.detail || ''),
      kind: 'setup',
      due_from: Number(t.due_from) || chapterIdx + 3,
      due_to: Number(t.due_to) || chapterIdx + 12,
      note: 'plan',
    });
  }

  setPlanStatus(store, book.id, chapterIdx, 'planned');
  opts.onEvent?.(`第 ${chapterIdx} 章计划就绪：${plan.title}（${beats.length} 个节拍）`, { plan: plan.title });
  return { idx: chapterIdx, title: plan.title, goal: plan.goal, beats, created: true };
}

/** 第一次动笔先立人物卡；没有人物卡就没有名字可用 */
export async function ensureCast(store: Store, llm: Llm, book: Book, opts: { signal?: AbortSignal; onEvent?: (m: string, d?: any) => void } = {}) {
  const exist = listCharacters(store, book.id);
  if (exist.length) return exist;
  const data = await llm.json<any>(castPrompt({ title: book.title, genre: book.genre, premise: book.premise, audience: book.audience }), {
    purpose: 'cast.bootstrap',
    system: '你是网文策划，只输出 JSON。',
    mockKind: 'cast',
    mockSeed: `${book.slug}:cast`,
    signal: opts.signal,
  });
  const created = [];
  for (const c of data.characters || []) {
    if (!c?.name) continue;
    created.push(
      upsertCharacter(store, book.id, {
        name: String(c.name),
        role: String(c.role || 'support'),
        identity: String(c.identity || ''),
        personality: String(c.personality || ''),
        goal: String(c.goal || ''),
        fear: String(c.fear || ''),
        speech: String(c.speech || ''),
        catchphrase: String(c.catchphrase || ''),
        taboo: String(c.taboo || ''),
        importance: Number(c.importance) || 3,
      }),
    );
  }
  if (created.length) opts.onEvent?.(`自动建立人物卡：${created.map((c) => c.name).join('、')}`);
  return created;
}

/** 只保证"当前章所在卷"存在；卷不够长时追加一卷，不预生成全书 */
export async function ensureArc(
  store: Store,
  llm: Llm,
  book: Book,
  chapterIdx: number,
  opts: { signal?: AbortSignal; onEvent?: (m: string, d?: any) => void } = {},
) {
  const arc = store.get(
    'SELECT * FROM arcs WHERE book_id=? AND start_chapter<=? AND end_chapter>=? ORDER BY idx DESC LIMIT 1',
    book.id,
    chapterIdx,
    chapterIdx,
  );
  if (arc) return arc;

  const lastArc = store.get<{ idx: number; end_chapter: number }>(
    'SELECT idx, end_chapter FROM arcs WHERE book_id=? ORDER BY idx DESC LIMIT 1',
    book.id,
  );
  const start = (lastArc?.end_chapter ?? 0) + 1;
  const data = await llm.json<any>(
    arcPrompt({
      title: book.title,
      genre: book.genre,
      premise: book.premise,
      audience: book.audience,
      currentChapter: chapterIdx,
    }),
    {
      purpose: `outline.arc.${(lastArc?.idx ?? 0) + 1}`,
      system: '你是长篇连载的结构策划。只输出 JSON。',
      mockKind: 'arc',
      mockSeed: `${book.slug}:arc:${(lastArc?.idx ?? 0) + 1}`,
      signal: opts.signal,
    },
  );
  const span = Math.max(6, Math.min(30, Number(data.chapter_span) || 12));
  store.run(
    'INSERT INTO arcs (book_id, idx, title, premise, start_chapter, end_chapter, status) VALUES (?,?,?,?,?,?,?)',
    book.id,
    (lastArc?.idx ?? 0) + 1,
    String(data.title || `第${(lastArc?.idx ?? 0) + 1}卷`),
    String(data.premise || ''),
    start,
    start + span - 1,
    'planned',
  );
  opts.onEvent?.(`新增卷：${data.title}（第 ${start}-${start + span - 1} 章）`);
  return store.get('SELECT * FROM arcs WHERE book_id=? AND idx=?', book.id, (lastArc?.idx ?? 0) + 1);
}

/** 当前窗口内（下一章及 lookahead）预规划，防止"写到哪算哪" */
export async function ensureWindow(
  store: Store,
  llm: Llm,
  book: Book,
  fromIdx: number,
  lookahead: number,
  opts: { signal?: AbortSignal; onEvent?: (m: string, d?: any) => void } = {},
) {
  const out: PlanResult[] = [];
  for (let i = 0; i < lookahead; i++) {
    out.push(await ensurePlan(store, llm, book, fromIdx + i, opts));
  }
  return out;
}

export function outlineView(store: Store, bookId: number) {
  return {
    arcs: store.all('SELECT * FROM arcs WHERE book_id=? ORDER BY idx', bookId),
    plans: store.all('SELECT * FROM chapter_plans WHERE book_id=? ORDER BY idx', bookId),
    chapters: listChapters(store, bookId).map((c) => ({ idx: c.idx, title: c.title, words: c.word_count, status: c.status })),
  };
}
