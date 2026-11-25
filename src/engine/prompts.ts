import type { ContextPack } from './context.ts';

export const WRITER_SYSTEM = '你是小说作者。写人物眼前正在发生的故事，写人物想要什么、遇到什么阻力、做出什么选择、付出什么代价。读者不是来学知识：专业信息只写后果，不解释原理。语言自然、清楚、有具体感，不表演文风，不写说明文、报告腔，不靠碎句或特殊格式制造气氛。直接输出正文，不要标题、编号或 markdown。';

export function arcPrompt(input: { title: string; genre: string; premise: string; audience: string; currentChapter: number }): string {
  return `为下面这本书规划下一卷。只规划一卷，不要规划全书章节。

书名：${input.title}
题材：${input.genre || '未定'}
核心设定：${input.premise || '未定'}
目标读者：${input.audience || '未定'}
当前进度：写到第 ${input.currentChapter} 章

要求：
1. 这一卷要有明确的核心事件，不能只是事件流水账或日常合集；卷末必须有不可逆的改变。
2. 卷长 8-20 章，给出合理的起止章号。
3. 不要列章节标题，不要列每章内容。

只输出 JSON：
{"title":"卷名","premise":"这一卷要发生什么、主角的处境怎么变、卷末不可逆改变是什么","chapter_span":12}`;
}

export function castPrompt(input: { title: string; genre: string; premise: string; audience: string }): string {
  return `为这本书建立初始人物卡：1 个主角 + 2 个重要配角（其中至少 1 个对立面）。只要人物，不要剧情。

书名：${input.title}
题材：${input.genre || '未定'}
核心设定：${input.premise || '未定'}
目标读者：${input.audience || '未定'}

要求：
- 名字要像真人想起的，不要"龙傲天""苏小婉"这种模板名，不要生僻字。
- 每个人都有"异于常人的点"，不要写完美人设。
- speech 写说话方式（句长、用词、口头习惯），catchphrase 给一句能复用的口头禅。

只输出 JSON：
{"characters":[{"name":"","role":"protagonist|support|antagonist","identity":"","personality":"","goal":"","fear":"","speech":"","catchphrase":"","taboo":"","importance":5}]}`;
}

export interface PacingAdvice {
  neededIntensity: number;
  suggestTypes: string[];
  mustHook: boolean;
  note: string;
  golden?: string;
  dryStreak?: number;
}

export function voicePrompt(input: {
  title: string;
  genre: string;
  premise: string;
  audience: string;
  authorSample?: string;
  otherBooks?: string[];
}): string {
  return `为《${input.title}》建立只属于这本书的叙事声纹。不是选“风格标签”，而是决定读者翻开这本书时听到谁在讲、句子怎么走、哪些词绝不能出现。

题材：${input.genre || '未定'}
核心设定：${input.premise || '未定'}
目标读者：${input.audience || '未定'}
${input.authorSample ? `作者提供的文风样本：\n${input.authorSample}\n` : ''}

工作区内已有书（必须和它们拉开差异，不能写成同一体系外传）：
${(input.otherBooks || []).map((x) => `- ${x}`).join('\n') || '- 暂无其它书'}

要求：
- 先判断这本书更适合贴身第三人称、第一人称还是其它近景；不要默认全知旁白。
- 默认写正常的第三人称近景；第一人称、现在时、特殊格式只有在题材和主角处境强烈需要时才用，不能为了显得酷。
- 语气、句法、对话节奏、意象来源都要来自这本书自己的题材和人物处境，不要套现成的类型腔、年代腔或爆款模板。
- 每本书必须有一个能区分其它书的 signature：独特的误会、代价、叙事习惯或读者爽点。
- 不要设计奇技淫巧：不要靠一句一段、倒计时、特殊排版、重复句、第二人称或故意省略来表演风格。sample 要像正常连载小说，不要像文学实验。
- sample 必须原创 80-160 字，体现这本书的声纹，不要出现不属于本书的人名、地点或物件。
- avoid 写 3-6 条这本书最怕写成的腔调或套路。
- terminology 默认“低”或“低-中”。只有不用术语就没法说清人物正在遭遇什么时才用，而且每个术语必须立刻变成动作、损失或代价；除非用户明确要硬核技术细节，不要选“高”。

只输出 JSON：
{"narrator":"","tone":"","diction":"","rhythm":"","dialogue":"","imagery":"","terminology":"术语预算：低/中/高；什么术语可以用、必须绑定什么后果","signature":"","avoid":[""],"sample":""}`;
}

