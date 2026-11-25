import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect, countWords, dialogueRatio, missingMusts, shouldKeepRepair } from '../src/engine/quality.ts';

const clean = `他把名单折成四折，塞进内袋。\n\n巷口的灯坏了三盏，只剩最里面那盏还亮。\n\n“东西呢？”\n\n“急什么。”他从袖子里抽出纸包，没递过去，先自己看了一眼。\n\n对方伸手来拿，他把手收回去。“先说说，谁让你来的。”\n\n风把纸包吹得响了一下。那人没答，退后半步，鞋跟蹭到地上的碎玻璃。`;

test('countWords 只数非空白字符', () => {
  assert.equal(countWords('中文 12 3\n测试'), 7);
});

test('干净文本不报 block', () => {
  const r = inspect(clean, { targetWords: 120 });
  assert.equal(r.issues.filter((i) => i.severity === 'block').length, 0);
  assert.ok(r.score >= 70, `score=${r.score}`);
});

test('套话密集判 block', () => {
  const slop = '他仿佛看到了什么，似乎明白了，不由得一笑，嘴角微微上扬，眼中闪过一丝光，心中一凛，空气中弥漫着寒意，与此同时，这一刻，命运的齿轮开始转动。'.repeat(2);
  const r = inspect(slop, { targetWords: 200 });
  assert.ok(r.issues.some((i) => i.type === 'slop' && i.severity === 'block'));
  assert.equal(r.stats.bannedHits > 6, true);
});

test('跨章重复句判 block', () => {
  const prev = ['他把名单折成四折，塞进内袋。巷口的灯坏了三盏，只剩最里面那盏还亮。'];
  const r = inspect(clean, { targetWords: 120, previous: prev });
  assert.ok(r.issues.some((i) => i.type === 'repeat' && i.severity === 'block'), JSON.stringify(r.issues));
});

test('字数不足判 block', () => {
  const r = inspect('一句话。', { targetWords: 2000 });
  assert.ok(r.issues.some((i) => i.type === 'length' && i.severity === 'block'));
});

test('章末总结句被抓到', () => {
  const text = clean + '\n\n他知道，从今天起，一切都变了。';
  const r = inspect(text, { targetWords: 120 });
  assert.ok(r.issues.some((i) => i.type === 'ending'), JSON.stringify(r.issues.map((i) => i.type)));
});

test('对白占比可算', () => {
  const ratio = dialogueRatio(clean);
  assert.ok(ratio > 0 && ratio < 1, `ratio=${ratio}`);
});

test('一句一段的碎句文会被抓出来', () => {
  const sentences = ['他把门推开。','风灌进来。','灯灭了。','他摸到铜钱。','铜钱很重。','外面有人。','雨还没停。','巷子里有猫。','他数了三下。','门轴响了一声。','有人咳嗽。','他回头看了一眼。'];
  const text = sentences.map((s) => s + '\n\n').join('');
  const r = inspect(text, { targetWords: 200 });
  assert.ok(r.stats.oneSentenceRatio > 0.5);
  assert.ok(r.issues.some((i) => /碎句文/.test(i.message)), JSON.stringify(r.issues));
});

test('过半段落都是一句一段时直接打回，避免刻意断句', () => {
  const paras = Array.from({ length: 16 }, (_, i) => `第${i + 1}次，灯灭了。`);
  const text = paras.join('\n\n');
  const r = inspect(text, { targetWords: countWords(text) });
  assert.ok(r.issues.some((i) => i.severity === 'block' && /碎句|一句一段/.test(i.message)), JSON.stringify(r.issues));
});


test('musts 契约：缺项能被找出来', () => {
  assert.deepEqual(missingMusts(['铜钱', '三枚', '当铺门'], '他把铜钱放在桌上，数了三枚。'), ['当铺门']);
  assert.deepEqual(missingMusts(['铜钱'], '他把铜钱放在桌上。'), []);
});

test('带“他说”的对白墙也会被抓，不只看纯引号段落', () => {
  const text = [
    '沈砚抬眼说：“名单在哪？”',
    '老刀把茶碗放下，说：“你先说谁让你来的。”',
    '沈砚说：“我只问名单。”',
    '老刀说：“我也只问来路。”',
    '沈砚说：“那就没得谈了。”',
    '老刀说：“你走不出这条巷子。”',
    '沈砚说：“试试看。”',
    '老刀说：“你父亲当年也这么说过。”',
  ].join('\n\n');
  const r = inspect(text, { targetWords: 220 });
  assert.ok(r.stats.dialogueParagraphRatio >= 0.8, JSON.stringify(r.stats));
  assert.ok(r.stats.maxDialogueParagraphRun >= 8, JSON.stringify(r.stats));
  assert.ok(r.issues.some((i) => i.type === 'dialogue' && i.severity === 'block'), JSON.stringify(r.issues));
});

test('场景开头没有地点锚点会被打回', () => {
  const text = '他把茶碗推到桌子另一边。\n\n“名单呢？”老刀问。\n\n沈砚没有回答，只把手指压在纸角上。';
  const r = inspect(text, { targetWords: 120, requiredPlace: '衡记当铺后柜', sceneIndex: 1, previousPlace: '警局' });
  assert.ok(r.issues.some((i) => i.type === 'scene' && i.severity === 'block' && /地点/.test(i.message)), JSON.stringify(r.issues));
});

