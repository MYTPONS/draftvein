import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db/index.ts';
import { createBook } from '../src/engine/book.ts';
import { applyExpectationEvents, expectationReport, listExpectations, upsertExpectation } from '../src/engine/expectations.ts';

const TEXT = '沈砚把名单折成四折，塞进内袋。\n\n他把纸包拍在桌上，对方脸色变了。';
function setup() {
  const s = new Store(':memory:');
  const b = createBook(s, { title: 'T', premise: 'P' });
  return { s, b };
}

test('立期待必须带正文证据', () => {
  const { s, b } = setup();
  const bad = applyExpectationEvents(s, b.id, 1, [{ code: 'f1', action: 'plant', title: '立旗', quote: '正文没有这句' }], TEXT);
  assert.equal(bad.applied.length, 0);
  const ok = applyExpectationEvents(s, b.id, 1, [{ code: 'f1', action: 'plant', title: '立旗', type: '立旗', strength: 4, quote: '名单折成四折', due_from: 2, due_to: 5 }], TEXT);
  assert.equal(ok.applied.length, 1);
  const e = listExpectations(s, b.id)[0];
  assert.equal(e.status, 'open');
  assert.equal(e.planted_idx, 1);
});

test('兑现必须带证据，不能重复兑现，不能兑现未登记的', () => {
  const { s, b } = setup();
  applyExpectationEvents(s, b.id, 1, [{ code: 'f1', action: 'plant', title: '立旗', quote: '名单折成四折', due_from: 2, due_to: 5 }], TEXT);
  const bad = applyExpectationEvents(s, b.id, 2, [{ code: 'f1', action: 'fulfill', quote: '不存在的句子' }], TEXT);
  assert.equal(bad.applied.length, 0);
  const ghost = applyExpectationEvents(s, b.id, 2, [{ code: 'x', action: 'fulfill', quote: '对方脸色变了' }], TEXT);
  assert.match(ghost.rejected[0].reason, /未登记/);
  const ok = applyExpectationEvents(s, b.id, 2, [{ code: 'f1', action: 'fulfill', quote: '对方脸色变了' }], TEXT);
  assert.equal(ok.applied.length, 1);
  const again = applyExpectationEvents(s, b.id, 3, [{ code: 'f1', action: 'fulfill', quote: '对方脸色变了' }], TEXT);
  assert.match(again.rejected[0].reason, /已兑现/);
});

test('逾期与跨度告警', () => {
  const { s, b } = setup();
  applyExpectationEvents(s, b.id, 1, [{ code: 'f1', action: 'plant', title: '立旗', quote: '名单折成四折', due_from: 2, due_to: 3 }], TEXT);
  applyExpectationEvents(s, b.id, 2, [{ code: 'f2', action: 'plant', title: '另一个', quote: '对方脸色变了', due_from: 3, due_to: 10 }], TEXT);
  // 到第 5 章，f1 逾期 2 章
  const r = expectationReport(s, b.id, 5);
  assert.equal(r.overdue, 1);
  assert.ok(r.issues.some((i) => /逾期/.test(i.message)), JSON.stringify(r.issues));
  assert.equal(r.open, 2);
});

test('长跨度兑现告警', () => {
  const { s, b } = setup();
  applyExpectationEvents(s, b.id, 1, [{ code: 'long', action: 'plant', title: '拖太久', quote: '名单折成四折' }], TEXT);
  applyExpectationEvents(s, b.id, 20, [{ code: 'long', action: 'fulfill', quote: '对方脸色变了' }], TEXT);
  const r = expectationReport(s, b.id, 21);
  assert.ok(r.issues.some((i) => /等了 19 章/.test(i.message)), JSON.stringify(r.issues));
  assert.equal(r.fulfilled, 1);
  assert.equal(r.avgSpan, 19);
});

test('期待事件的 0 窗口按未知处理，不能把刚立的期待判成逾期', () => {
  const { s, b } = setup();
  applyExpectationEvents(s, b.id, 1, [{ code: 'zero', action: 'plant', title: '零窗口', quote: '名单折成四折', due_from: 0, due_to: 0 }], TEXT);
  const e = listExpectations(s, b.id)[0];
  assert.equal(e.due_from, 2);
  assert.equal(e.due_to, 5);
  assert.equal(expectationReport(s, b.id, 2).overdue, 0);
});
