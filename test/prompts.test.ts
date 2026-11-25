import test from 'node:test';
import assert from 'node:assert/strict';
import { styleGuide } from '../src/engine/context.ts';
import { scenePrompt, voicePrompt } from '../src/engine/prompts.ts';

const ctx = {
  skeleton: '书名：测试书',
  arc: '',
  cast: '',
  related: '',
  bible: '',
  recap: '',
  tail: '',
  threads: '',
  facts: '',
  style: '',
  plan: '',
  styleSample: '',
  template: '',
  chars: 0,
};

test('默认文风不再把“每 400 字至少三句对白”当硬指标', () => {
  const style = styleGuide('default');
  assert.doesNotMatch(style, /每\s*400\s*字至少三句对白/);
  assert.match(style, /叙述|环境|动作/);
  assert.match(style, /一眼看懂|术语|档案腔/);
});

test('场景提示词要求人物麻烦、可读性和本书声纹', () => {
  const prompt = scenePrompt({
    ctx,
    chapterIdx: 2,
    planTitle: '押命一分',
    planGoal: '拿到当票',
    beatIndex: 1,
    beatTotal: 4,
    beat: { place: '衡记当铺后柜', present: ['顾行舟', '陆秉衡'], action: '顾行舟翻秤找夹层', shift: '两人摊牌' },
    writtenSoFar: '上一场在警局。',
    targetWords: 700,
    synopsis: '顾行舟去当铺查秤。',
    previousPlace: '警局',
  });
  assert.match(prompt, /本书声纹|本书声音/);
  assert.match(prompt, /上一场.*警局|从.*警局/);
  assert.match(prompt, /叙事视角/);
  assert.match(prompt, /读者.*不是.*学|不是.*学知识/);
  assert.match(prompt, /技术|专业/);
  assert.match(prompt, /后果|代价/);
  assert.match(prompt, /自然|不要表演/);
  assert.ok(prompt.length < 6000, `prompt too long: ${prompt.length}`);
});

test('声纹生成默认普通叙事，不设计奇技淫巧', () => {
  const prompt = voicePrompt({ title: '零号机房', genre: '科技惊悚', premise: '核心机房每十分钟重启', audience: '男频科幻' });
  assert.match(prompt, /默认.*第三人称|第三人称.*默认/);
  assert.match(prompt, /奇技淫巧|正常连载|不要表演/);
  assert.match(prompt, /一句一段|特殊排版|倒计时/);
});
