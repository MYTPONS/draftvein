/**
 * 规则质检：不依赖模型，纯文本统计 + 词表。
 * 目标是挡住"读起来像模型总结稿"的文本，而不是做文学评价。
 */

export interface Issue {
  severity: 'block' | 'warn' | 'info';
  type: string;
  message: string;
  quote?: string;
  fix?: string;
}

export interface QualityReport {
  score: number;
  words: number;
  issues: Issue[];
  stats: {
    paragraphs: number;
    avgParagraph: number;
    paragraphCv: number;
    dialogueRatio: number;
    bannedHits: number;
    repeatedOpeners: number;
    repeatRatio: number;
    maxDialogueRun: number;
    maxDialogueParagraphRun: number;
    dialogueParagraphRatio: number;
    narrationRatio: number;
    concreteDetailPerK: number;
    placeAnchored: boolean;
    baPerK: number;
    jargonPerK: number;
    properNameStartRatio: number;
    officialeseHits: number;
    explanatoryHits: number;
    techAcronymHits: number;
    techTermPerK: number;
    oneSentenceRatio: number;
    exclamation: number;
    ellipsis: number;
  };
}

export const BANNED_PHRASES = [
  '仿佛',
  '似乎',
  '不由得',
  '不禁',
  '嘴角微微上扬',
  '嘴角上扬',
  '眼中闪过一丝',
  '瞳孔骤缩',
  '心中一凛',
  '心中一震',
  '空气中弥漫',
  '与此同时',
  '命运的齿轮',
  '这一刻',
  '就在这时',
  '深吸一口气',
  '缓缓开口',
  '淡淡地说',
  '轻描淡写',
  '不容置疑',
  '若有所思',
  '意味深长',
  '难以言喻',
  '莫名',
  '一丝',
  '一抹',
];

const SUMMARY_ENDINGS = ['知道', '明白', '意味着', '从此', '注定', '开始了', '拉开了序幕', '一切都'];

