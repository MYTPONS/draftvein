import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db/index.ts';
import { createBook, createVolume } from '../src/engine/book.ts';
import { listStages, seedStructure, stageAt, structureAdvice, TEMPLATES } from '../src/engine/structure.ts';

function setup() {
  const s = new Store(':memory:');
  const b = createBook(s, { title: 'T', premise: 'P' });
  return { s, b };
}

test('新书默认三幕结构', () => {
  const { s, b } = setup();
  const st = listStages(s, b.id);
  assert.equal(st.length, 3);
  assert.deepEqual(st.map((x) => x.name), ['第一幕 · 建立', '第二幕 · 对抗', '第三幕 · 收束']);
  assert.equal(st[0].start_pct, 0);
  assert.equal(st[2].end_pct, 100);
});

test('切模板会重写阶段', () => {
  const { s, b } = setup();
  seedStructure(s, b.id, 'qidian');
  const st = listStages(s, b.id);
  assert.equal(st.length, 5);
  assert.equal(st[0].name, '黄金三章');
  assert.ok(TEMPLATES.some((t) => t.key === 'qidian'));
});

test('stageAt 按规划总章数换算章号', () => {
  const { s, b } = setup();
  createVolume(s, b.id, { title: 'v1', start: 1, end: 100 });
  const a = stageAt(s, b.id, 10); // 10%
  assert.equal(a.total, 100);
  assert.equal(a.stage.name, '第一幕 · 建立');
  const b2 = stageAt(s, b.id, 50); // 50%
  assert.equal(b2.stage.name, '第二幕 · 对抗');
  const c = stageAt(s, b.id, 90); // 90%
  assert.equal(c.stage.name, '第三幕 · 收束');
});

test('structureAdvice 带阶段职能', () => {
  const { s, b } = setup();
  createVolume(s, b.id, { title: 'v1', start: 1, end: 40 });
  const t = structureAdvice(s, b.id, 20);
  assert.match(t, /结构位置：第二幕 · 对抗/);
  assert.match(t, /本阶段职能/);
});
