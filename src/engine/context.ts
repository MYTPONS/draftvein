/**
 * 上下文装配：每章只喂"该知道的"，不把全书灌进去。
 * 分层：骨架 → 本卷 → 设定检索 → 前情摘要 → 上一章尾部 → 伏笔 → 硬事实 → 风格
 */
import type { Store } from '../db/index.ts';
import type { Book, Chapter, ChapterPlan } from './book.ts';
import { dueThreads, overdueThreads, type Thread } from './ledger.ts';
import { listCharacters, type Character } from './book.ts';
import { templatePrompt } from './deconstruct.ts';
import type { VoiceProfile } from './voice.ts';

export interface ContextPack {
  skeleton: string;
  arc: string;
  cast: string;
  related: string;
  bible: string;
  recap: string;
  tail: string;
  threads: string;
  facts: string;
  style: string;
  plan: string;
  styleSample: string;
  template: string;
  chars: number;
}

const STYLE_PRESETS: Record<string, string> = {
  default: [
    '用人物正在做的事或遇到的麻烦开场，不要先解释背景。',
    '情绪通过动作、选择、停顿和人物正在处理的物件体现。',
    '叙述优先：动作、环境和物件推进占全章六到七成；对白只在人物必须交锋时出现，两三句就落回动作、环境或局面变化。',
    '贴身第三人称：读者跟着当前 POV 人物走，只写他能看到、听到、猜到和误解的东西；不写全知旁白。',
    '语言用普通人一眼看懂的话，不堆行业词、旧称或官称；杜绝报告腔、说明文腔和模板腔。',
    '具体物件只在影响人物选择和局面时写，不要每句都塞道具，不要把小说写成物品清单或流程清单。',
    '设定通过代价和对话露出来，不要解释。',
    '段落长短交错，长段不超过五句，中间插一句一段的短段。',
    '结尾落在一个没做完的动作、一句没说完的话，或一个刚出现的东西上。',
  ].join('\n'),
  cold: ['克制、低温，主要靠动作与留白推进。', '少写心理，多写手上在做什么。'].join('\n'),
};

export function styleGuide(styleId: string, profile?: VoiceProfile): string {
  const base = STYLE_PRESETS[styleId] || STYLE_PRESETS.default;
  if (!profile) return base;
  return [
    '【本书专属声纹】',
    `叙述距离：${profile.narrator}`,
    `语气：${profile.tone}`,
    `用词：${profile.diction}`,
    `句法/节奏：${profile.rhythm}`,
    `对话：${profile.dialogue}`,
    `意象/物件：${profile.imagery}`,
    profile.terminology ? `术语规则：${profile.terminology}` : '',
    `本书 signature：${profile.signature}`,
    profile.avoid.length ? `禁止写成：${profile.avoid.join('、')}` : '',
  ].filter(Boolean).join('\n');
}

