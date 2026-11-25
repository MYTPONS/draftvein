import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db/index.ts';
import { Llm } from '../src/llm/client.ts';
import { createBook, listCharacters, upsertCharacter, touchCharacters, suspectNames, ensureSuspectCharacters, repairStoredSuspectCharacters, saveChapter } from '../src/engine/book.ts';
import { ensureCast, ensurePlan } from '../src/engine/outline.ts';
import { buildContext } from '../src/engine/context.ts';
import type { LlmConfig } from '../src/config.ts';

const cfg: LlmConfig = { provider: 'mock', baseUrl: '', apiKey: '', model: 'mock', temperature: 0, jsonTemperature: 0, maxTokens: 4000, timeoutMs: 1000 };

function setup() {
  const s = new Store(':memory:');
  const b = createBook(s, { title: '旧城换命', genre: '悬疑', premise: '不能拒绝的差事' });
  return { s, b, llm: new Llm(cfg) };
}

test('第一次规划自动建人物卡，且主角唯一', async () => {
  const { s, b, llm } = setup();
  const cast = await ensureCast(s, llm, b);
  assert.equal(cast.length, 5);
  const list = listCharacters(s, b.id);
  assert.equal(list.filter((c) => c.role === 'protagonist').length, 1);
  assert.ok(list.every((c) => c.name.length >= 2));
});

test('章节计划只收已登记人物，未登记的名字被剔除', async () => {
  const { s, b, llm } = setup();
  await ensureCast(s, llm, b);
  const plan = await ensurePlan(s, llm, b, 1);
  assert.ok(plan.title.length > 0);
  const row = s.get('SELECT * FROM chapter_plans WHERE book_id=? AND idx=1', b.id);
  const names = JSON.parse(row.cast);
  const known = new Set(listCharacters(s, b.id).map((c) => c.name));
  assert.ok(names.length >= 1);
  assert.ok(names.every((n) => known.has(n)), `未登记名字混进计划：${names.join(',')}`);
});

test('上下文里带人物卡（说话方式/口头禅）', async () => {
  const { s, b, llm } = setup();
  await ensureCast(s, llm, b);
  const ctx = buildContext(s, b, 1, undefined);
  assert.match(ctx.cast, /说话方式/);
  assert.match(ctx.cast, /口头禅/);
});

test('落库回写出场：first_idx / mentions', async () => {
  const { s, b } = setup();
  const c = upsertCharacter(s, b.id, { name: '沈砚', role: 'protagonist', importance: 5 });
  touchCharacters(s, b.id, 3, ['沈砚']);
  touchCharacters(s, b.id, 4, ['沈砚']);
  const after = s.get('SELECT first_idx, last_idx, mentions FROM characters WHERE id=?', c.id);
  assert.equal(after.first_idx, 3);
  assert.equal(after.last_idx, 4);
  assert.equal(after.mentions, 2);
});

test('未登记人名检测：只抓重复出现的', async () => {
  const { s, b } = setup();
  upsertCharacter(s, b.id, { name: '沈砚' });
  const text = '沈砚说：“走。”顾九说：“不。”顾九说：“等着。”陌生人甲说了一句话就走。';
  const suspects = suspectNames(s, b.id, text);
  assert.ok(suspects.includes('顾九'));
  assert.ok(!suspects.includes('沈砚'));
  assert.ok(!suspects.includes('陌生人甲'));
  assert.deepEqual(suspectNames(s, b.id, '外头有人在喊名字，又有人在笑。远处有人在道别。'), []);
});

test('人物卡严格按书隔离：同名不同书互不影响，也不跨本复用', async () => {
  const s = new Store(':memory:');
  const b1 = createBook(s, { title: '书一' });
  const b2 = createBook(s, { title: '书二' });
  upsertCharacter(s, b1.id, { name: '沈砚', role: 'protagonist' });
  upsertCharacter(s, b2.id, { name: '沈砚', role: 'support', identity: '另一本书里的同名龙套' });
  const l1 = listCharacters(s, b1.id);
  const l2 = listCharacters(s, b2.id);
  assert.equal(l1.length, 1);
  assert.equal(l2.length, 1);
  assert.notEqual(l1[0].id, l2[0].id);
  assert.equal(l1[0].role, 'protagonist');
  assert.equal(l2[0].role, 'support');
  // 改一本书的卡不影响另一本
  upsertCharacter(s, b1.id, { name: '沈砚', status: 'dead' });
  assert.equal(listCharacters(s, b2.id)[0].status, 'alive');
});

test('正文反复出现的未登记人物自动补成待完善人物卡，避免每次都报同名警告', () => {
  const { s, b } = setup();
  upsertCharacter(s, b.id, { name: '沈砚', role: 'protagonist' });
  const added = ensureSuspectCharacters(s, b.id, ['老赵']);
  assert.deepEqual(added, ['老赵']);
  const card = listCharacters(s, b.id).find((c) => c.name === '老赵')!;
  assert.equal(card.role, 'support');
  assert.equal(card.category, '次要角色');
  assert.match(card.notes, /正文自动补卡/);
  assert.deepEqual(ensureSuspectCharacters(s, b.id, ['老赵']), []);
});

test('老章节里已记录的嫌疑人物也能在启动时回填人物卡', () => {
  const { s, b } = setup();
  saveChapter(s, b.id, 1, { title: '旧章', content: '老赵说了一句话。', checks: { suspects: ['老赵'] } });
  assert.deepEqual(repairStoredSuspectCharacters(s, b.id), ['老赵']);
  assert.ok(listCharacters(s, b.id).some((c) => c.name === '老赵'));
});

test('旧审稿里的“人物卡外新名字”也会参与启动回填', () => {
  const { s, b } = setup();
  saveChapter(s, b.id, 1, {
    title: '旧章',
    content: '孙五说了一句话。',
    checks: { review: { issues: [{ type: 'character', severity: 'warn', message: '孙五是人物卡外的新名字' }] } },
  });
  assert.deepEqual(repairStoredSuspectCharacters(s, b.id), ['孙五']);
});
