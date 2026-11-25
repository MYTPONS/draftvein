import type { LlmConfig } from '../config.ts';

export type MockKind = 'arc' | 'cast' | 'voice' | 'plan' | 'draft' | 'review' | 'extract' | 'rewrite' | 'plain';

export interface CallOptions {
  purpose: string;
  system?: string;
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  mockKind?: MockKind;
  /** mock 时用来生成稳定内容 */
  mockSeed?: string;
}

export interface CallRecord {
  purpose: string;
  provider: string;
  model: string;
  promptChars: number;
  outputChars: number;
  ms: number;
  ok: boolean;
  error?: string;
}

export class LlmError extends Error {
  status?: number;
  retryable: boolean;
  retryAfterMs?: number;
  constructor(message: string, opts: { status?: number; retryable?: boolean; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** 去掉 ```json 围栏并截取最外层 JSON 对象/数组 */
export function extractJson(text: string): any {
  let s = String(text ?? '').trim();
  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  let start = -1;
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);
  if (start === -1) throw new LlmError(`响应里没有 JSON：${s.slice(0, 200)}`);
  const openChar = s[start];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        const body = s.slice(start, i + 1);
        try {
          return JSON.parse(body);
        } catch (err) {
          throw new LlmError(`JSON 解析失败：${(err as Error).message}；片段：${body.slice(0, 300)}`);
        }
      }
    }
  }
  throw new LlmError(`JSON 不完整：${s.slice(start, start + 300)}`);
}

export class Llm {
  cfg: LlmConfig;
  hooks: { onCall?: (rec: CallRecord) => void };
  calls: CallRecord[] = [];
  /** 最近一次实际请求命中的模型（降级链里可能不是 cfg.model） */
  private lastModel = '';

  constructor(cfg: LlmConfig, hooks: { onCall?: (rec: CallRecord) => void } = {}) {
    this.cfg = cfg;
    this.hooks = hooks;
  }

  private record(rec: CallRecord) {
    this.calls.push(rec);
    this.hooks.onCall?.(rec);
  }

  async text(prompt: string, opts: CallOptions): Promise<string> {
    const started = Date.now();
    const promptChars = (opts.system?.length || 0) + prompt.length;
    try {
      const out =
        this.cfg.provider === 'mock'
          ? mockText(opts.mockKind || 'plain', opts.mockSeed || opts.purpose, hashNum(prompt))
          : await this.request(prompt, opts);
      this.record({
        purpose: opts.purpose,
        provider: this.cfg.provider,
        model: this.cfg.provider === 'mock' ? 'mock' : this.activeModel(),
        promptChars,
        outputChars: out.length,
        ms: Date.now() - started,
        ok: true,
      });
      return out;
    } catch (err) {
      this.record({
        purpose: opts.purpose,
        provider: this.cfg.provider,
        model: this.cfg.provider === 'mock' ? 'mock' : this.activeModel(),
        promptChars,
        outputChars: 0,
        ms: Date.now() - started,
        ok: false,
        error: (err as Error).message,
      });
      throw err;
    }
  }

  async json<T = any>(prompt: string, opts: CallOptions): Promise<T> {
    // JSON 任务（plan/extract）比正文长，默认给足 token；截断就升额重试一次
    const budget = opts.maxTokens ?? Math.max(this.cfg.maxTokens, this.cfg.jsonMaxTokens ?? 2600);
    const raw = await this.text(prompt, { ...opts, json: true, maxTokens: budget });
    try {
      return extractJson(raw) as T;
    } catch (err) {
      if ((err as Error).message.includes('JSON 不完整') && budget < 6000) {
        const retry = await this.text(prompt, { ...opts, json: true, maxTokens: Math.round(budget * 1.6) });
        return extractJson(retry) as T;
      }
      throw err;
    }
  }

  private activeModel(): string {
    return this.lastModel || this.cfg.model;
  }

  /** 降级链：cfg.model 打头，cfg.models 去重去空 */
  private models(): string[] {
    const list = [this.cfg.model, ...(this.cfg.models || [])].filter(Boolean);
    return [...new Set(list)];
  }

  private endpoints(): string[] {
    const list = [this.cfg.baseUrl, ...(this.cfg.baseUrls || [])].filter(Boolean).map((u) => u.replace(/\/$/, ''));
    return [...new Set(list)];
  }

  private async request(prompt: string, opts: CallOptions): Promise<string> {
    const models = this.models();
    const endpoints = this.endpoints();
    let lastErr: any;

    modelLoop: for (let mi = 0; mi < models.length; mi++) {
      const model = models[mi];
      this.lastModel = model;
      const hasNext = mi < models.length - 1;
      const body = {
        model,
        messages: [
          ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
          { role: 'user', content: prompt },
        ],
        temperature: opts.temperature ?? (opts.json ? this.cfg.jsonTemperature : this.cfg.temperature),
        max_tokens: opts.maxTokens ?? this.cfg.maxTokens,
        top_p: this.cfg.topP,
        frequency_penalty: this.cfg.frequencyPenalty,
        presence_penalty: this.cfg.presencePenalty,
        stream: false,
        ...(this.cfg.disableThinking ? { thinking: { type: 'disabled' } } : {}),
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      };

      for (const base of endpoints) {
        for (let attempt = 0; attempt < 3; attempt++) {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(new Error('timeout')), this.cfg.timeoutMs);
          const onAbort = () => ac.abort(opts.signal?.reason);
          opts.signal?.addEventListener('abort', onAbort, { once: true });
          try {
            const path = this.cfg.chatPath ?? '/chat/completions';
            const res = await fetch(`${base}${path}`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${this.cfg.apiKey}`,
                'x-api-key': this.cfg.apiKey,
              },
              body: JSON.stringify(body),
              signal: ac.signal,
            });
            if (!res.ok) {
              const text = await res.text().catch(() => '');
              const waitMatch = text.match(/retry after (\d+)s/i) || text.match(/"retry_after"\s*:\s*(\d+)/i);
              const retryAfterMs = waitMatch ? Number(waitMatch[1]) * 1000 : Number(res.headers.get('retry-after') || 0) * 1000;
              const retryable = res.status === 429 || res.status === 402 || res.status >= 500;
              throw new LlmError(`LLM ${res.status} ${res.statusText} ${text.slice(0, 300)}`, {
                status: res.status,
                retryable,
                retryAfterMs: retryAfterMs || undefined,
              });
            }
            const data: any = await res.json();
            const content = data?.choices?.[0]?.message?.content;
            if (typeof content !== 'string' || !content.trim()) {
              throw new LlmError(`LLM 空响应：${JSON.stringify(data).slice(0, 300)}`, { retryable: true });
            }
            return content.trim();
          } catch (err) {
            lastErr = err;
            const retryable = err instanceof LlmError ? err.retryable : true;
            if (!retryable) break;
            // 429/402 是渠道级配额问题：还有备用模型就直接换，不在原地耗冷却
            const quota = err instanceof LlmError && (err.status === 429 || err.status === 402);
            if (quota && hasNext) continue modelLoop;
            const waitMs = err instanceof LlmError && err.retryAfterMs ? Math.min(65000, err.retryAfterMs + 500) : 600 * (attempt + 1);
            if (attempt < 2) await new Promise((r) => setTimeout(r, waitMs));
          } finally {
            clearTimeout(timer);
            opts.signal?.removeEventListener('abort', onAbort);
          }
        }
      }
    }
    throw lastErr instanceof LlmError ? lastErr : new LlmError(String(lastErr?.message || lastErr));
  }
}

