import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db/index.ts';
import { createBook, upsertCharacter, addTimeline, addRelation, currentRelations, aliasConflicts, listCharacters, saveChapter } from '../src/engine/book.ts';
import { timelineIssues, aliasIssues, castIssues, parseStoryTime, fullCheck } from '../src/engine/consistency.ts';

function setup() {
  const s = new Store(':memory:');
  const b = createBook(s, { title: 'T', premise: 'P' });
  return { s, b };
}

test('故事内时间解析', () => {
  assert.equal(parseStoryTime('第3天'), 3);
  assert.equal(parseStoryTime('三日'), 3);
  assert.equal(parseStoryTime('3月5日'), 305);
  assert.equal(parseStoryTime('2026-01-02'), 20260102);
  assert.equal(parseStoryTime('第二天傍晚'), 2);
  assert.equal(parseStoryTime('很久以后'), null);
});

test('死人在后文继续行动 → block', () => {
  const { s, b } = setup();
  upsertCharacter(s, b.id, { name: '老刀', status: 'dead' });
  addTimeline(s, b.id, 5, [{ story_time: '第5天', location: '茶楼', actors: '老刀', event: '老刀把茶端上来' }]);
  const issues = timelineIssues(s, b.id);
  const hit = issues.find((i) => i.severity === 'block');
  assert.ok(hit, JSON.stringify(issues));
  assert.match(hit!.message, /老刀/);
});

test('同章同一人出现在两个地点 → warn', () => {
  const { s, b } = setup();
  addTimeline(s, b.id, 2, [
    { story_time: '第2天', location: '茶楼', actors: '沈砚', event: '谈事' },
    { story_time: '第2天', location: '后巷', actors: '沈砚', event: '甩尾巴' },
  ]);
  const issues = timelineIssues(s, b.id);
  assert.ok(issues.some((i) => i.severity === 'warn' && /同时出现在/.test(i.message)), JSON.stringify(issues));
});

test('故事内时间倒退 → warn', () => {
  const { s, b } = setup();
  addTimeline(s, b.id, 1, [{ story_time: '第10天', location: 'A', actors: '沈砚', event: 'x' }]);
  addTimeline(s, b.id, 2, [{ story_time: '第3天', location: 'B', actors: '沈砚', event: 'y' }]);
  const issues = timelineIssues(s, b.id);
  assert.ok(issues.some((i) => /时间倒退/.test(i.message)), JSON.stringify(issues));
});

test('别名撞车被查出来', () => {
  const { s, b } = setup();
  upsertCharacter(s, b.id, { name: '沈砚', aliases: '砚哥' });
  upsertCharacter(s, b.id, { name: '老刀', aliases: '砚哥,刀叔' });
  const conflicts = aliasConflicts(s, b.id);
  assert.ok(conflicts.some((c) => c.alias === '砚哥' && c.name === '老刀'), JSON.stringify(conflicts));
  const issues = aliasIssues(s, b.id);
  assert.ok(issues.some((i) => i.type === 'alias' && /读者会分不清/.test(i.message)));
});

test('正文里死人说话 → block', () => {
  const { s, b } = setup();
  upsertCharacter(s, b.id, { name: '老刀', status: 'dead' });
  const issues = castIssues(s, b.id, 3, '老刀说：“先别急。”他抬起手。');
  assert.ok(issues.some((i) => i.severity === 'block'), JSON.stringify(issues));
});

test('关系：当前值取最后一条，且回写人物卡', () => {
  const { s, b } = setup();
  upsertCharacter(s, b.id, { name: '沈砚' });
  upsertCharacter(s, b.id, { name: '老刀' });
  addRelation(s, b.id, { from_name: '沈砚', to_name: '老刀', relation: '互相试探', chapter_idx: 1 });
  addRelation(s, b.id, { from_name: '沈砚', to_name: '老刀', relation: '决裂', chapter_idx: 3 });
  const cur = currentRelations(s, b.id);
  assert.equal(cur.length, 1);
  assert.equal(cur[0].relation, '决裂');
  assert.equal(cur[0].chapter_idx, 3);
  const shen = listCharacters(s, b.id).find((c) => c.name === '沈砚')!;
  assert.match(shen.relations, /决裂/);
});

test('fullCheck 汇总三类', () => {
  const { s, b } = setup();
  upsertCharacter(s, b.id, { name: '老刀', status: 'dead' });
  addTimeline(s, b.id, 4, [{ story_time: '第4天', location: '茶楼', actors: '老刀', event: '出现' }]);
  const r = fullCheck(s, b.id);
  assert.ok(r.summary.block >= 1, JSON.stringify(r.summary));
  assert.ok(Array.isArray(r.timeline) && Array.isArray(r.alias) && Array.isArray(r.poison));
});

test('不同场景同一人换个地点不算矛盾；同一场景两地才算', () => {
  const { s, b } = setup();
  addTimeline(s, b.id, 3, [
    { scene: '当铺', story_time: '第3天', location: '当铺', actors: '沈砚', event: '交接' },
    { scene: '巷口', story_time: '第3天', location: '巷口', actors: '沈砚', event: '被跟' },
  ]);
  assert.equal(timelineIssues(s, b.id).filter((i) => /同时出现在/.test(i.message)).length, 0);

  addTimeline(s, b.id, 4, [
    { scene: '密室', story_time: '第4天', location: '密室', actors: '沈砚', event: 'a' },
    { scene: '密室', story_time: '第4天', location: '码头', actors: '沈砚', event: 'b' },
  ]);
  const hits = timelineIssues(s, b.id).filter((i) => /同时出现在/.test(i.message));
  assert.equal(hits.length, 1, JSON.stringify(hits));
  assert.match(hits[0].message, /同一场景/);
});

test('人物卡补登后，旧审稿里的“人物卡外新名字”告警不再重复出现', () => {
  const { s, b } = setup();
  upsertCharacter(s, b.id, { name: '老赵', role: 'support' });
  saveChapter(s, b.id, 1, {
    title: 'a',
    content: '老赵说：“顾爷，陆爷那边差人送了句话。”老赵又说：“人已经走了。”',
    checks: {
      review: {
        issues: [{ severity: 'warn', type: 'character', message: '老赵是人物卡外的新名字，且两次开口', why: '老赵是人物卡外的新名字，与规则冲突' }],
      },
    },
  });
  const r = fullCheck(s, b.id);
  assert.equal(r.summary.warn, 0, JSON.stringify(r.poison));
});