export function planPrompt(input: { ctx: ContextPack; chapterIdx: number; previousEnding: string; targetWords?: number; pacing?: PacingAdvice; usedTitles?: string[] }): string {
  const { ctx, chapterIdx } = input;
  const targetWords = input.targetWords || 2600;
  return `请只为第 ${chapterIdx} 章做策划，不要写正文，不要规划后面的章节。

${ctx.skeleton}

【当前卷】
${ctx.arc}

【已写到】
${ctx.recap}

【上一章结尾原文】
${ctx.tail}

【必须处理的线索】
${ctx.threads}

【已确立的硬事实】
${ctx.facts}

【人物卡（只能用这些名字，不许新造人名）】
${ctx.cast}

【文风要求】
${ctx.style}

【结构位置】
${input.pacing?.structure || '（未设置结构）'}

【参考写法】
${ctx.template || '（未绑定参考写法）'}

【这一章的商业要求（爽点/钩子）】
- 强度要求：至少 ${input.pacing?.neededIntensity ?? 3}/5，类型优先 ${(input.pacing?.suggestTypes || ['反转', '揭秘']).join('、')}
- 章末必须留钩子${input.pacing?.golden ? `\n- ${input.pacing.golden}` : ''}
- ${input.pacing?.note || '每章一个钩子，三章内至少一个强度≥4 的爆点'}
- 爆点要有铺垫：强度≥4 的，必须挂在一个已登记/本条新立的"期待"上（expectations_plant 立、expectations_pay 兑现，或在 highlights 里写 pays_code）。

要求：
1. 本章必须让"某件事真的发生"，并改变至少一个人的处境或信息差。
1.1 goal 必须写成四段式："谁 + 想做什么 + 被什么挡住 + 结果怎样"。写不出"谁想做什么"，说明这章没剧情。
1.2 第一个节拍必须承接上一章结尾的具体后果：上一章留下什么麻烦，本章开头就处理它。
1.3 每个节拍写 event 字段：一句话说清这个节拍发生了什么（谁做了什么、结果如何），不要写氛围。
1.6 beats 至少 3 个，且至少两个不同地点；整章只在一个地点发生会被打回。
1.7 pov 必须写清：这一章读者跟着谁的脑子走。这个人要有明确想做的事、怕失去的东西或判断错的地方；正文不许切全知旁白。
1.8 goal、synopsis、beats 都用日常话写，不写“案件情况”“有关人员”“现场情况”这类报告词。
1.4 先写 synopsis：3-5 句话，把本章的故事讲清楚（谁→要做什么→遇到什么→结果怎样→留下什么麻烦）。正文必须按这个梗概写，不许跑偏。
1.5 再写 musts：3-5 条"本章正文里必须出现"的具体东西（某个普通物件、某句台词、某个线索、某个动作），越具体越好，但不要故意塞稀有旧称/行业术语。
2. 3-5 个节拍，每个节拍写清：地点、在场人物、发生什么、谁的信息发生了变化。
3. 【必须处理的线索】里标【已过期·必须处理】的，本章必须给出回收或推进的具体方式；不许装作没看见。
4. 可以埋新线索，但本章最多埋 1 条，并且必须给出合理回收窗口（due_from / due_to 的章号）。
5. 标题要短（不超过 12 字），不要用"第X章"前缀，不要抒情。
6. 字数目标按每章 ${targetWords} 字左右。
7. characters 列出本章真正出场的人物名，必须来自人物卡；需要新角色就先在人物页建卡。
8. 标题不得与这些已用标题重复、也不要用同一意象换字：${(input.usedTitles || []).slice(-10).join('、') || '（还没有）'}
9. 每个爆点必须写 setup：这个爆点在前面哪一章埋的、埋的是什么；强度≥4 没有 setup 的计划会被打回。
10. 自造的词必须当场给出它的好处或代价，否则换成人话。
11. 普通读者一眼看不懂的旧称、官称、行业词不要进 musts，也不要用它们假装年代感。

只输出 JSON：
{"title":"","pov":"","characters":[],"goal":"","beats":[{"id":"b1","place":"","present":[],"action":"","shift":""}],
 "synopsis":["第1句","第2句","第3句"],
 "musts":["最多 4 条，每条 ≤14 字，只写具体的物/短台词/动作，不要一句话串好几件事"],
 "beats_event":["每个节拍的一句话事件"],
 "highlights":[{"kind":"hook|beat|climax","type":"打脸|反转|揭秘|突破|危机|情感|智斗|收获","intensity":1,"title":"这一下爆在哪","how":"怎么写出来","setup":"第几章埋的什么（强度≥4 必填）","pays_code":"兑现哪个期待（可空）"}],
 "expectations_plant":[{"code":"","type":"羞辱|立旗|约定|威胁|悬念|许诺","title":"","detail":"","strength":3,"due_from":null,"due_to":null}],
 "expectations_pay":["要兑现的期待 code"],
 "hook":"章末钩子一句话（读者看完想点下一章的理由）",
 "threads_payoff":[{"code":"","how":""}],"threads_advance":["code"],"threads_new":[{"code":"","title":"","detail":"","due_from":null,"due_to":null}],"word_target":2600}`;
}

