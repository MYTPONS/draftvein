/**
 * 期待-兑现台账：读者先被勾住（羞辱/立旗/约定/威胁/悬念），然后必须给兑现。
 * 与"伏笔台账"不同：伏笔管的是剧情谜题，这里管的是**情绪期待**——
 * 读者为什么继续追：想看主角被羞辱后怎么打回去、想知道立的 flag 怎么完成。
 * 硬规则：兑现必须给正文原句；强度≥4 的爆点必须挂在一个已登记的期待上。
 */
import type { Store } from '../db/index.ts';
import { nowIso } from '../config.ts';
import { quoteExistsInText } from './ledger.ts';

export interface Expectation {
  id: number;
  book_id: number;
  code: string;
  type: string;
  title: string;
  detail: string;
  strength: number;
  planted_idx: number | null;
  plant_quote: string;
  due_from: number | null;
  due_to: number | null;
  fulfilled_idx: number | null;
  fulfill_quote: string;
  status: string;
  note: string;
  updated_at: string;
}

export const EXPECTATION_TYPES = ['羞辱', '立旗', '约定', '威胁', '悬念', '许诺'];

function positiveWindow(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

export function listExpectations(store: Store, bookId: number): Expectation[] {
  return store.all<Expectation>('SELECT * FROM expectations WHERE book_id=? ORDER BY status, due_to, id', bookId);
}

export function upsertExpectation(store: Store, bookId: number, input: Partial<Expectation> & { code: string; title: string }): Expectation {
  const exist = store.get<Expectation>('SELECT * FROM expectations WHERE book_id=? AND code=?', bookId, input.code);
  if (exist) {
    store.run(
      `UPDATE expectations SET title=COALESCE(?,title), type=COALESCE(?,type), detail=COALESCE(?,detail), strength=COALESCE(?,strength),
        due_from=COALESCE(?,due_from), due_to=COALESCE(?,due_to), note=COALESCE(?,note), updated_at=? WHERE id=?`,
      input.title ?? null,
      input.type ?? null,
      input.detail ?? null,
      input.strength ?? null,
      input.due_from ?? null,
      input.due_to ?? null,
      input.note ?? null,
      nowIso(),
      exist.id,
    );
    return store.get<Expectation>('SELECT * FROM expectations WHERE id=?', exist.id)!;
  }
  const r = store.run(
    `INSERT INTO expectations (book_id, code, type, title, detail, strength, due_from, due_to, note, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    bookId,
    input.code,
    input.type ?? '悬念',
    input.title,
    input.detail ?? '',
    input.strength ?? 3,
    input.due_from ?? null,
    input.due_to ?? null,
    input.note ?? '',
    nowIso(),
  );
  return store.get<Expectation>('SELECT * FROM expectations WHERE id=?', r.lastInsertRowid)!;
}

export interface ExpectationEvent {
  code: string;
  action: 'plant' | 'fulfill' | 'extend' | 'abandon';
  type?: string;
  title?: string;
  detail?: string;
  strength?: number;
  quote?: string;
  due_from?: number;
  due_to?: number;
  note?: string;
}

export function applyExpectationEvents(store: Store, bookId: number, chapterIdx: number, events: ExpectationEvent[], text: string) {
  const applied: ExpectationEvent[] = [];
  const rejected: { event: ExpectationEvent; reason: string }[] = [];
  for (const ev of events || []) {
    if (!ev?.code) continue;
    const exist = store.get<Expectation>('SELECT * FROM expectations WHERE book_id=? AND code=?', bookId, ev.code);
    const quoteOk = ev.quote ? quoteExistsInText(ev.quote, text) : false;

    if (ev.action === 'plant') {
      if (exist && exist.status === 'fulfilled') {
        rejected.push({ event: ev, reason: `期待 ${ev.code} 已兑现，不能再立` });
        continue;
      }
      if (!quoteOk) {
        rejected.push({ event: ev, reason: `立期待的证据不在正文：${(ev.quote || '(空)').slice(0, 30)}` });
        continue;
      }
      store.run('DELETE FROM expectations WHERE book_id=? AND code=?', bookId, ev.code);
      const r = store.run(
        `INSERT INTO expectations (book_id, code, type, title, detail, strength, planted_idx, plant_quote, due_from, due_to, status, note, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        bookId,
        ev.code,
        ev.type ?? '悬念',
        ev.title ?? ev.code,
        ev.detail ?? '',
        ev.strength ?? 3,
        chapterIdx,
        ev.quote,
        positiveWindow(ev.due_from) ?? chapterIdx + 1,
        positiveWindow(ev.due_to) ?? chapterIdx + 4,
        'open',
        ev.note ?? '',
        nowIso(),
      );
      applied.push(ev);
      continue;
    }

    if (ev.action === 'fulfill') {
      if (!exist) {
        rejected.push({ event: ev, reason: `未登记的期待 ${ev.code}` });
        continue;
      }
      if (exist.status === 'fulfilled') {
        rejected.push({ event: ev, reason: `期待 ${ev.code} 已兑现（第 ${exist.fulfilled_idx} 章）` });
        continue;
      }
      if (!quoteOk) {
        rejected.push({ event: ev, reason: `兑现证据不在正文：${(ev.quote || '(空)').slice(0, 30)}` });
        continue;
      }
      store.run(
        "UPDATE expectations SET status='fulfilled', fulfilled_idx=?, fulfill_quote=?, note=?, updated_at=? WHERE id=?",
        chapterIdx,
        ev.quote,
        ev.note ?? exist.note,
        nowIso(),
        exist.id,
      );
      applied.push(ev);
      continue;
    }

    if (ev.action === 'extend') {
      if (!exist) {
        rejected.push({ event: ev, reason: `未登记的期待 ${ev.code}` });
        continue;
      }
      store.run(
        'UPDATE expectations SET due_from=COALESCE(?,due_from), due_to=COALESCE(?,due_to), note=COALESCE(?,note), updated_at=? WHERE id=?',
        positiveWindow(ev.due_from) ?? null,
        positiveWindow(ev.due_to) ?? null,
        ev.note ?? null,
        nowIso(),
        exist.id,
      );
      applied.push(ev);
      continue;
    }

    if (ev.action === 'abandon') {
      if (!exist) continue;
      store.run("UPDATE expectations SET status='abandoned', note=COALESCE(?,note), updated_at=? WHERE id=?", ev.note ?? null, nowIso(), exist.id);
      applied.push(ev);
    }
  }
  return { applied, rejected };
}

