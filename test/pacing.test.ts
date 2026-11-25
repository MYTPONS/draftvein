import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db/index.ts';
import { createBook, saveChapter } from '../src/engine/book.ts';
import { applyHighlights, pacingReport, addHighlight, withPlannedSetups } from '../src/engine/pacing.ts';

function setup() {
  const s = new Store(':memory:');
  const b = createBook(s, { title: 'T', premise: 'P' });
  return { s, b };
}

const TEXT = '沈砚把纸包拍在桌上，对方脸色变了。\n\n巷口那盏灯忽然灭了。黑暗里有人低声数数。';

test('爆点必须有正文证据，否则拒绝', () => {
  const { s, b } = setup();
  const r1 = applyHighlights(s, b.id, 1, [{ kind: 'beat', type: '反转', intensity: 4, quote: '正文里没有这句' }], TEXT);
  assert.equal(r1.applied.length, 0);
  assert.equal(r1.rejected.length, 1);

  const r2 = applyHighlights(s, b.id, 1, [{ kind: 'beat', type: '反转', intensity: 4, quote: '对方脸色变了' }], TEXT);
  assert.equal(r2.applied.length, 1);
});

test('缺章末钩子 → 报问题', () => {
  const { s, b } = setup();
  saveChapter(s, b.id, 1, { title: 'a', content: TEXT });
  addHighlight(s, b.id, { chapter_idx: 1, kind: 'beat', type: '反转', intensity: 4, title: 't', quote: '对方脸色变了', setup_note: '第0章铺垫' });
  const r = pacingReport(s, b.id);
  assert.equal(r.chapters[0].hook, false);
  assert.ok(r.issues.some((i) => /没有章末钩子/.test(i.message)), JSON.stringify(r.issues));
});

test('连续两章无爽点 → dryStreak 与告警', () => {
  const { s, b } = setup();
  saveChapter(s, b.id, 1, { title: 'a', content: TEXT });
  saveChapter(s, b.id, 2, { title: 'b', content: TEXT });
  addHighlight(s, b.id, { chapter_idx: 1, kind: 'hook', type: '危机', intensity: 2, title: 'h', quote: '灯忽然灭了', setup_note: '' });
  addHighlight(s, b.id, { chapter_idx: 2, kind: 'hook', type: '危机', intensity: 2, title: 'h', quote: '灯忽然灭了', setup_note: '' });
  const r = pacingReport(s, b.id);
  assert.equal(r.dryStreak, 2);
  assert.ok(r.issues.some((i) => /连续 2 章没有中强度/.test(i.message)), JSON.stringify(r.issues));
  assert.ok(r.nextAdvice.neededIntensity >= 4);
});

test('黄金三章：第一章强度不足要提示', () => {
  const { s, b } = setup();
  saveChapter(s, b.id, 1, { title: 'a', content: TEXT });
  addHighlight(s, b.id, { chapter_idx: 1, kind: 'hook', type: '危机', intensity: 1, title: 'h', quote: '灯忽然灭了', setup_note: '' });
  const r = pacingReport(s, b.id);
  assert.ok(r.issues.some((i) => /黄金三章/.test(i.message)), JSON.stringify(r.issues));
});

test('高强爆点无铺垫 → 提示', () => {
  const { s, b } = setup();
  saveChapter(s, b.id, 1, { title: 'a', content: TEXT });
  addHighlight(s, b.id, { chapter_idx: 1, kind: 'climax', type: '揭秘', intensity: 5, title: '真相', quote: '对方脸色变了', setup_note: '' });
  addHighlight(s, b.id, { chapter_idx: 1, kind: 'hook', type: '危机', intensity: 3, title: 'h', quote: '灯忽然灭了', setup_note: '' });
  const r = pacingReport(s, b.id);
  assert.ok(r.issues.some((i) => /没有铺垫记录/.test(i.message)));
  assert.equal(r.chapters[0].hook, true);
  assert.equal(r.hookCoverage, 1);
});

test('规划里的 setup 会补到抽取出的高强爆点上', () => {
  const planned = [
    { kind: 'climax', type: '揭秘', intensity: 4, title: '秤底夹层', setup: '第1章铜钱变重、陆秉衡挪秤' },
  ];
  const events = withPlannedSetups(
    [{ kind: 'climax', type: '揭秘', intensity: 4, title: '秤底当票', quote: '对方脸色变了' }],
    planned,
  );
  assert.equal(events[0].setup_note, '第1章铜钱变重、陆秉衡挪秤');
});

test('已有章节也能从计划回填 setup，不再误报无铺垫', () => {
  const { s, b } = setup();
  saveChapter(s, b.id, 1, { title: 'a', content: TEXT });
  s.run(
    'INSERT INTO chapter_plans (book_id, idx, title, highlights, created_at) VALUES (?,?,?,?,?)',
    b.id,
    1,
    'a',
    JSON.stringify([{ kind: 'climax', type: '揭秘', intensity: 5, title: '真相', setup: '第0章埋了铜钱异象' }]),
    new Date().toISOString(),
  );
  addHighlight(s, b.id, { chapter_idx: 1, kind: 'climax', type: '揭秘', intensity: 5, title: '真相', quote: '对方脸色变了', setup_note: '' });
  addHighlight(s, b.id, { chapter_idx: 1, kind: 'hook', type: '危机', intensity: 3, title: 'h', quote: '灯忽然灭了', setup_note: '' });
  const r = pacingReport(s, b.id);
  assert.ok(!r.issues.some((i) => /没有铺垫记录/.test(i.message)), JSON.stringify(r.issues));
});