export function scenePrompt(input: {
  ctx: ContextPack;
  chapterIdx: number;
  planTitle: string;
  planGoal: string;
  beatIndex: number;
  beatTotal: number;
  beat: { place?: string; present?: string[]; action?: string; shift?: string };
  writtenSoFar: string;
  targetWords: number;
  synopsis?: string;
  issues?: string[];
  previousPlace?: string;
  pov?: string;
}): string {
  const { ctx, chapterIdx, planTitle, planGoal, beatIndex, beatTotal, beat, writtenSoFar, targetWords, synopsis, issues, previousPlace, pov } = input;
  const soFarTail = writtenSoFar.replace(/\s+$/, '').slice(-700);
  const isLast = beatIndex === beatTotal - 1;
  const changedPlace = Boolean(previousPlace && beat.place && previousPlace !== beat.place);
  return `任务：写《${ctx.skeleton.match(/书名：(.+)/)?.[1] || ''}》第 ${chapterIdx} 章《${planTitle}》的第 ${beatIndex + 1}/${beatTotal} 个场景。

【本章梗概（正文必须实现它，不许跑偏）】
${(synopsis || '').trim() || '（无）'}

【本场景任务卡】
地点：${beat.place || '未定'}
在场：${(beat.present || []).join('、') || '未定'}
必须发生：${beat.action || ''}
结束时必须完成的信息变化：${beat.shift || ''}

【叙事视角】
${pov || '当前场景主视角人物'}。严格贴身第三人称：只写这个人物看见、听见、闻到、想到、误解和在意的东西。不要切成全知旁白，不要替所有人解释动机。

【上文（从这里直接接，不要重述）】
${soFarTail || '（本章开头）'}

【可用人物与设定（只在用到时取，不解释）】
${ctx.bible}
${ctx.related ? `\n【相关旧文（只供对账，不要抄写）】\n${ctx.related}\n` : ''}

【参考写法（照它的节奏写，不抄剧情）】
${ctx.template || '（无）'}

【本书声纹与文风】
${ctx.style}
${ctx.styleSample ? `\n【作者文风样本（学语感，不抄内容）】\n${ctx.styleSample}\n` : ''}

【这一场怎么写】
- 约 ${targetWords} 字。写一场戏，不要写流程报告、技术说明或背景汇报。
- 从人物正在做的事或遇到的麻烦开始。地点和身份在动作里自然露出来，不要先列环境、物品和流程。
${changedPlace ? `- 上一场在「${previousPlace}」，本场在「${beat.place}」。用一个人物动作自然转场，不要瞬移。\n` : ''}
- 这一场必须有人想要什么、被什么挡住、最后局面发生什么变化；不要只把计划里的动作逐条执行。
- **读者不是来学知识。** 技术、行业、历史信息只在影响人物时出现；能直接写它造成的后果，就不要解释原理或术语名称。
- 每 500 字最多 1-2 个专业词/缩写；术语一出现，必须在同一段内变成动作、损失或代价。不要连续堆缩写、参数、日志和指标。
- 语言自然、直接、有具体感。不要表演文风，不要每句话都塞物象，不要报告腔、说明文腔或模板腔，也不要无明确动作来源的声景和半截动作。
- 对话用来交锋、试探、拒绝，不用来解释设定。
- 结尾${isLast ? '留一个具体麻烦或刚出现的异常，不总结、不抒情' : '留一个下一场必须处理的麻烦'}。
${issues?.length ? `\n【上一稿被打回的原因，这次必须改掉】\n${issues.map((x) => `- ${x}`).join('\n')}\n` : ''}
直接输出正文，不要标题、不要编号、不要解释。`;
}

