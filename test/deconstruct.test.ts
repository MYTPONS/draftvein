import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db/index.ts';
import { deconstruct, saveTemplate, listTemplates, splitChapters, classifyEnding } from '../src/engine/deconstruct.ts';

const BOOK = `第一章 起
他把铜钱放在桌上，数了三遍。老刀说：“先别急。”门外有人敲了两下，停了。
他站起来，走到门口，手按在门闩上。

第二章 承
夜里下起了雨。顾九把伞收起来，靠在墙角。她问：“名单呢？”
他没答，从袖子里抽出一张纸，纸角起了毛。

第三章 转
天亮之前，第三个人来了。鞋底沾着泥，站在门槛外没进来。
“东西呢。”他说。
`;

test('拆章：按“第X章”切开', () => {
  const chs = splitChapters(BOOK);
  assert.equal(chs.length, 3);
  assert.ok(chs[0].includes('第一章'));
});

test('钩子分类能区分对白/动作/总结', () => {
  assert.equal(classifyEnding('他站在门口。\n“东西呢。”'), 'dialogue');
  assert.equal(classifyEnding('他把铜钱放进抽屉，锁上。'), 'action');
  assert.equal(classifyEnding('他知道，从今天起一切都变了。'), 'summary');
});

test('模板：统计字数/对白/钩子并落库', () => {
  const s = new Store(':memory:');
  const t = deconstruct({ name: '参考A', genre: '悬疑', source: 'x.txt', text: BOOK });
  assert.equal(t.chapters, 3);
  assert.ok(t.avg_words > 0);
  assert.ok(t.dialogue > 0);
  saveTemplate(s, t);
  const list = listTemplates(s);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, '参考A');
  const dist = JSON.parse(list[0].hook_dist);
  assert.ok(dist.dialogue >= 1);
});