test('计划里的地点没有全部落地会被打回', () => {
  const text = '警局的窗纸被风吹得发响。顾行舟把两枚铜钱放在桌上，又用秤盘压住一张手令。\n\n“谁动过证物？”他问。\n\n老周没答，只把空证物袋翻过来，袋底有一圈圆压痕。';
  const r = inspect(text, { targetWords: 160, plannedPlaces: ['警局', '衡记当铺后柜'] });
  assert.ok(r.issues.some((i) => i.type === 'scene' && i.severity === 'block' && /衡记当铺后柜/.test(i.message)), JSON.stringify(r.issues));
});

test('短对白夹在厚叙述里，不应同时报“对白偏密”和“几乎全程叙述”', () => {
  const paras = Array.from({ length: 10 }, (_, i) => {
    const base = `巷口的雨水沿着砖缝流到门槛，顾行舟把第${i + 1}张当票压在秤盘边，指头抹开纸角的一层灰。`;
    return i % 2 === 0 ? `${base}“走。”老周说。` : `${base}门轴响了一声，屋里没人动。`;
  });
  const text = paras.join('\n\n');
  const r = inspect(text, { targetWords: countWords(text) });
  assert.ok(!r.issues.some((i) => i.type === 'dialogue' && i.severity === 'warn'), JSON.stringify(r.issues));
});

test('定点返工即使没有减少套话，只要目标原文被改掉且质量不崩，就应保留', () => {
  const before = '罗秉坤说：“二钱三分。”\n\n同段又说：“二钱五分。”\n\n何守拙把秤放下。';
  const after = '罗秉坤先称出自己的二钱三分，又在河堤复称成二钱五分，把两个数都记进账本。\n\n何守拙把秤放下。';
  assert.equal(
    shouldKeepRepair(before, after, { targetWords: 80 }, ['罗秉坤说：“二钱三分。”']),
    true,
  );
  assert.equal(shouldKeepRepair(before, before, { targetWords: 80 }, ['罗秉坤说：“二钱三分。”']), false);
});

test('档案腔/术语展览/全名开头刷屏会被判为叙事视角问题', () => {
  const paras = [
    '罗秉坤把戥子从验尸箱底层取出来，把秤盘搁在条凳上，把铜钱挂上秤钩。',
    '罗秉坤把铜钱从秤钩上摘下来，把绳结拉紧，把铜钱放回证物袋。',
    '罗秉坤把卷宗翻到第二页，把称重单压在卷宗旁边，把铜渣收回纸包。',
    '罗秉坤把验尸箱合上，把搭扣扣好，把箱子提到停尸台另一头。',
    '罗秉坤把短褂摊开，把油纸从夹层里抽出来，把半枚铜钱搁在草席上。',
    '罗秉坤把秤杆放平，把秤砣拨到三钱处，把铜钱重新挂上秤钩。',
    '罗秉坤把铜钱并上，把秤盘压住，把结果记在称重单最后一行。',
    '罗秉坤把门推开，把煤油灯挑亮，把巷口的雨水关在门外。',
  ];
  const r = inspect(paras.join('\n\n'), {
    targetWords: countWords(paras.join('\n\n')),
    pov: '罗秉坤',
    cast: ['罗秉坤', '何守拙', '汪子澄'],
  });
  assert.ok(r.issues.some((i) => i.type === 'voice' && i.severity === 'block'), JSON.stringify(r.issues));
});

test('计划地点和正文同义表达不应误判为没落地', () => {
  const text = '陆秉文站在当铺里头，柜台后只点着一盏灯。他把铜钱放在秤盘上，又看了一眼门外的雨。\n\n“谁来过？”他问。';
  const r = inspect(text, { targetWords: countWords(text), requiredPlace: '当铺柜台前', sceneIndex: 2, previousPlace: '后院' });
  assert.ok(!r.issues.some((i) => i.type === 'scene' && /计划地点/.test(i.message)), JSON.stringify(r.issues));
});

test('悬空声音和半截拟物动作会被判成硬拗余味', () => {
  const text = '身后传来算盘珠子响了一声，单单一颗，拨上去又没拨回来。他迈出门槛，裤兜里的铜钱硌着大腿。\n\n巷口有人收摊，木板一块块撞在一起。';
  const r = inspect(text, { targetWords: countWords(text) });
  assert.ok(r.issues.some((i) => i.type === 'voice' && i.severity === 'block' && /悬空|余味|动作/.test(i.message)), JSON.stringify(r.issues));
});

test('科技流术语堆叠会被判成说明书，而不是让读者学设备', () => {
  const text = [
    '陈默先记下 UPS 的输入电压，再看 PDU 的六路指示灯，又调出 BMS 的热通道曲线。',
    '屏幕上 QPS 掉到 17，failover 没有触发，MTTR 还在往上跳。',
    '他把 POST 日志、BMS 告警、PDU 负载和门禁接口状态逐条抄进巡检表。',
    '冷启动参数没有问题，缓存命中也没有问题，但 QPS 还在掉。',
    '他又打开 failover 配置，把 MTTR 的计算口径重新核对了一遍。',
  ].join('\n\n');
  const r = inspect(text, { targetWords: countWords(text) });
  assert.ok(r.issues.some((i) => i.type === 'voice' && i.severity === 'block' && /术语|说明书|知识/.test(i.message)), JSON.stringify(r.issues));
});
