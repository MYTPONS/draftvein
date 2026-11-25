import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db/index.ts';
import { createBook } from '../src/engine/book.ts';
import { applyThreadEvents, listThreads, threadHealth, upsertThread, dueThreads, quoteExistsInText } from '../src/engine/ledger.ts';

function fresh() {
  const s = new Store(':memory:');
  const b = createBook(s, { title: 'T', premise: 'P' });
  return { s, b };
}

const CHAPTER = '他把名单折成四折，塞进内袋。\n\n巷口的灯坏了三盏。\n\n“东西呢？”\n\n“先说说，谁让你来的。”';

test('埋点必须带正文里存在的证据，否则拒绝', () => {
  const { s, b } = fresh();
  const r1 = applyThreadEvents(s, b.id, 1, [{ code: 'x', action: 'plant', title: 'X', quote: '正文里没有这句话' }], CHAPTER);
  assert.equal(r1.applied.length, 0);
  assert.equal(r1.rejected.length, 1);

  const r2 = applyThreadEvents(s, b.id, 1, [{ code: 'x', action: 'plant', title: 'X', quote: '名单折成四折', due_from: 4, due_to: 9 }], CHAPTER);
  assert.equal(r2.applied.length, 1);
  const t = listThreads(s, b.id)[0];
  assert.equal(t.planted_idx, 1);
  assert.equal(t.status, 'open');
});

test('回收必须引用正文原句，抽不到就保持 open', () => {
  const { s, b } = fresh();
  applyThreadEvents(s, b.id, 1, [{ code: 'x', action: 'plant', title: 'X', quote: '名单折成四折', due_from: 3, due_to: 5 }], CHAPTER);

  const bad = applyThreadEvents(s, b.id, 3, [{ code: 'x', action: 'payoff', quote: '他早就知道了' }], CHAPTER);
  assert.equal(bad.applied.length, 0);
  assert.match(bad.rejected[0].reason, /证据不在正文/);
  assert.equal(listThreads(s, b.id)[0].status, 'open');

  const ok = applyThreadEvents(s, b.id, 3, [{ code: 'x', action: 'payoff', quote: '“先说说，谁让你来的。”' }], CHAPTER);
  assert.equal(ok.applied.length, 1);
  const t = listThreads(s, b.id)[0];
  assert.equal(t.status, 'resolved');
  assert.equal(t.resolved_idx, 3);
});

test('不能回收未登记的线索，也不能重复回收', () => {
  const { s, b } = fresh();
  const r = applyThreadEvents(s, b.id, 1, [{ code: 'ghost', action: 'payoff', quote: '名单折成四折' }], CHAPTER);
  assert.equal(r.rejected[0].reason.includes('未登记'), true);

  applyThreadEvents(s, b.id, 1, [{ code: 'x', action: 'plant', title: 'X', quote: '名单折成四折' }], CHAPTER);
  applyThreadEvents(s, b.id, 2, [{ code: 'x', action: 'payoff', quote: '名单折成四折' }], CHAPTER);
  const again = applyThreadEvents(s, b.id, 3, [{ code: 'x', action: 'payoff', quote: '名单折成四折' }], CHAPTER);
  assert.equal(again.rejected[0].reason.includes('已回收'), true);
});

test('到期与逾期：窗口由正文事件推进', () => {
  const { s, b } = fresh();
  upsertThread(s, b.id, { code: 'a', title: 'A', due_from: 2, due_to: 4 });
  upsertThread(s, b.id, { code: 'b', title: 'B', due_from: 8, due_to: 12 });

  const at3 = dueThreads(s, b.id, 3, 2);
  assert.deepEqual(at3.map((t) => t.code), ['a']);
  const at9 = dueThreads(s, b.id, 9, 2);
  // a 已逾期仍在榜上，b 进入窗口；按到期先后排序
  assert.deepEqual(at9.map((t) => t.code), ['a', 'b']);

  const h5 = threadHealth(s, b.id, 5);
  assert.equal(h5.overdue, 1);
  assert.equal(h5.overdueList[0].code, 'a');

  const h2 = threadHealth(s, b.id, 2);
  assert.equal(h2.overdue, 0);
  assert.equal(h2.dueSoon, 1);
});

test('quoteExistsInText 忽略标点空白差异', () => {
  assert.equal(quoteExistsInText('名单 折成四折', CHAPTER), true);
  assert.equal(quoteExistsInText('“先说说，谁让你来的。”', CHAPTER), true);
  assert.equal(quoteExistsInText('你好', CHAPTER), false);
});

test('抽取器给出的 0 到期窗口按未知处理，使用默认窗口且不立即逾期', () => {
  const { s, b } = fresh();
  const r = applyThreadEvents(
    s,
    b.id,
    1,
    [{ code: 'zero-window', action: 'plant', title: '零窗口', quote: '名单折成四折', due_from: 0, due_to: 0 }],
    CHAPTER,
  );

  assert.equal(r.applied.length, 1);
  const t = listThreads(s, b.id)[0];
  assert.equal(t.due_from, 4);
  assert.equal(t.due_to, 13);
  assert.equal(threadHealth(s, b.id, 2).overdue, 0);
});

test('推进事件里的 0 不能抹掉已经规划的到期窗口', () => {
  const { s, b } = fresh();
  applyThreadEvents(
    s,
    b.id,
    1,
    [{ code: 'keep-window', action: 'plant', title: '保留窗口', quote: '名单折成四折', due_from: 5, due_to: 9 }],
    CHAPTER,
  );
  applyThreadEvents(
    s,
    b.id,
    2,
    [{ code: 'keep-window', action: 'advance', due_from: 0, due_to: 0 }],
    CHAPTER,
  );

  const t = listThreads(s, b.id)[0];
  assert.equal(t.due_from, 5);
  assert.equal(t.due_to, 9);
});

test('老库迁移把遗留的 0 到期窗口清成未知，避免继续误报逾期', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-ledger-migrate-'));
  const file = path.join(dir, 'novel-forge.db');
  const first = new Store(file);
  const b = createBook(first, { title: 'T', premise: 'P' });
  upsertThread(first, b.id, { code: 'legacy-zero', title: '旧零窗口', due_from: 0, due_to: 0 });
  first.close();

  const second = new Store(file);
  const t = second.get<{ due_from: number | null; due_to: number | null }>('SELECT due_from, due_to FROM threads WHERE book_id=?', b.id)!;
  assert.equal(t.due_from, null);
  assert.equal(t.due_to, null);
  second.close();
});