export function reviewPrompt(input: { ctx: ContextPack; chapterIdx: number; title: string; content: string }): string {
  return `你在做连载小说的编辑审稿。只评判，不改写。

【人物卡（正文中出现的人物必须在这里，说话方式要对得上）】
${input.ctx.cast}

【设定与硬事实】
${input.ctx.bible}
${input.ctx.facts}

【本书声纹（不能用通用腔调覆盖它）】
${input.ctx.style}

【本章】第 ${input.chapterIdx} 章《${input.title}》
${input.content}

逐项检查并只输出 JSON。要求：
- scores 每项给 1-10 的整数（9=很好，7=可发，5=要改），**不要填 0，不要照抄示例**。
- issues 最多 5 条，按严重程度排序；severity 只能是 block 或 warn；type 只能从 continuity/voice/pacing/info/slop/dialogue/character/poison 里选**一个**。
- quote 必须是正文里的原句（10-40 字），不要改写。

格式（值必须换成你的真实判断）：
{"verdict":"revise","scores":{"continuity":8,"voice":7,"pacing":7,"information":8,"anti_slop":8,"characters":8},
 "issues":[{"severity":"warn","type":"slop","quote":"正文原句","why":"为什么是问题","fix":"具体怎么改"}]}

标准：
- continuity：是否与上面的设定/硬事实冲突（人物死了又出现、知道了不该知道的事、时间线倒退）。
- voice：是否像人写的；有没有模型腔、套话、四字词堆叠。
- pacing：事件是否真的发生；有没有大段说明。
- information：本章是否推进了信息差；是否只是过渡。
- anti_slop：是否出现"总结式结尾""情绪命名""正确的废话"。
- characters：有没有人物卡之外的新名字、说话方式与人设不符、已经死亡/离场的人又出现。
- 信息泄露：如果人物说出了"作者真相"里读者尚不知道的事，type 用 continuity 给 block。
- 可复述性：读完这一章，读者能不能用一句话说出"谁为了什么做了什么，结果怎样"？说不出来就是 block，type 用 info。
- 对白是否过量：连续三段含对白、含对白段落超过一半、或叙述低于一半，type 用 dialogue 给 block。允许对话，但不允许用对话替代现场、动作和结果。
- 场景是否站得住：开头有没有明确地点和环境锚点；换地点有没有位移/转场；人物是不是悬在空中说话。违反任一项，type 用 dialogue 或 info 给 block。
- 是否像流程报告/资料说明：如果叙事只是“某人把 A 放下，又把 B 拿来”、连续用人物全名开头、堆行业术语或官称，type 用 voice 或 slop 给 block。小说要贴着 POV 人物的欲望、误判和代价走。
- 语言是否一眼能懂：稀有称谓、行话或专业词如果普通读者不知道、人物也没必要知道，type 用 voice 给 warn；为了显得专业而堆词，要求换回日常说法。
- 是否在硬拗余味：用无明确来源的声音、拟物动作或半截句制造气氛，却没有清楚的人物动作，type 用 voice 给 block。
- poison（毒点）：开篇或本章是否信息过载、造词、金手指没有给读者实际好处、无意义铺垫。
- 另外必须判断：本章有没有真正的"爽点/爆点"（打脸、反转、揭秘、突破、危机、智斗、收获之一，且强度≥3）？章末有没有钩子？没有就 block，并指出应该在哪里补。
问题超过 3 条或任一 block，verdict 给 revise。`;
}

