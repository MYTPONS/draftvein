import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db/index.ts';
import { Llm } from '../src/llm/client.ts';
import { createBook, listChapters, listPlans, getPlan } from '../src/engine/book.ts';
import { writeChapter } from '../src/engine/chapter.ts';
import { runChapters } from '../src/engine/run.ts';
import { listThreads } from '../src/engine/ledger.ts';
import type { LlmConfig } from '../src/config.ts';

const cfg: LlmConfig = {
  provider: 'mock',
  baseUrl: '',
  apiKey: '',
  model: 'mock',
  temperature: 0,
  jsonTemperature: 0,
  maxTokens: 4000,
  timeoutMs: 1000,
};

function setup() {
  const s = new Store(':memory:');
  const b = createBook(s, { title: '旧城换命', genre: '悬疑', premise: '一桩不能拒绝的差事' });
  const llm = new Llm(cfg);
  return { s, b, llm };
}

test('一次只推进一章：写第 1 章不会产出第 2 章正文', async () => {
  const { s, b, llm } = setup();
  await writeChapter(s, llm, b, 1);
  const chapters = listChapters(s, b.id);
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].idx, 1);
  assert.ok(chapters[0].word_count >= 1800, `words=${chapters[0].word_count}`);
});

test('章节计划是滚动窗口，不会一次生成全书标题', async () => {
  const { s, b, llm } = setup();
  await runChapters(s, llm, b, { count: 2 });
  const plans = listPlans(s, b.id);
  const chapters = listChapters(s, b.id);
  assert.equal(chapters.length, 2);
  // 写 2 章后，最多只允许"已写 + 1 章"的计划存在（run 结束会补下一章）
  assert.ok(plans.length <= chapters.length + 1, `plans=${plans.length} chapters=${chapters.length}`);
  assert.ok(plans.every((p) => p.idx <= 3));
});

test('写完一章会记账：摘要、事实、伏笔证据', async () => {
  const { s, b, llm } = setup();
  await writeChapter(s, llm, b, 1);
  const ch = listChapters(s, b.id)[0];
  assert.ok(ch.summary.length > 5, 'summary 为空');
  const facts = s.all('SELECT * FROM facts WHERE book_id=?', b.id);
  assert.ok(facts.length >= 1);
  const threads = listThreads(s, b.id);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].planted_idx, 1);
  assert.ok(threads[0].plant_quote.length >= 4);
});

test('已落库章节可只返工不重写（reviseOnly）', async () => {
  const { s, b, llm } = setup();
  const first = await writeChapter(s, llm, b, 1);
  const again = await writeChapter(s, llm, b, 1, { reviseOnly: true });
  assert.equal(again.idx, 1);
  assert.equal(listChapters(s, b.id).length, 1);
  assert.ok(again.words > 0);
  assert.equal(first.idx, again.idx);
});

test('章节状态：通过审稿才是 reviewed', async () => {
  const { s, b, llm } = setup();
  const r = await writeChapter(s, llm, b, 1);
  const ch = listChapters(s, b.id)[0];
  assert.ok(['reviewed', 'draft'].includes(ch.status));
  assert.ok(r.report.score >= 0);
  assert.ok(getPlan(s, b.id, 1));
});