/** musts 契约：每条都必须能在正文里找到（忽略标点空白） */
export function missingMusts(musts: string[], text: string): string[] {
  const norm = (x: string) => String(x).replace(/[\s“”"'‘’「」『』，,。.！!？?；;：:、—\-…（）()【】\[\]]/g, '').toLowerCase();
  const body = norm(text);
  const covered = (seg: string) => {
    if (seg.length < 2) return false;
    if (body.includes(seg)) return true;
    if (seg.length < 3) return false;
    const grams: string[] = [];
    for (let i = 0; i + 2 <= seg.length; i++) grams.push(seg.slice(i, i + 2));
    const hit = grams.filter((g) => body.includes(g)).length;
    return hit / grams.length >= 0.5;
  };
  return (musts || []).filter((m) => {
    if (!m) return false;
    const t = norm(m);
    if (!t) return false;
    if (body.includes(t)) return false;
    // 按"的/在/把/那句/将"等切段，任一段落被覆盖就算兑现（模型不会逐字复述）
    const segs = t.split(/[的在了把将那句这那]/).filter((x) => x.length >= 2);
    return !segs.some((seg) => covered(seg));
  });
}

export function countWords(text: string): number {
  return (text || '').replace(/\s+/g, '').length;
}

export function paragraphsOf(text: string): string[] {
  return (text || '')
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function dialogueRatio(text: string): number {
  const all = countWords(text) || 1;
  const quoted = [...(text || '').matchAll(/[“"]([^”"]{2,})[”"]/g)].reduce((n, m) => n + countWords(m[1]), 0);
  return quoted / all;
}

export interface QualityOptions {
  targetWords: number;
  /** 最近几章正文，用于跨章重复检测 */
  previous?: string[];
  /** 本场景计划地点；用于抓“人物站在虚空里聊天” */
  requiredPlace?: string;
  /** 上一场景地点；换场时要出现位移或转场锚点 */
  previousPlace?: string;
  /** 当前场景序号，从 1 开始 */
  sceneIndex?: number;
  /** 整章必须覆盖的计划地点，用于抓地点坍缩 */
  plannedPlaces?: string[];
  /** 本章 POV；用于抓“全名开头+全知报告” */
  pov?: string;
  cast?: string[];
  /** mock 演示文本不参与“真实模型可读性”闸门；真实 provider 始终启用 */
  skipNarrativeChecks?: boolean;
}

const CONCRETE_DETAIL_RE = /门|窗|桌|椅|柜|纸|灯|碗|杯|袋|绳|街|巷|院|楼|屋|房|桥|雨|雪|风|雾|声音|脚步|味道|光|影子/g;
const MOVE_RE = /走到|来到|赶到|回到|进了|出了|绕过|穿过|推开|拐进|走向|奔向|退到|停在|上车|下车|换到|挪到|移到|跨过|沿着/;
const OFFICIALESE_RE = /随即|随后|此时|此刻|当即|于是|遂|经查|据查|涉案|予以|进行|确认|目前|此案|本案|现场情况|有关情况/g;
const EXPLANATORY_RE = /他不知道的是|事实上|实际上|也就是说|这意味着|换句话说|从某种意义上|不难看出|由此可见|显然/g;
const TECH_ACRONYM_RE = /\b[A-Z][A-Z0-9-]{1,}\b/g;
const TECH_TERM_RE = /系统|数据|协议|接口|参数|指标|日志|状态|监控|架构|链路|请求|响应|服务|部署|集群|节点|延迟|吞吐|带宽|缓存|索引|事务|线程/g;
const FLOATING_SOUND_RE = /(?:身后|门外|远处|楼上|窗外|巷口|隔壁)[^。！？]{0,24}(?:传来|响起|响了一声)[^。！？]{0,50}[，,][^。！？]{0,36}(?:单一|一颗|一下|又没|没再)/;

function quotedChars(text: string): number {
  return [...String(text || '').matchAll(/[“"]([^”"\n]*)[”"]/g)].reduce((n, m) => n + countWords(m[1]), 0);
}

function normalizePlace(s: string): string {
  return String(s || '').replace(/[\s，,。.、；;：:！!？?“”"'（）()【】\[\]—\-]/g, '');
}

function placeMentioned(text: string, place?: string): boolean {
  const raw = String(place || '');
  const p = normalizePlace(raw);
  if (!p || p === '未定') return true;
  const body = normalizePlace(text);
  const candidates = new Set<string>([p]);
  for (const segment of raw.split(/[，,、；;/]+/).map(normalizePlace).filter((x) => x.length >= 2)) {
    candidates.add(segment);
    candidates.add(segment.slice(0, 2));
    candidates.add(segment.slice(-2));
    for (let i = 0; i + 2 <= segment.length; i++) candidates.add(segment.slice(i, i + 2));
  }
  return [...candidates].some((candidate) => candidate.length >= 2 && body.includes(candidate));
}

export function inspect(text: string, opts: QualityOptions): QualityReport {
  const issues: Issue[] = [];
  const body = text || '';
  const words = countWords(body);
  const paras = paragraphsOf(body);
  const target = opts.targetWords || 2600;

  const paraLens = paras.map(countWords);
  const avgParagraph = paraLens.length ? paraLens.reduce((a, b) => a + b, 0) / paraLens.length : 0;
  const variance = paraLens.length
    ? paraLens.reduce((a, b) => a + (b - avgParagraph) ** 2, 0) / paraLens.length
    : 0;
  const paragraphCv = avgParagraph ? Math.sqrt(variance) / avgParagraph : 0;

  // 1. 字数
  const ratio = words / target;
  if (ratio < 0.75) {
    issues.push({ severity: 'block', type: 'length', message: `字数 ${words}，低于目标 ${target} 的 75%`, fix: '补场景：不要靠形容词堆，补一个具体事件或对话回合' });
  } else if (ratio > 1.3) {
    issues.push({ severity: 'warn', type: 'length', message: `字数 ${words}，超过目标 ${target} 的 130%，可能注水`, fix: '删掉重复动作与解释性句子' });
  }

  // 2. 套话词表
  let bannedHits = 0;
  const hitList: string[] = [];
  for (const phrase of BANNED_PHRASES) {
    const n = body.split(phrase).length - 1;
    if (n > 0) {
      bannedHits += n;
      hitList.push(`${phrase}×${n}`);
    }
  }
  const bannedPerK = (bannedHits / Math.max(words, 1)) * 1000;
  if (bannedHits >= 6 || bannedPerK > 2.4) {
    const sentences = body.split(/(?<=[。！？])/).map((x) => x.trim()).filter(Boolean);
    const bad = sentences.filter((x) => BANNED_PHRASES.some((w) => x.includes(w))).slice(0, 4);
    issues.push({
      severity: 'block',
      type: 'slop',
      message: `套话/口头禅命中 ${bannedHits} 次（${bannedPerK.toFixed(1)}/千字）：${hitList.slice(0, 8).join('、')}`,
      quote: bad[0],
      fix: '把套话换成具体动作或具体物象；情绪用行为写，不要直接命名',
    });
    for (const b of bad.slice(1)) {
      issues.push({ severity: 'warn', type: 'slop', message: '同一类套话', quote: b, fix: '改成具体动作' });
    }
  } else if (bannedHits >= 3) {
    issues.push({ severity: 'warn', type: 'slop', message: `套话命中 ${bannedHits} 次：${hitList.join('、')}` });
  }

  // 3. 段首重复
  let repeatedOpeners = 0;
  const openers = new Map<string, number>();
  for (const p of paras) {
    const key = p.slice(0, 2);
    if (key.length < 2) continue;
    openers.set(key, (openers.get(key) || 0) + 1);
  }
  for (const [, n] of openers) if (n >= 4) repeatedOpeners += n - 3;
  if (repeatedOpeners > 2) {
    issues.push({
      severity: 'warn',
      type: 'rhythm',
      message: `段首两字重复过多（${repeatedOpeners} 次超限）`,
      fix: '换段首结构：把动作/对白/环境交替开场',
    });
  }

  // 3.5 一句一段（碎句文）
  const oneSentenceParas = paras.filter((p) => (p.match(/[。！？]/g) || []).length <= 1).length;
  const oneRatio = paras.length ? oneSentenceParas / paras.length : 0;
  if (paras.length >= 10 && oneRatio > 0.5) {
    issues.push({
      severity: oneRatio > 0.6 ? 'block' : 'warn',
      type: 'rhythm',
      message: `${Math.round(oneRatio * 100)}% 的段落只有一句话，读起来像碎句文`,
      fix: '把相邻的两三句并成一段；全章一句一段最多留 3 处做重锤',
    });
  }

  // 4. 段落节奏
  if (paras.length >= 6 && paragraphCv < 0.35) {
    issues.push({
      severity: 'warn',
      type: 'rhythm',
      message: `段落长度过于均匀（变异系数 ${paragraphCv.toFixed(2)}）`,
      fix: '长短交错：插入 1-2 个极短段（一句一段）',
    });
  }

  // 5. 对话比（过低/过高都算问题）
  const dRatio = dialogueRatio(body);
  const quotePer = paras.map((p) => {
    const q = quotedChars(p);
    return { q, ratio: q / Math.max(1, countWords(p)) };
  });
  const dialogueParagraphFlags = quotePer.map((x) => x.q > 0);
  let maxDialogueParagraphRun = 0;
  let dialogueParagraphRun = 0;
  for (const hasDialogue of dialogueParagraphFlags) {
    dialogueParagraphRun = hasDialogue ? dialogueParagraphRun + 1 : 0;
    maxDialogueParagraphRun = Math.max(maxDialogueParagraphRun, dialogueParagraphRun);
  }
  const dialogueParagraphRatio = dialogueParagraphFlags.filter(Boolean).length / Math.max(1, paras.length);
  const narrationRatio = 1 - dRatio;
  const concreteHits = (body.match(CONCRETE_DETAIL_RE) || []).length;
  const concreteDetailPerK = concreteHits / Math.max(words / 1000, 1);
  const baPerK = ((body.match(/把/g) || []).length / Math.max(words, 1)) * 1000;
  const jargonPerK = (body.match(TECH_TERM_RE) || []).length / Math.max(words / 1000, 1);
  const cast = [...(opts.cast || []), ...(opts.pov ? [opts.pov] : [])].filter(Boolean).sort((a, b) => b.length - a.length);
  const properNameStarts = paras.filter((p) => cast.some((name) => p.startsWith(name))).length;
  const properNameStartRatio = properNameStarts / Math.max(1, paras.length);
  const officialeseHits = (body.match(OFFICIALESE_RE) || []).length;
  const explanatoryHits = (body.match(EXPLANATORY_RE) || []).length;
  const techAcronymHits = (body.match(TECH_ACRONYM_RE) || []).length;
  const techTermHits = (body.match(TECH_TERM_RE) || []).length;
  const techTermPerK = (techTermHits / Math.max(words, 1)) * 1000;
  const floatingSound = FLOATING_SOUND_RE.test(body);
  const requiredPlace = String(opts.requiredPlace || '');
  const headWindow = body.slice(0, Math.min(body.length, Math.max(160, Math.floor(body.length * 0.35))));
  const placeAnchored = !requiredPlace || requiredPlace === '未定' || placeMentioned(headWindow, requiredPlace);

  const reportSignals = [
    baPerK > 14,
    properNameStartRatio > 0.45,
    jargonPerK > 18,
    officialeseHits >= 4,
    explanatoryHits >= 2,
  ].filter(Boolean).length;
  if (!opts.skipNarrativeChecks && words >= 200 && reportSignals >= 2) {
    issues.push({
      severity: 'block',
      type: 'voice',
      message: `叙事像流程报告/资料说明：全名开头 ${Math.round(properNameStartRatio * 100)}%，把字句 ${baPerK.toFixed(1)}/千字，行业术语 ${jargonPerK.toFixed(1)}/千字`,
      fix: '改回贴身第三人称：写 POV 此刻想干什么、怕什么、看错了什么；少列物件和流程，术语换成普通人会说的词',
    });
  } else if (!opts.skipNarrativeChecks && words >= 200 && reportSignals >= 1) {
    issues.push({ severity: 'warn', type: 'voice', message: `有报告腔苗头（全名开头 ${Math.round(properNameStartRatio * 100)}%，术语 ${jargonPerK.toFixed(1)}/千字）` });
  }

  if (!opts.skipNarrativeChecks && floatingSound) {
    issues.push({
      severity: 'block',
      type: 'voice',
      message: '声景没有明确来源或人物动作，像在用半截句硬拗余味',
      quote: paras.find((p) => FLOATING_SOUND_RE.test(p))?.slice(0, 120),
      fix: '把声音落到具体人物动作上：谁在做什么、为什么停，或者删掉这段气氛',
    });
  }

  if (!opts.skipNarrativeChecks && words >= 120 && (techAcronymHits >= 3 || techTermPerK > 28)) {
    issues.push({
      severity: 'block',
      type: 'voice',
      message: `技术术语密度过高（缩写 ${techAcronymHits} 个，技术词 ${techTermPerK.toFixed(1)}/千字），像在教读者学设备`,
      quote: paras.find((p) => (p.match(TECH_ACRONYM_RE) || []).length >= 2 || (p.match(TECH_TERM_RE) || []).length >= 3)?.slice(0, 120),
      fix: '删掉不影响人物选择的术语，只写它造成的后果。读者是来看故事的，不是来学系统原理',
    });
  } else if (!opts.skipNarrativeChecks && words >= 120 && (techAcronymHits >= 2 || techTermPerK > 18)) {
    issues.push({ severity: 'warn', type: 'voice', message: `技术信息偏多（缩写 ${techAcronymHits} 个，技术词 ${techTermPerK.toFixed(1)}/千字），建议改成人物遭遇的后果` });
  }

  if (!opts.skipNarrativeChecks && (maxDialogueParagraphRun >= 4 || (paras.length >= 8 && dialogueParagraphRatio > 0.6))) {
    issues.push({
      severity: 'block',
      type: 'dialogue',
      message: `含对白的段落占 ${Math.round(dialogueParagraphRatio * 100)}%，最长连续 ${maxDialogueParagraphRun} 段，像在隔空对台词`,
      fix: '把至少一半对话改成动作、环境、物件变化和人物位移；每两段对话之间必须落回现场',
    });
  } else if (!opts.skipNarrativeChecks && (maxDialogueParagraphRun === 3 || dialogueParagraphRatio > 0.7)) {
    issues.push({ severity: 'warn', type: 'dialogue', message: `对白段落偏密（${Math.round(dialogueParagraphRatio * 100)}%），需要更多叙述推进` });
  }

  if (!opts.skipNarrativeChecks && paras.length >= 6 && narrationRatio < 0.45) {
    issues.push({
      severity: 'block',
      type: 'dialogue',
      message: `叙述只占 ${Math.round(narrationRatio * 100)}%，场景、动作和结果都被对话挤掉了`,
      fix: '补具体场景和动作：谁从哪来、手里拿着什么、说完这句话局面发生了什么变化',
    });
  }

  if (!opts.skipNarrativeChecks && !placeAnchored) {
    issues.push({
      severity: 'block',
      type: 'scene',
      message: `场景开头没有交代计划地点「${requiredPlace || '未定'}」，读者会不知道人物站在哪里`,
      quote: paras[0]?.slice(0, 80),
      fix: `第一段先落到「${requiredPlace || '计划地点'}」：谁在哪、手边有什么、正在做什么`,
    });
  }

  if (!opts.skipNarrativeChecks && (opts.sceneIndex || 1) > 1 && opts.previousPlace && requiredPlace && opts.previousPlace !== requiredPlace && !MOVE_RE.test(headWindow)) {
    issues.push({
      severity: 'block',
      type: 'scene',
      message: `从「${opts.previousPlace}」到「${requiredPlace}」没有位移或转场，像瞬移`,
      quote: paras[0]?.slice(0, 80),
      fix: '用走路、推门、上车、拐巷、跨院等动作把上一场接到本场',
    });
  }

  const missingPlaces = (opts.plannedPlaces || []).filter((p) => p && p !== '未定' && !placeMentioned(body, p));
  if (!opts.skipNarrativeChecks && missingPlaces.length) {
    issues.push({
      severity: 'block',
      type: 'scene',
      message: `本章计划地点没有落地：${missingPlaces.join('、')}`,
      fix: '按节拍真正写到这些地点，或在规划阶段合并地点，不能只在同一张桌边换话题',
    });
  }

  // 连续纯对白段落
  let maxDialogueRun = 0;
  let run = 0;
  for (const p of paras) {
    const quoted = [...p.matchAll(/[“"]([^”"]{1,})[”"]/g)].reduce((n, m) => n + m[1].replace(/\s/g, '').length, 0);
    const isDialogue = quoted > 0 && quoted / Math.max(1, p.replace(/\s/g, '').length) > 0.8;
    run = isDialogue ? run + 1 : 0;
    maxDialogueRun = Math.max(maxDialogueRun, run);
  }
  if (maxDialogueRun >= 3) {
    issues.push({
      severity: 'block',
      type: 'dialogue',
      message: `连续 ${maxDialogueRun} 段纯对白，没有动作和环境，读者会看不清谁在哪`,
      fix: '对白之间插动作：谁递了什么东西、谁在看哪里、桌上有什么',
    });
  }
  if (paras.length >= 8 && dRatio > 0.55) {
    issues.push({
      severity: 'warn',
      type: 'dialogue',
      message: `对白占比 ${(dRatio * 100).toFixed(0)}%，叙述太少，剧情容易糊`,
      fix: '把一部分对话改成动作叙述：谁做了什么、东西怎么移动、局面怎么变',
    });
  }
  if (paras.length >= 8 && dRatio < 0.03 && dialogueParagraphRatio < 0.15) {
    issues.push({
      severity: 'warn',
      type: 'dialogue',
      message: `对白占比 ${(dRatio * 100).toFixed(0)}%，几乎全程叙述`,
      fix: '至少加一段一来一回的真实对话，允许打断和答非所问',
    });
  }

  // 6. 标点密度
  const exclamation = (body.match(/！/g) || []).length;
  const ellipsis = (body.match(/……|\.\.\./g) || []).length;
  if (exclamation > Math.max(2, words / 900)) {
    issues.push({ severity: 'warn', type: 'punct', message: `感叹号 ${exclamation} 个，情绪过载` });
  }
  if (ellipsis > Math.max(2, words / 600)) {
    issues.push({ severity: 'warn', type: 'punct', message: `省略号 ${ellipsis} 个，拖沓` });
  }

  // 7. 章末总结/抒情拔高
  const tail = paras.slice(-2).join('');
  if (tail && SUMMARY_ENDINGS.some((w) => tail.includes(w)) && tail.length < 220) {
    issues.push({
      severity: 'warn',
      type: 'ending',
      message: '章末落在总结/抒情句上',
      quote: tail.slice(-60),
      fix: '结尾改成具体动作、未完成的对话，或一个新出现的物件',
    });
  }

  // 8. 跨章重复：用 12 字 shingle 比重叠率（比整句比对稳，不受引号断句影响）
  const prev = (opts.previous || []).join('\n');
  let repeatRatio = 0;
  let repeatSample = '';
  if (prev) {
    const gram = 12;
    const shingles = (text: string) => {
      const t = String(text).replace(/\s+/g, '');
      const set = new Set<string>();
      for (let i = 0; i + gram <= t.length; i += 4) set.add(t.slice(i, i + gram));
      return set;
    };
    const prevSet = shingles(prev);
    const cur = shingles(body);
    if (cur.size >= 25) {
      let hit = 0;
      for (const g of cur) if (prevSet.has(g)) { hit++; if (!repeatSample) repeatSample = g; }
      repeatRatio = hit / cur.size;
      if (repeatRatio > 0.15) {
        issues.push({
          severity: 'block',
          type: 'repeat',
          message: `与最近章节文本重叠 ${(repeatRatio * 100).toFixed(0)}%（12 字片段重合），像在复读`,
          quote: repeatSample,
          fix: '换场景细节与人物反应，不要复用同一批描写句',
        });
      } else if (repeatRatio > 0.08) {
        issues.push({ severity: 'warn', type: 'repeat', message: `与最近章节文本重叠 ${(repeatRatio * 100).toFixed(0)}%，注意别复读` });
      }
    }
  }

  const blockCount = issues.filter((i) => i.severity === 'block').length;
  const warnCount = issues.filter((i) => i.severity === 'warn').length;
  const score = Math.max(0, 100 - blockCount * 25 - warnCount * 6);

  return {
    score,
    words,
    issues,
    stats: {
      paragraphs: paras.length,
      avgParagraph: Math.round(avgParagraph),
      paragraphCv: Number(paragraphCv.toFixed(2)),
      dialogueRatio: Number(dRatio.toFixed(2)),
      bannedHits,
      repeatedOpeners,
      repeatRatio: Number(repeatRatio.toFixed(3)),
      maxDialogueRun,
      maxDialogueParagraphRun,
      dialogueParagraphRatio: Number(dialogueParagraphRatio.toFixed(2)),
      narrationRatio: Number(narrationRatio.toFixed(2)),
      concreteDetailPerK: Number(concreteDetailPerK.toFixed(1)),
      placeAnchored,
      baPerK: Number(baPerK.toFixed(1)),
      jargonPerK: Number(jargonPerK.toFixed(1)),
      properNameStartRatio: Number(properNameStartRatio.toFixed(2)),
      officialeseHits,
      explanatoryHits,
      techAcronymHits,
      techTermPerK: Number(techTermPerK.toFixed(1)),
      oneSentenceRatio: Number(oneRatio.toFixed(2)),
      exclamation,
      ellipsis,
    },
  };
}

export function shouldKeepRepair(before: string, after: string, opts: QualityOptions, targetedQuotes: string[] = []): boolean {
  if (!after || after === before) return false;
  const a = inspect(before, opts);
  const b = inspect(after, opts);
  const targetedGone = targetedQuotes.filter(Boolean).every((q) => !after.includes(q));
  if (b.stats.bannedHits < a.stats.bannedHits) return true;
  return targetedGone && b.score >= a.score - 5;
}