export function extractPrompt(input: { ctx: ContextPack; chapterIdx: number; title: string; content: string }): string {
  return `从下面这章正文里抽取结构化事实。只根据正文，不要推测。

【本章】第 ${input.chapterIdx} 章《${input.title}》
${input.content}

【人物卡】
${input.ctx.cast}

【已有线索台账】
${input.ctx.threads}

输出 JSON：
{"summary":"3 句以内的本章剧情摘要，只写发生了什么",
 "facts":[{"kind":"fact|state|knowledge|item|death","subject":"人物或物","fact":"一句话硬事实","quote":"正文里支持这句话的原文片段（10-30字，必须原文）","tags":""}],
 "timeline":[{"scene":"本场景地点或编号（同一章不同地点要分开写）","story_time":"故事内时间","location":"","actors":"","event":""}],
 "character_updates":[{"name":"人物名","status":"alive|dead|missing","location":"","goal":"","note":"本章他/她的变化"}],
 "relation_updates":[{"from":"","to":"","relation":"一句话关系（如：决裂/结盟/互相利用）","note":""}],
 "highlights":[{"kind":"hook|beat|climax","type":"打脸|反转|揭秘|突破|危机|情感|智斗|收获","intensity":1,"title":"","quote":"正文原文片段（必须逐字存在）","setup_note":"本章爆点在前面哪一章埋了什么；没有就空","pays_code":"兑现的期待 code（没有就空）"}],
 "expectation_events":[{"code":"","action":"plant|fulfill|extend|abandon","type":"","title":"","detail":"","strength":3,"quote":"正文原文（plant/fulfill 必填，必须逐字存在）","due_from":null,"due_to":null,"note":""}],
 "thread_events":[{"code":"线索code","action":"plant|advance|payoff|abandon|extend","title":"新线索时必填","detail":"","quote":"正文原文片段，必须能在正文里逐字找到","due_from":null,"due_to":null,"note":""}]}

规则：
- quote 必须是正文里的连续原文片段，不能改写、不能拼接。这是用于核验的。
- 只有正文里真的发生了解答/揭示，才允许 action=payoff，并且 quote 要指向揭示的那句话。
- 如果本章只是提到线索但没推进，不要输出 advance。
- timeline 每条必须带 scene：同一章里换了地点就写不同 scene，否则会被判成"同一人同时出现在两地"。
- character_updates 只写本章真的发生变化的人（位置、目标、生死）。
- relation_updates 只写本章关系真的变了的那一对；没变就空数组。
- expectation_events：本章立了新期待就 plant（要有原文证据），兑现了就 fulfill（要指向兑现那句原文）；强度≥4 的爆点必须能对上某个期待。
- highlights：本章真正的爽点/爆点与章末钩子。hook 必须有且只有一条（章末那句）；beat/climax 按实际写，没有就空。intensity 1-5，别虚标。
- due_from / due_to 只填正整数；不知道就填 null。禁止填 0，0 不是“第0章”，会被当成坏数据。
- setup_note 只写正文之前已经发生的铺垫，引用必须和已有事实/章节一致；没有铺垫就留空，不要编。
- 没有新事实就给空数组。`;
}

export function repairPrompt(input: { issues: { quote?: string; why?: string; fix?: string }[]; content: string }): string {
  return `下面这段正文有几处需要修。只做定点替换，不要改别的。

【替换规则】
- 情绪词 → 身体动作、选择或人物正在处理的物件
- "仿佛/似乎" → 直接写眼前的具体现象
- 总结句 → 一个未完成的动作或一句没说完的话
- 连续同结构句 → 改成一句一段的短句

【原文】
${input.content}

【要修的地方】
${input.issues.map((i, n) => `${n + 1}. 原文片段：「${i.quote || ''}」问题：${i.why || ''} 改法：${i.fix || ''}`).join('\n')}

输出 JSON：
{"replacements":[{"old":"要被替换掉的原文（必须逐字来自原文）","new":"替换后的文字"}]}
只输出 JSON。`;
}
