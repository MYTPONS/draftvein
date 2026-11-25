/**
 * 伏笔台账：埋点必须留证据，回收必须从正文里抽得到原句。
 * 这是本框架和"一次性生成 300 章标题"的分水岭：
 * 台账状态由正文事实推进，而不是由计划书宣称。
 */
import type { Store } from '../db/index.ts';
import { nowIso } from '../config.ts';

export interface Thread {
  id: number;
  book_id: number;
  code: string;
  title: string;
  detail: string;
  kind: string;
  planted_idx: number | null;
  plant_quote: string;
  due_from: number | null;
  due_to: number | null;
  resolved_idx: number | null;
  resolve_quote: string;
  status: string;
  priority: number;
  note: string;
  updated_at: string;
}

export const THREAD_STATUS = ['open', 'resolved', 'abandoned', 'overdue'] as const;

function positiveWindow(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

export function listThreads(store: Store, bookId: number, status?: string): Thread[] {
  if (status) return store.all<Thread>('SELECT * FROM threads WHERE book_id=? AND status=? ORDER BY priority DESC, id', bookId, status);
  return store.all<Thread>('SELECT * FROM threads WHERE book_id=? ORDER BY status, priority DESC, id', bookId);
}

export function upsertThread(store: Store, bookId: number, t: Partial<Thread> & { code: string; title: string }): Thread {
  const exist = store.get<Thread>('SELECT * FROM threads WHERE book_id=? AND code=?', bookId, t.code);
  if (exist) {
    store.run(
      `UPDATE threads SET title=?, detail=?, kind=?, planted_idx=COALESCE(?,planted_idx), plant_quote=COALESCE(?,plant_quote),
        due_from=COALESCE(?,due_from), due_to=COALESCE(?,due_to), priority=COALESCE(?,priority), note=COALESCE(?,note), updated_at=?
       WHERE id=?`,
      t.title,
      t.detail ?? exist.detail,
      t.kind ?? exist.kind,
      t.planted_idx ?? null,
      t.plant_quote ?? null,
      t.due_from ?? null,
      t.due_to ?? null,
      t.priority ?? null,
      t.note ?? null,
      nowIso(),
      exist.id,
    );
    return store.get<Thread>('SELECT * FROM threads WHERE id=?', exist.id)!;
  }
  const r = store.run(
    `INSERT INTO threads (book_id, code, title, detail, kind, planted_idx, plant_quote, due_from, due_to, priority, note, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    bookId,
    t.code,
    t.title,
    t.detail ?? '',
    t.kind ?? 'setup',
    t.planted_idx ?? null,
    t.plant_quote ?? '',
    t.due_from ?? null,
    t.due_to ?? null,
    t.priority ?? 2,
    t.note ?? '',
    nowIso(),
  );
  return store.get<Thread>('SELECT * FROM threads WHERE id=?', r.lastInsertRowid)!;
}

/** 本章必须处理的线索：已过期 > 到期窗口内 > 高优先级 */
export function dueThreads(store: Store, bookId: number, chapterIdx: number, window = 2): Thread[] {
  const rows = store.all<Thread>(
    `SELECT * FROM threads WHERE book_id=? AND status='open' ORDER BY COALESCE(due_to, 999999) ASC, priority DESC`,
    bookId,
  );
  return rows.filter((t) => {
    const dueTo = t.due_to ?? 999999;
    const dueFrom = t.due_from ?? 0;
    return dueTo <= chapterIdx + window || dueFrom <= chapterIdx;
  });
}

export function overdueThreads(store: Store, bookId: number, chapterIdx: number): Thread[] {
  return store.all<Thread>(
    `SELECT * FROM threads WHERE book_id=? AND status='open' AND due_to IS NOT NULL AND due_to > 0 AND due_to < ? ORDER BY due_to ASC`,
    bookId,
    chapterIdx,
  );
}

/** 把正文里的一段引用做规范化，用于"证据是否真的存在"的判断 */
export function normalizeForMatch(s: string): string {
  return String(s || '')
    .replace(/[\s“”"'‘’「」『』，,。.！!？?；;：:、—\-…（）()【】\[\]]/g, '')
    .toLowerCase();
}

export function quoteExistsInText(quote: string, text: string): boolean {
  const q = normalizeForMatch(quote);
  if (q.length < 2) return false;
  const t = normalizeForMatch(text);
  return t.includes(q);
}

export interface ThreadEvent {
  code: string;
  action: 'plant' | 'advance' | 'payoff' | 'abandon' | 'extend';
  quote?: string;
  title?: string;
  detail?: string;
  due_from?: number;
  due_to?: number;
  note?: string;
}

export interface ApplyResult {
  applied: ThreadEvent[];
  rejected: { event: ThreadEvent; reason: string }[];
  threads: Thread[];
}

/**
 * 应用模型抽取出的线索事件。
 * 硬规则：
 *  - payoff 必须给出正文原句证据，且证据必须能在正文里找到 → 否则拒绝（保持 open）
 *  - plant 必须有证据，埋入章 = 当前章
 *  - 未登记的新线索自动建档，但必须有 title
 */
export function applyThreadEvents(
  store: Store,
  bookId: number,
  chapterIdx: number,
  events: ThreadEvent[],
  text: string,
): ApplyResult {
  const applied: ThreadEvent[] = [];
  const rejected: { event: ThreadEvent; reason: string }[] = [];

  for (const ev of events || []) {
    if (!ev || !ev.code) {
      rejected.push({ event: ev, reason: '缺少 code' });
      continue;
    }
    const existing = store.get<Thread>('SELECT * FROM threads WHERE book_id=? AND code=?', bookId, ev.code);
    const quoteOk = ev.quote ? quoteExistsInText(ev.quote, text) : false;

    if (ev.action === 'payoff') {
      if (!existing) {
        rejected.push({ event: ev, reason: `未登记的线索 ${ev.code}，不能直接回收` });
        continue;
      }
      if (existing.status === 'resolved') {
        rejected.push({ event: ev, reason: `线索 ${ev.code} 已回收（第 ${existing.resolved_idx} 章）` });
        continue;
      }
      if (!quoteOk) {
        rejected.push({ event: ev, reason: `回收证据不在正文中：${(ev.quote || '(空)').slice(0, 40)}` });
        continue;
      }
      store.run(
        `UPDATE threads SET status='resolved', resolved_idx=?, resolve_quote=?, note=?, updated_at=? WHERE id=?`,
        chapterIdx,
        ev.quote,
        ev.note ?? existing.note,
        nowIso(),
        existing.id,
      );
      applied.push(ev);
      continue;
    }

    if (ev.action === 'abandon') {
      if (!existing) {
        rejected.push({ event: ev, reason: `未登记的线索 ${ev.code}` });
        continue;
      }
      store.run(`UPDATE threads SET status='abandoned', note=?, updated_at=? WHERE id=?`, ev.note ?? existing.note, nowIso(), existing.id);
      applied.push(ev);
      continue;
    }

    if (ev.action === 'plant') {
      if (existing && existing.status === 'resolved') {
        rejected.push({ event: ev, reason: `线索 ${ev.code} 已回收，不能重新埋` });
        continue;
      }
      if (!quoteOk) {
        rejected.push({ event: ev, reason: `埋点证据不在正文中：${(ev.quote || '(空)').slice(0, 40)}` });
        continue;
      }
      const t = upsertThread(store, bookId, {
        code: ev.code,
        title: ev.title || existing?.title || ev.code,
        detail: ev.detail || existing?.detail || '',
        kind: ev.action,
        planted_idx: chapterIdx,
        plant_quote: ev.quote!,
        due_from: positiveWindow(ev.due_from) ?? positiveWindow(existing?.due_from) ?? chapterIdx + 3,
        due_to: positiveWindow(ev.due_to) ?? positiveWindow(existing?.due_to) ?? chapterIdx + 12,
        note: ev.note,
      });
      applied.push(ev);
      continue;
    }

    if (ev.action === 'advance' || ev.action === 'extend') {
      if (!existing) {
        rejected.push({ event: ev, reason: `推进未登记线索 ${ev.code}` });
        continue;
      }
      if (existing.status === 'resolved') {
        rejected.push({ event: ev, reason: `线索 ${ev.code} 已回收` });
        continue;
      }
      store.run(
        `UPDATE threads SET due_from=COALESCE(?,due_from), due_to=COALESCE(?,due_to), note=COALESCE(?,note), updated_at=? WHERE id=?`,
        positiveWindow(ev.due_from) ?? null,
        positiveWindow(ev.due_to) ?? null,
        ev.note ?? null,
        nowIso(),
        existing.id,
      );
      applied.push(ev);
    }
  }

  return { applied, rejected, threads: listThreads(store, bookId) };
}

export function threadHealth(store: Store, bookId: number, currentIdx: number) {
  const all = listThreads(store, bookId);
  const open = all.filter((t) => t.status === 'open');
  const overdue = open.filter((t) => t.due_to != null && t.due_to > 0 && t.due_to < currentIdx);
  const dueSoon = open.filter((t) => t.due_to != null && t.due_to > 0 && t.due_to >= currentIdx && t.due_to <= currentIdx + 2);
  const resolved = all.filter((t) => t.status === 'resolved');
  const planted = all.filter((t) => t.planted_idx != null);
  const spans = resolved
    .filter((t) => t.planted_idx != null && t.resolved_idx != null)
    .map((t) => (t.resolved_idx as number) - (t.planted_idx as number));
  return {
    total: all.length,
    open: open.length,
    overdue: overdue.length,
    dueSoon: dueSoon.length,
    resolved: resolved.length,
    resolveRate: planted.length ? resolved.length / planted.length : 0,
    avgSpan: spans.length ? spans.reduce((a, b) => a + b, 0) / spans.length : 0,
    overdueList: overdue,
    dueSoonList: dueSoon,
  };
}
