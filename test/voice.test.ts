import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db/index.ts';
import { createBook } from '../src/engine/book.ts';
import { ensureVoiceProfile, readVoiceProfile } from '../src/engine/voice.ts';
import { buildContext } from '../src/engine/context.ts';
import { scenePrompt } from '../src/engine/prompts.ts';

function fakeLlm(profiles: any[]) {
  let n = 0;
  const calls: string[] = [];
  return {
    calls,
    cfg: { provider: 'mock' },
    json: async (prompt: string) => {
      calls.push(prompt);
      const profile = profiles[Math.min(n++, profiles.length - 1)];
      return profile;
    },
  } as any;
}

const PROFILE_A = {
  narrator: '贴身第三人称，贴着查案人的误判走',
  tone: '冷硬但不装腔，偶尔有一点干笑',
  diction: '口语、短词，行业词能不用就不用',
  rhythm: '短段和动作段交错，不用连续排比',
  dialogue: '对话短，允许打断，不说完整解释',
  imagery: '只用会硌手、挡路、发潮的物件',
  signature: '线索总先让主角理解错一次',
  avoid: ['档案腔', '全知旁白', '每段都用全名开头'],
  sample: '铜钱在掌心里凉了一下。陆秉文以为是自己手汗，捏了两下，才发现钱边比刚才更压手。',
};

const PROFILE_B = {
  narrator: '第一人称近景，主角嘴硬但心里发虚',
  tone: '市井、急躁、带一点自嘲',
  diction: '大白话和短促对白，不端着',
  rhythm: '一句顶一句，偶尔突然停住',
  dialogue: '对话带抢话和答非所问，不解释背景',
  imagery: '票根、鞋泥、凉茶这些日常东西',
  signature: '每次以为占便宜，实际上先吃亏',
  avoid: ['江湖腔', '史官腔', '物件清单'],
  sample: '我先把票根塞进鞋底，又觉得不保险。那伙计一直看我脚，笑得跟捡了钱似的。',
};

const PROFILE_TECH = {
  narrator: '贴身第三人称，跟着一线工程师的排障过程走',
  tone: '高压、克制、带一点技术人的黑色幽默',
  diction: '技术词可以用，但必须先让读者看见后果，再给名字',
  rhythm: '短句报状态，故障扩散时句长逐渐变短',
  dialogue: '对话像工单交接，打断多，少解释，多报数字和现象',
  imagery: '机房热风、告警灯、延迟曲线、服务器风扇、咖啡渍',
  signature: '每次以为找到根因，都会发现只是下一个故障的表象',
  avoid: ['百科说明', 'PPT 式技术架构介绍', '全知旁白'],
  terminology: '术语预算：高。技术词可多用，但每个词必须绑定现象、代价或操作；不要写百科解释',
  sample: '告警又跳了一遍，QPS 掉到 17。我盯着延迟曲线，尾巴还在往上翘，像有人在链路另一头不停拽绳子。',
};

test('每本书生成并保存自己的叙事声纹', async () => {
  const s = new Store(':memory:');
  const llm = fakeLlm([PROFILE_A]);
  const book = createBook(s, { title: '铜钱案', genre: '悬疑', premise: '一枚铜钱在查案时变重' });
  const updated = await ensureVoiceProfile(s, llm, book);

  const profile = readVoiceProfile(updated);
  assert.equal(profile?.tone, PROFILE_A.tone);
  assert.match(profile?.sample || '', /铜钱/);
  assert.equal(JSON.parse(updated.data).voiceProfile.narrator, PROFILE_A.narrator);

  const ctx = buildContext(s, updated, 1, undefined);
  assert.match(ctx.style, /本书专属声纹/);
  assert.match(ctx.style, /冷硬但不装腔/);
  assert.equal(ctx.styleSample, PROFILE_A.sample);
});

test('声纹已存在时不会每次写作都重复生成', async () => {
  const s = new Store(':memory:');
  const llm = fakeLlm([PROFILE_A, PROFILE_B]);
  const book = createBook(s, { title: '铜钱案', genre: '悬疑', premise: '一枚铜钱在查案时变重' });
  const first = await ensureVoiceProfile(s, llm, book);
  const second = await ensureVoiceProfile(s, llm, first);
  assert.equal(llm.calls.length, 1);
  assert.equal(readVoiceProfile(second)?.tone, PROFILE_A.tone);
});

test('两本不同书使用不同声纹，场景提示词不再塞入同一段固定范文', async () => {
  const s = new Store(':memory:');
  const llm = fakeLlm([PROFILE_A, PROFILE_B]);
  const a = await ensureVoiceProfile(s, llm, createBook(s, { title: '铜钱案', genre: '悬疑', premise: '警探查一枚变重的铜钱' }));
  const b = await ensureVoiceProfile(s, llm, createBook(s, { title: '借命票', genre: '都市', premise: '外卖员捡到一张能借命的票根' }));
  const ca = buildContext(s, a, 1, undefined);
  const cb = buildContext(s, b, 1, undefined);

  assert.notEqual(ca.style, cb.style);
  assert.notEqual(ca.styleSample, cb.styleSample);
  const prompt = scenePrompt({
    ctx: cb,
    chapterIdx: 1,
    planTitle: '第一张票',
    planGoal: '把票根送出去',
    beatIndex: 0,
    beatTotal: 3,
    beat: { place: '城中村楼下', present: ['主角'], action: '发现票根沾血', shift: '知道票根不是自己的' },
    writtenSoFar: '',
    targetWords: 600,
    pov: '主角',
  });
  assert.doesNotMatch(prompt, /沈砚|老刀|名单压在茶碗/);
  assert.match(prompt, /票根、鞋泥、凉茶/);
});

test('科技流使用本书自己的术语预算，不再被统一限制为最多两个术语', async () => {
  const s = new Store(':memory:');
  const llm = fakeLlm([PROFILE_TECH]);
  const book = await ensureVoiceProfile(s, llm, createBook(s, { title: '零号机房', genre: '科幻', premise: '核心机房故障每十分钟重启一次，工程师发现故障在追着人走' }));
  const ctx = buildContext(s, book, 1, undefined);
  assert.match(ctx.style, /术语预算：高/);
  const prompt = scenePrompt({
    ctx,
    chapterIdx: 1,
    planTitle: '第三次重启',
    planGoal: '找出告警源头',
    beatIndex: 0,
    beatTotal: 3,
    beat: { place: 'A3 机房', present: ['主角'], action: '定位异常机柜', shift: '发现告警跟人移动' },
    writtenSoFar: '',
    targetWords: 600,
    pov: '主角',
  });
  assert.match(prompt, /术语预算/);
  assert.doesNotMatch(prompt, /行业术语、旧称、官称最多 2 个/);
});