/** 关键词打分检索：设定条目按与本章目标/人物的重合度排序 */
function rankBible(rows: { name: string; content: string; kind: string; importance: number }[], query: string, topN = 10) {
  const q = new Set(
    String(query)
      .split(/[\s，,。.、；;：:""''（）()【】\[\]|/]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 1),
  );
  return rows
    .map((r) => {
      let score = r.importance * 2;
      for (const token of q) {
        if (token && r.name.includes(token)) score += 6;
        if (token && r.content.includes(token)) score += 1;
      }
      if (r.kind === 'character') score += 1;
      return { r, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((x) => x.r);
}

export function buildContext(
  store: Store,
  book: Book,
  chapterIdx: number,
  plan: ChapterPlan | undefined,
  opts: { bibleTopN?: number; recapChapters?: number; tailChars?: number } = {},
): ContextPack {
  // 本地小模型上下文吃紧：DRAFTVEIN_TIGHT=1 时只喂最必要的
  const tight = process.env.DRAFTVEIN_TIGHT === '1';
  const bibleTopN = opts.bibleTopN ?? (tight ? 6 : 10);
  const recapChapters = opts.recapChapters ?? (tight ? 3 : 6);
  const tailChars = opts.tailChars ?? (tight ? 500 : 900);

  const bibleRows = store.all<{ name: string; content: string; kind: string; importance: number; tags?: string }>(
    'SELECT name, content, kind, importance, tags FROM bible WHERE book_id=?',
    book.id,
  );
  const planText = plan ? `${plan.title} ${plan.goal} ${plan.beats}` : '';
  const picked = rankBible(bibleRows, `${book.premise} ${planText}`, bibleTopN);
  // 触发词：本章节拍/上文里出现条目名或 tags 关键词时，必注入（世界书模式）
  const triggerText = `${planText} ${plan?.goal ?? ''}`;
  const triggered = bibleRows.filter((r) => {
    const words = `${r.name} ${r.tags || ''}`.split(/[、,，\s]+/).filter((w) => w.length >= 2);
    return words.some((w) => triggerText.includes(w));
  });
  const mergedBible = [...picked];
  for (const t of triggered) if (!mergedBible.some((x) => x.name === t.name)) mergedBible.push(t);
  const bible = mergedBible.map((r) => `【${labelOf(r.kind)}·${r.name}】${r.content}`).join('\n');

  // 相关旧正文（FTS5 检索，代替纯摘要）
  let related = '';
  try {
    const keywords = (plan?.goal || '') + ' ' + (planText || '');
    const tokens = [...new Set(keywords.split(/[\s，,。.、；;：:！!？?]+/).filter((w) => w.length >= 2))].slice(0, 6);
    if (tokens.length) {
      const q = tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
      const hits = store.all<{ idx: number; content: string }>(
        'SELECT idx, content FROM chapters_fts WHERE book_id=? AND chapters_fts MATCH ? ORDER BY rank LIMIT 2',
        book.id,
        q,
      );
      related = hits
        .map((h) => {
          const txt = String(h.content);
          const pos = Math.max(0, txt.indexOf(tokens[0]));
          return `第${h.idx}章片段：…${txt.slice(Math.max(0, pos - 60), pos + 260).replace(/\s+/g, '')}…`;
        })
        .join('\n');
    }
  } catch {
    related = '';
  }

  const arc = store.get<{ title: string; premise: string; start_chapter: number; end_chapter: number }>(
    'SELECT title, premise, start_chapter, end_chapter FROM arcs WHERE book_id=? AND start_chapter<=? AND end_chapter>=? ORDER BY idx DESC LIMIT 1',
    book.id,
    chapterIdx,
    chapterIdx,
  );

  const prev = store.all<Chapter>(
    'SELECT * FROM chapters WHERE book_id=? AND idx<? ORDER BY idx DESC LIMIT ?',
    book.id,
    chapterIdx,
    recapChapters,
  );
  const recap = prev.length
    ? prev
        .slice()
        .reverse()
        .map((c) => `第${c.idx}章 ${c.title}：${c.summary || c.content.replace(/\s+/g, '').slice(0, 120)}`)
        .join('\n')
    : '（这是第一章，没有前情。）';

  const last = prev[0];
  const tail = last ? last.content.replace(/\s+$/, '').slice(-tailChars) : '（无）';

  const threads = dueThreads(store, book.id, chapterIdx);
  const overdue = overdueThreads(store, book.id, chapterIdx);
  const threadText = threads.length
    ? threads
        .map((t) => {
          const overdueTag = overdue.some((o) => o.id === t.id) ? '【已过期·必须处理】' : '';
          const window = t.due_to != null ? `到期窗口 ${t.due_from ?? '?'}-${t.due_to}` : '无窗口';
          return `${overdueTag}${t.code}｜${t.title}｜埋于第${t.planted_idx ?? '?'}章｜${window}｜${t.detail || ''}`;
        })
        .join('\n')
    : '（暂无未回收线索）';

  const factRows = store.all<{ idx: number; subject: string; fact: string }>(
    'SELECT idx, subject, fact, visibility FROM facts WHERE book_id=? ORDER BY idx DESC, id DESC LIMIT 30',
    book.id,
  );
  const readerFacts = factRows.filter((f: any) => (f.visibility || 'reader') !== 'author');
  const authorFacts = factRows.filter((f: any) => f.visibility === 'author');
  const facts = [
    readerFacts.length ? `【读者已知】\n${readerFacts.map((f: any) => `第${f.idx}章｜${f.subject}：${f.fact}`).join('\n')}` : '',
    authorFacts.length ? `【作者真相（读者尚不知，本章不许让人物直接说出）】\n${authorFacts.map((f: any) => `第${f.idx}章｜${f.subject}：${f.fact}`).join('\n')}` : '',
  ].filter(Boolean).join('\n') || '（暂无）';

  const skeleton = [
    `书名：${book.title}`,
    `题材：${book.genre || '未定'}`,
    `目标读者：${book.audience || '未定'}`,
    `核心设定：${book.premise || '未定'}`,
    `每章目标字数：${book.target_words}`,
  ].join('\n');

  // 角色卡：本章节拍里点名的人 + 高重要度的人
  const castNames = new Set<string>();
  if (plan) for (const b of parseBeats(plan.beats)) for (const n of b.present || []) if (n) castNames.add(n);
  const characters = listCharacters(store, book.id);
  for (const c of characters) if (c.importance >= 4 && castNames.size < 8) castNames.add(c.name);
  const castPicked = characters.filter((c) => castNames.has(c.name)).slice(0, 8);
  const cast = castPicked.length
    ? castPicked.map((c) => renderCharacter(c)).join('\n')
    : characters.length
      ? characters.slice(0, 6).map((c) => renderCharacter(c)).join('\n')
      : '（还没有建人物卡；名字会用占位，请在「人物」页先把主角/配角建好）';

  let data: any = {};
  try {
    data = JSON.parse(book.data || '{}');
  } catch {
    data = {};
  }
  const voiceProfile = data.voiceProfile as VoiceProfile | undefined;
  const styleSample = String(data.styleSample || voiceProfile?.sample || '').slice(0, 900);
  let template = '';
  if (data.template) {
    const t = store.get<any>('SELECT * FROM writing_templates WHERE name=?', String(data.template));
    template = templatePrompt(t || undefined);
  }

  const style = styleGuide(book.style_id, voiceProfile);
  const planTextOut = plan
    ? `第${plan.idx}章 ${plan.title}\n本章目标：${plan.goal}\n节拍：\n${parseBeats(plan.beats)
        .map((b, i) => `  ${i + 1}. [${b.place || '?'}] ${b.action || ''}（信息变化：${b.shift || '-'}）`)
        .join('\n')}`
    : '（本章尚未规划）';

  const chars =
    skeleton.length + bible.length + recap.length + tail.length + threadText.length + facts.length + style.length + planTextOut.length + cast.length;

  return {
    skeleton,
    arc: arc ? `${arc.title}（第${arc.start_chapter}-${arc.end_chapter}章）：${arc.premise}` : '（未划分卷）',
    cast,
    related,
    bible,
    recap,
    tail,
    threads: threadText,
    facts,
    style,
    plan: planTextOut,
    styleSample,
    template,
    chars,
  };
}

export function renderCharacter(c: Character): string {
  const bits = [
    `【${c.name}｜${roleName(c.role)}】`,
    c.identity ? `身份：${c.identity}` : '',
    c.personality ? `性格：${c.personality}` : '',
    c.goal ? `想要：${c.goal}` : '',
    c.fear ? `怕：${c.fear}` : '',
    c.speech ? `说话方式：${c.speech}` : '',
    c.catchphrase ? `口头禅「${c.catchphrase}」` : '',
    c.taboo ? `禁忌：${c.taboo}` : '',
    c.status !== 'alive' ? `当前状态：${c.status}` : '',
    c.aliases ? `别名：${c.aliases}` : '',
  ].filter(Boolean);
  return bits.join(' ');
}

export function roleName(role: string): string {
  return ({ protagonist: '主角', support: '配角', antagonist: '反派', extra: '龙套' } as Record<string, string>)[role] || role;
}

export function parseBeats(raw: string): { id?: string; place?: string; present?: string[]; action?: string; shift?: string }[] {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function labelOf(kind: string): string {
  return (
    { world: '世界', character: '人物', faction: '势力', location: '地点', item: '物品', rule: '规则', thread: '线索' }[kind] || kind
  );
}