// ── mock provider：离线跑通全链路、跑测试用 ───────────────────────────────

function hashNum(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function pick<T>(arr: T[], seed: string, salt: string): T {
  return arr[hashNum(seed + salt) % arr.length];
}

const NAMES = ['沈砚', '老刀', '顾九', '裴七', '阿棠'];
const PLACES = ['旧城茶楼二层', '茶楼后巷', '当铺后院', '桥头', '码头仓房', '东家的账房', '守夜人的小屋', '城南破庙', '当铺柜台后', '城墙根的茶摊', '雨廊尽头', '西市米行', '义庄门口', '王家祠堂', '河埠石阶', '打更房'];
const OBJECTS_LIGHT = ['名单', '纸包', '封蜡的信', '半张票据', '一叠当票', '旧值夜簿', '一张字条', '三张当契'];
const OBJECTS_HEAVY = ['账本', '铜锁', '木匣', '炭盆', '茶碗', '油灯', '半截刀鞘', '刻字的铜牌', '一截麻绳', '油纸伞', '两枚制钱', '生锈的钥匙'];
const OBJECTS = [...OBJECTS_LIGHT, ...OBJECTS_HEAVY];
const ACTS_LIGHT = ['塞进内袋', '压在茶碗底下', '夹进第三页', '卷成筒塞进袖口', '压在砚台下面', '塞进鞋帮里', '夹在门缝里', '塞给身后的人'];
const ACTS_HEAVY = ['推到桌子对面', '搁在窗台上', '搬到墙角', '按在桌面上', '挪到炭盆边', '放到柜台上'];
const VERBS = ['把窗推开一条缝', '伸手按住桌角', '把袖子往上撸了撸', '低头看了看鞋尖', '用指节敲了两下桌面', '把手炉挪开', '把门帘掀起又放下', '蹲下去看地砖的缝', '把灯芯挑高了一点', '用袖子擦了擦铜锁', '把炭拨到一边', '侧耳听了听外头'];
const DETAILS = ['冷气顺着门缝灌进来', '灯焰歪了一下', '灰尘在光里浮起来', '楼下的说书声停了', '远处有人在敲铁，一声一声', '水缸结了一层薄冰', '风把纸角吹得发响', '檐上的水一滴一滴落下来', '河面起了雾', '隔壁的狗叫了两声就不叫了', '窗纸被风顶得鼓了一下', '巷子里的脚步声拐了弯', '炭盆里爆了一个火星', '桌上的灯花掉了'];
const DIALOGUE = [
  '东西呢', '你迟了', '别回头', '名字我看了', '先说价', '这单我不接', '谁让你来的', '人已经走了',
  '明天这个时候', '把灯吹了', '你手上是什么', '他还活着吗', '名单在谁手里', '别碰那个匣子',
  '你父亲当年也这么说', '再等三天', '钱我不要', '把门关上', '少打听', '话别说满',
  '桥怎么封了', '票子不对', '你替他跑腿', '我只认字不认人', '东家等不了', '换个人来谈',
  '这一页谁撕的', '别在后巷停', '你把名字划了', '账面差两吊', '我不进那间屋', '门从里面锁了',
  '灯芯该剪了', '先看看货', '人呢', '地上这是什么', '你数错了', '再数一遍', '把匣子留下', '这事到此为止',
];
const TIMES = ['过了半炷香', '又过了一会儿', '天快黑的时候', '等到街上没人', '过了很久', '约莫二更天', '天刚亮', '晌午前后', '掌灯之后'];

const USED_SENTENCES = new Map<string, Set<string>>();
const USED_QUOTES = new Map<string, Set<string>>();

function sentenceOnce(ch: number, i: number, salt: number): string {
  const key = `c${ch}:s${i}:k${salt}`;
  const H = (...x: string[]) => hashNum(key + '|' + x.join('|'));
  const p = NAMES[H('p') % NAMES.length];
  let p2 = NAMES[H('p2') % NAMES.length];
  if (p2 === p) p2 = NAMES[(NAMES.indexOf(p) + 1) % NAMES.length];
  const pl = PLACES[H('pl') % PLACES.length];
  const light = H('light') % 2 === 0;
  const ob = light ? OBJECTS_LIGHT[H('ob') % OBJECTS_LIGHT.length] : OBJECTS_HEAVY[H('ob') % OBJECTS_HEAVY.length];
  const act = light ? ACTS_LIGHT[H('a') % ACTS_LIGHT.length] : ACTS_HEAVY[H('a') % ACTS_HEAVY.length];
  const vb = VERBS[H('v') % VERBS.length];
  const dt = DETAILS[H('d') % DETAILS.length];
  const dl = DIALOGUE[H('dl') % DIALOGUE.length];
  const tm = TIMES[H('t') % TIMES.length];
  const qm = /[吗呢么]$/.test(dl) ? '？' : '。';
  const patterns = [
    `${p}把${ob}${act}。`,
    `${p}没说话，只是${vb}。`,
    `${pl}的灯${H('x') % 2 ? '灭了一盏' : '忽明忽暗'}，${dt}。`,
    `“${dl}${qm}”${p2}说。`,
    `“${dl}${qm}”${p}没抬头。`,
    `“${dl}${qm}”${p2}追问了一句。`,
    `${p}数了数，${['三', '五', '七', '九'][H('n') % 4]}${H('u') % 3 === 0 ? '步' : '下'}，停住。`,
    `${tm}，${p2}才从${pl}进来。`,
    `过了好一会儿，${p}才开口：“${dl}${qm}”`,
    `${p}看了${p2}一眼，把${ob}往${H('q') % 2 ? '桌边' : '怀里'}挪了挪。`,
    `${dt}，${p}把${ob}翻了${H('r') % 2 ? '一页' : '个面'}。`,
    `${p2}没接话，${vb}。`,
    `${pl}里只剩${H('s') % 2 ? '一盏灯' : '半壶凉茶'}。`,
    `${p}听见${H('z') % 3 === 0 ? '楼上有脚步' : '有人在隔壁咳嗽'}，没抬头。`,
    `${p2}把${ob}推回来，说了句“${dl}${qm}”`,
    `${p}没有回头，只问了一句：“${dl}${qm}”`,
    `${pl}外头，${dt}。`,
    `桌上那盏灯又暗了暗，${p}这才把手收回来。`,
  ];
  return patterns[H('pat') % patterns.length];
}

function sentence(ch: number, i: number, salt: number, bookKey = 'b'): string {
  let set = USED_SENTENCES.get(bookKey);
  if (!set) {
    set = new Set();
    USED_SENTENCES.set(bookKey, set);
  }
  for (let t = 0; t < 80; t++) {
    const cand = sentenceOnce(ch, i, salt * 97 + t);
    if (!set.has(cand)) {
      set.add(cand);
      return cand;
    }
  }
  const tails = ['，过了半炷香才有人应声', '，外头的风停了一停', '，桌上的灯花爆了一下', '，檐上的水又落了一滴', '，巷子里传来更声', '，炭盆里翻了个火星', '，楼下有人咳了一声', '，纸角被风掀起一点'];
  return sentenceOnce(ch, i, salt * 97 + 11) + tails[Math.abs(salt) % tails.length];
}

/** 同一章的不同场景（salt 不同）内容也不同；章与章之间句池按 hash 打散，避免跨章撞句 */
export /** 按句号切句，但不切引号里面的句号（否则会把对白切碎） */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (const ch of String(text)) {
    cur += ch;
    if (ch === '“') inQuote = true;
    else if (ch === '”') inQuote = false;
    else if (!inQuote && '。！？'.includes(ch)) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function mockChapter(ch: number, salt: number, bookKey = 'b') {
  const H = (k: string) => hashNum(`ch${ch}:k${salt}:${k}`);
  let set = USED_SENTENCES.get(bookKey);
  if (!set) {
    set = new Set();
    USED_SENTENCES.set(bookKey, set);
  }
  const uniq = (fn: (t: number) => string) => {
    for (let t = 0; t < 60; t++) {
      const c = fn(t);
      if (!set.has(c)) {
        set.add(c);
        return c;
      }
    }
    return fn(999);
  };
  const paras: string[] = [];
  const seenSent = new Set<string>();
  let usedQuotes = USED_QUOTES.get(bookKey);
  if (!usedQuotes) {
    usedQuotes = new Set<string>();
    USED_QUOTES.set(bookKey, usedQuotes);
  }
  const repair = (arr: string[]) => {
    const out: string[] = [];
    for (const raw of arr) {
      let text = raw;
      // 对白不能重复用同一句
      const m = text.match(/“([^”]{1,20})”/);
      if (m) {
        const q = m[1].replace(/[。！？…]+$/, '');
        if (usedQuotes.has(q)) {
          const alt = DIALOGUE.find((d) => !usedQuotes.has(d));
          if (alt) text = text.replace(`“${m[1]}”`, `“${alt}。”`);
        }
        const mm = text.match(/“([^”]{1,20})”/);
        if (mm) usedQuotes.add(mm[1].replace(/[。！？…]+$/, ''));
      }
      const key = text.replace(/\s+/g, '');
      if (seenSent.has(key)) continue;
      seenSent.add(key);
      out.push(text);
    }
    return out;
  };
  paras.push(uniq((t) => `沈砚把名单折成四折，${ACTS_LIGHT[(H('open') + t) % ACTS_LIGHT.length]}。`));
  const beatOther = NAMES.filter((n) => n !== '沈砚')[H('bn') % 2];
  const slam = ['名单', '纸包', '封蜡的信', '半张票据', '一叠当票', '账本'][H('sl') % 6];
  paras.push(uniq((t) => `他把${t === 0 ? slam : ['名单', '纸包', '账本', '一张字条', '半张票据'][(H('sl') + t) % 5]}拍在桌上，${beatOther}脸色变了。`));
  let seq = 0;
  for (let i = 0; i < 10; i++) {
    const n = 4 + (H('len' + i) % 3);
    const out: string[] = [];
    let guard = 0;
    while (out.length < n && guard < n * 14) {
      guard++;
      const cand = sentence(ch, seq, salt * 31 + i * 7 + out.length, bookKey);
      const prev = out[out.length - 1] || '';
      if (prev && prev.slice(0, 4) === cand.slice(0, 4)) continue;
      seq++;
      out.push(cand);
    }
    let filtered = repair(out);
    if ((filtered.join('').match(/“/g) || []).length === 0) {
      const p2 = NAMES[H('dq' + i) % NAMES.length];
      const dl = DIALOGUE.find((d) => !usedQuotes.has(d)) || DIALOGUE[0];
      usedQuotes.add(dl);
      filtered = [...filtered.slice(0, -1), `“${dl}。”${p2}说。`, filtered[filtered.length - 1]].filter(Boolean);
    }
    let extraGuard = 0;
    while (filtered.length < 3 && extraGuard < 12) {
      extraGuard++;
      const extra = sentence(ch, seq++, salt * 131 + i * 19 + filtered.length, bookKey);
      if (!seenSent.has(extra.replace(/\s+/g, ''))) {
        seenSent.add(extra.replace(/\s+/g, ''));
        filtered.push(extra);
      }
    }
    paras.push(filtered.join(''));
  }
  const hook = uniq((t) => `${PLACES[(H('hp') + t) % PLACES.length]}那盏灯灭了，黑暗里有人低声数数：${
    [
      '三、二、一',
      '一、二、三、四',
      '七下，停，又七下',
      '五、四、三',
      '数到九，忽然停了',
      '先是三下，又补了两下',
    ][(H('hn') + t) % 6]
  }。`);
  // 章级清洗：句子全去重，再重新分段（防止任何路径漏进来的重复）
  const fixedHead = paras.slice(0, 2);
  const bodySentences: string[] = [];
  const seenAll = new Set<string>();
  for (const p of paras.slice(2)) {
    for (const sent of splitSentences(p)) {
      const key = sent.replace(/\s+/g, '').replace(/[。！？…]+$/, '');
      if (seenAll.has(key)) continue;
      seenAll.add(key);
      bodySentences.push(sent);
    }
  }
  const regrouped: string[] = [];
  let k = 0;
  while (k < bodySentences.length) {
    const size = 4 + (hashNum(`g${ch}:${k}:${salt}`) % 3);
    regrouped.push(bodySentences.slice(k, k + size).join(''));
    k += size;
  }
  return { paras: [...fixedHead, ...regrouped, hook], beatQuote: '脸色变了', hookQuote: '有人低声数数', hookLine: hook };
}

function mockText(kind: MockKind, seed: string, salt = 0): string {
  const h = hashNum(seed);
  if (kind === 'arc') {
    return JSON.stringify({
      title: '第一卷 · 换命',
      premise: '主角被迫接手一桩不能拒绝的差事，第一次窥见规则背后的手。',
      chapter_span: 12,
    });
  }
  if (kind === 'cast') {
    return JSON.stringify({
      characters: [
        { name: '沈砚', role: 'protagonist', identity: '旧城当铺的接手人，替人办不能留名的差事', personality: '话少、算得清、认死理', goal: '查清父亲那桩旧案的底', fear: '变成父亲那样的人', speech: '短句，先问价再问事，很少解释', catchphrase: '先说价。', taboo: '不提他父亲的名字', importance: 5 },
        { name: '老刀', role: 'support', identity: '茶楼掌柜，旧城的消息贩子', personality: '笑面、贪小利、关键时刻会护人', goal: '把手里的账本卖个好价', fear: '被人翻旧账', speech: '夹着市井黑话，爱打岔', catchphrase: '这话我可没说过。', taboo: '不谈当年的火', importance: 4 },
        { name: '顾九', role: 'antagonist', identity: '替某位东家收账的人', personality: '客气到发冷，办事不留余地', goal: '把名单收回去', fear: '交不出名单', speech: '礼貌、慢、每个字都像写在纸上', catchphrase: '不急，我等得起。', taboo: '', importance: 4 },
        { name: '裴七', role: 'support', identity: '当铺里打杂的少年，眼睛尖', personality: '嘴碎、怕事但记性好', goal: '攒够钱离开旧城', fear: '被东家的人记住脸', speech: '语速快，爱用反问', catchphrase: '这我可没看清。', importance: 2 },
        { name: '阿棠', role: 'support', identity: '桥头茶摊的哑女，会写字', personality: '沉、看得准', goal: '找回被带走的哥哥', fear: '火', speech: '不说话，只写字条', catchphrase: '', importance: 2 },
      ],
    });
  }
  if (kind === 'voice') {
    const variants = [
      {
        narrator: '贴身第三人称，跟着主视角人物走',
        tone: '冷硬但不装腔，偶尔有一点干笑',
        diction: '口语、短词，行业词能不用就不用',
        rhythm: '短段和动作段交错，不用连续排比',
        dialogue: '对话短，允许打断和答非所问',
        imagery: '只用会挡路、硌手、发潮的物件',
        terminology: '术语预算：低。行业词能不用就不用；必须用时让外行也能从动作看懂',
        signature: '线索总先让主角理解错一次',
        avoid: ['档案腔', '全知旁白', '术语展览'],
        sample: '铜钱在掌心里凉了一下。他以为是自己手汗，捏了两下，才发现钱边比刚才更压手。',
      },
      {
        narrator: '第一人称近景，主角嘴硬但心里发虚',
        tone: '市井、急躁、带一点自嘲',
        diction: '大白话和短促对白，不端着',
        rhythm: '一句顶一句，偶尔突然停住',
        dialogue: '对话带抢话和答非所问，不解释背景',
        imagery: '票根、鞋泥、凉茶这些日常东西',
        terminology: '术语预算：中。允许行业词，但每个词必须立刻影响选择或代价',
        signature: '每次以为占便宜，实际上先吃亏',
        avoid: ['江湖腔', '史官腔', '物件清单'],
        sample: '我先把票根塞进鞋底，又觉得不保险。那伙计一直看我脚，笑得跟捡了钱似的。',
      },
    ];
    return JSON.stringify(variants[h % variants.length]);
  }
  if (kind === 'plan') {
    const idx = Number(String(seed).split(':').pop()) || 1;
    const TITLES = ['第七次敲门', '名单上的手印', '后巷的尾巴', '茶凉了', '第二个人', '空的抽屉', '纸包里的东西', '谁在跟着', '旧账', '一个人的名字'];
    return JSON.stringify({
      title: TITLES[(idx - 1) % TITLES.length],
      pov: '沈砚',
      characters: ['沈砚', '老刀', '顾九'],
      goal: [
        '沈砚按约定去见中间人，拿到第一份名单，同时发现自己被盯上了。',
        '沈砚去查名单上多出来的那个名字，被老刀拦住，两人第一次翻脸。',
        '沈砚顺着名字摸到码头，撞见顾九的人在交接，抢到半张票据。',
        '沈砚把票据拿回去对账，发现父亲的名字也在上面，决定不再替东家办事。',
        '顾九上门收名单，沈砚用假名单换时间，埋下第一处反制。',
      ][(idx - 1) % 5],
      beats: [
        { id: 'b1', place: ['旧城茶楼二层', '当铺后院', '码头仓房', '东家的账房', '城南破庙'][(idx - 1) % 5], present: ['沈砚', '老刀'], action: ['老刀用暗语试探，沈砚答错半句，气氛紧起来', '老刀把账本推过来，问沈砚敢不敢翻最后一页', '老刀带来消息：有人在打听沈砚父亲的名字', '老刀不肯再借人，只给了一张写着地址的纸条', '老刀把欠条撕了，说这单他不收钱'][(idx - 1) % 5], shift: ['沈砚知道老刀并不完全信任自己', '沈砚确认名单上的名字还会变', '沈砚意识到父亲当年也接过同样的差事', '沈砚决定绕开茶楼自己查', '两人暂时结盟，但各留一手'][(idx - 1) % 5] },
        { id: 'b2', place: ['茶楼后巷', '桥头', '码头仓房', '城墙根的茶摊', '守夜人的小屋'][(idx - 1) % 5], present: ['沈砚', '顾九'], action: ['沈砚发现被顾九的人盯梢，用倒垃圾的车甩掉尾巴', '顾九客客气气地拦路，只说了一句“名单该还了”', '沈砚在仓房撞见交接，抢到半张票据', '沈砚在茶摊听见两个收账人提到东家的名字', '沈砚摸进守夜人的小屋，找到一本旧值夜簿'][(idx - 1) % 5], shift: ['沈砚确认名单是真的，但被人抢先看过', '沈砚知道顾九背后还有人', '票据上的字迹和名单后添的那笔一样', '沈砚第一次听到东家的声音', '值夜簿上记着父亲最后一次进城的日期'][(idx - 1) % 5] },
        { id: 'b3', place: ['住处', '当铺柜台后', '城南破庙'][(idx - 1) % 3], present: ['沈砚', '老刀'], action: ['老刀看到名单上自己的名字，两人第一次正面冲突', '沈砚把票据摊开，要老刀认那笔字', '沈砚把假名单交给顾九的人，换回三天时间'][(idx - 1) % 3], shift: ['读者得知老刀与名单有关', '读者得知老刀当年替东家写过名单', '读者知道沈砚开始反击'][(idx - 1) % 3] },
      ],
      highlights: [
        { kind: 'beat', type: '反转', intensity: 4, title: '名单上多出的名字', how: '沈砚发现名单有一个名字是后添的，墨色更深', pays_code: idx > 1 ? 'flag_name' : '' },
        { kind: 'hook', type: '危机', intensity: 3, title: '有人在门外数数', how: '结尾灯灭，门外有人低声数三二一' },
      ],
      expectations_plant: idx === 1 ? [{ code: 'flag_name', type: '立旗', title: '名单上那个后添的名字', detail: '沈砚要查清是谁的名字被后来添上去', strength: 4, due_from: 2, due_to: 5 }] : [],
      expectations_pay: idx > 1 ? ['flag_name'] : [],
      hook: '灯灭了，门外有人在数数。',
      threads_payoff: [],
      threads_advance: ['名单的来历'],
      threads_new: [{ code: 'list_shadow', title: '名单上的墨迹会自己变', detail: '主角发现名单有一个名字是后添的，墨色比别的深', due_from: 9, due_to: 14 }],
      word_target: 2600,
    });
  }
  if (kind === 'review') {
    return JSON.stringify({
      verdict: 'pass',
      scores: { continuity: 8, voice: 7, pacing: 7, information: 8, anti_slop: 8 },
      issues: [],
    });
  }
  if (kind === 'extract') {
    const idx = Number(String(seed).split(':').pop()) || 1;
    return JSON.stringify({
      summary: '主角在茶楼见到中间人，拿到名单，发现被人盯梢，并因名单上的名字与配角冲突。',
      facts: [
        { kind: 'fact', subject: '沈砚', fact: '已拿到第一份名单', quote: '名单', tags: '主线' },
        { kind: 'state', subject: '老刀', fact: '知道名单上有自己的名字', quote: '名字', tags: '关系' },
      ],
      timeline: [{ story_time: '次日午后', location: '旧城茶楼', actors: '沈砚,老刀', event: '第一次交接' }],
      expectation_events:
        idx === 1
          ? [{ code: 'flag_name', action: 'plant', type: '立旗', title: '名单上那个后添的名字', detail: '要查清是谁的名字被后添上去', strength: 4, quote: '名单折成四折', due_from: 2, due_to: 5 }]
          : [{ code: 'flag_name', action: 'fulfill', quote: '脸色变了', note: '名字是顾九添的' }],
      highlights: [
        { kind: 'beat', type: '反转', intensity: 4, title: '名单上多出的名字', quote: '脸色变了', pays_code: idx > 1 ? 'flag_name' : '' },
        { kind: 'hook', type: '危机', intensity: 3, title: '门外数数', quote: '黑暗里有人低声数数' },
      ],
      relation_updates: [{ from: '沈砚', to: '老刀', relation: '互相提防但还得合作', note: '名单上出现老刀的名字' }],
      character_updates: [
        { name: '沈砚', status: 'alive', location: '旧城', goal: '把名单上后添的名字查出来', note: '第一次拿到名单，开始被盯' },
        { name: '老刀', status: 'alive', location: '茶楼', goal: '先保命再谈价', note: '名字出现在名单上，与沈砚翻脸' },
      ],
      thread_events: [
        { code: 'list_shadow', action: 'plant', title: '名单上的墨迹会自己变', detail: '名单有一个名字是后添的，墨色比别的深', quote: '名单折成四折', due_from: idx + 3, due_to: idx + 8 },
      ],
    });
  }
  if (kind === 'rewrite') {
    return '名单在沈砚手里折成四折，纸角起了毛。老刀没接，先看他另一只手。\n\n“东西呢？”';
  }
  if (kind === 'plain' && String(seed).startsWith('revise')) {
    // 定点修补在 mock 下没得改：返回空替换，保证链路可跑通
    return JSON.stringify({ replacements: [] });
  }
  // draft：组合式生成，章与场景之间不撞句
  const parts = String(seed).split(':');
  const maybeCh = Number(parts[parts.length - 2]);
  const chNo = Number.isFinite(maybeCh) && maybeCh > 0 ? maybeCh : Number(parts[parts.length - 1]) || 1;
  const bookKey = String(seed).split(':')[0] || 'b';
  const { paras } = mockChapter(chNo, salt || 1, bookKey);
  return paras.join('\n\n');
}