export interface ExpectationIssue {
  severity: 'block' | 'warn' | 'info';
  chapter: number;
  message: string;
}

export function expectationReport(store: Store, bookId: number, currentIdx: number) {
  const all = listExpectations(store, bookId);
  const open = all.filter((e) => e.status === 'open');
  const overdue = open.filter((e) => e.due_to != null && e.due_to > 0 && e.due_to < currentIdx);
  const dueSoon = open.filter((e) => e.due_to != null && e.due_to > 0 && e.due_to >= currentIdx && e.due_to <= currentIdx + 2);
  const fulfilled = all.filter((e) => e.status === 'fulfilled');
  const spans = fulfilled
    .filter((e) => e.planted_idx != null && e.fulfilled_idx != null)
    .map((e) => (e.fulfilled_idx as number) - (e.planted_idx as number));

  const issues: ExpectationIssue[] = [];
  for (const e of overdue) {
    const late = currentIdx - (e.due_to as number);
    issues.push({ severity: late >= 3 ? 'block' : 'warn', chapter: currentIdx, message: `期待「${e.title}」已逾期 ${late} 章没兑现（第 ${e.planted_idx} 章立的）` });
  }
  for (const e of fulfilled) {
    const span = (e.fulfilled_idx ?? 0) - (e.planted_idx ?? 0);
    if (span > 12) issues.push({ severity: 'warn', chapter: e.fulfilled_idx ?? 0, message: `期待「${e.title}」等了 ${span} 章才兑现，读者早忘了` });
  }

  return {
    total: all.length,
    open: open.length,
    overdue: overdue.length,
    dueSoon: dueSoon.length,
    fulfilled: fulfilled.length,
    fulfillRate: all.length ? fulfilled.length / all.length : 0,
    avgSpan: spans.length ? Number((spans.reduce((a, b) => a + b, 0) / spans.length).toFixed(1)) : 0,
    overdueList: overdue,
    dueSoonList: dueSoon,
    issues,
  };
}
