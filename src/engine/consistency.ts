/**
 * 一致性问题扫描（规则，不花钱、可测试）：
 *  - 时间线：死人复活、同章同一人出现在两个地点、故事内时间倒退、章缺时间线
 *  - 别名：同一本书里别名撞别人的正名/别名
 *  - 人物：正文里反复出现却没登记的人名
 * 这些都是"长篇写崩"的前兆，必须在落库时就抓出来。
 */
import type { Store } from '../db/index.ts';
import { listCharacters, listTimeline, listFacts, suspectNames, aliasConflicts } from './book.ts';

export interface ConsistencyIssue {
  severity: 'block' | 'warn' | 'info';
  type: 'timeline' | 'alias' | 'cast';
  chapter: number;
  message: string;
  quote?: string;
}

/** 把「第3天 / 三日 / 3月5日 / 2026-01-02」这类粗粒度时间转成可比较的数 */
const CN_NUM: Record<string, number> = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function cnToNumber(s: string): number | null {
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  const m = s.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? CN_NUM[m[1]] : 1) * 10 + (m[2] ? CN_NUM[m[2]] : 0);
  if (s.length === 1 && s in CN_NUM) return CN_NUM[s];
  return null;
}

export function parseStoryTime(raw: string): number | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  let m = s.match(/^(-?\d{1,4})-(\d{1,2})-(\d{1,2})/);
  if (m) return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
  m = s.match(/第?\s*([0-9一二三四五六七八九十]{1,3})\s*天/);
  if (m) return cnToNumber(m[1]);
  m = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) return Number(m[1]) * 100 + Number(m[2]);
  m = s.match(/第?\s*([0-9一二三四五六七八九十]{1,3})\s*日/);
  if (m) return cnToNumber(m[1]);
  return null;
}

export function timelineIssues(store: Store, bookId: number): ConsistencyIssue[] {
  const out: ConsistencyIssue[] = [];
  const chars = listCharacters(store, bookId);
  const dead = new Set(chars.filter((c) => c.status === 'dead').map((c) => c.name));
  const timeline = listTimeline(store, bookId) as { idx: number; scene: string; story_time: string; location: string; actors: string; event: string }[];
  const facts = listFacts(store, bookId, 500) as { idx: number; kind: string; subject: string; fact: string }[];

  // 1) 已死亡的人在后文里继续行动
  for (const t of timeline) {
    for (const name of (t.actors || '').split(/[、,，\s]+/).filter(Boolean)) {
      if (dead.has(name)) {
        out.push({ severity: 'block', type: 'timeline', chapter: t.idx, message: `${name} 已标记死亡，但第 ${t.idx} 章仍在行动：${t.event}`, quote: t.event });
      }
    }
  }
  for (const f of facts) {
    if (f.subject && dead.has(f.subject) && f.kind !== 'death') {
      out.push({ severity: 'warn', type: 'timeline', chapter: f.idx, message: `${f.subject} 已标记死亡，第 ${f.idx} 章仍有状态记录：${f.fact}`, quote: f.fact });
    }
  }

  // 2) 同一个场景内同一人出现在两个地点（不同场景不算矛盾）
  const byScene = new Map<string, typeof timeline>();
  for (const t of timeline) {
    const key = `${t.idx}#${t.scene || '0'}`;
    if (!byScene.has(key)) byScene.set(key, []);
    byScene.get(key)!.push(t);
  }
  for (const [key, rows] of byScene) {
    const idx = Number(key.split('#')[0]);
    const locByActor = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!r.location) continue;
      for (const name of (r.actors || '').split(/[、,，\s]+/).filter(Boolean)) {
        if (!locByActor.has(name)) locByActor.set(name, new Set());
        locByActor.get(name)!.add(r.location);
      }
    }
    for (const [name, locs] of locByActor) {
      if (locs.size > 1) {
        out.push({ severity: 'warn', type: 'timeline', chapter: idx, message: `第 ${idx} 章同一场景里 ${name} 同时出现在 ${[...locs].join('、')}（除非有分身/传送，否则是矛盾）` });
      }
    }
  }

  // 3) 故事内时间倒退
  let lastValue: number | null = null;
  let lastRaw = '';
  let lastChapter = 0;
  for (const t of timeline.slice().sort((a, b) => a.idx - b.idx)) {
    const v = parseStoryTime(t.story_time);
    if (v == null) continue;
    if (lastValue != null && v < lastValue) {
      out.push({ severity: 'warn', type: 'timeline', chapter: t.idx, message: `故事内时间倒退：第 ${lastChapter} 章「${lastRaw}」→ 第 ${t.idx} 章「${t.story_time}」` });
    }
    lastValue = v;
    lastRaw = t.story_time;
    lastChapter = t.idx;
  }

  // 4) 章缺时间线（只提示前 30 章，避免噪音）
  const withTimeline = new Set(timeline.map((t) => t.idx));
  const chapterIdxs = store.all<{ idx: number }>('SELECT idx FROM chapters WHERE book_id=? ORDER BY idx', bookId).map((r) => r.idx);
  for (const idx of chapterIdxs.slice(0, 30)) {
    if (!withTimeline.has(idx)) out.push({ severity: 'info', type: 'timeline', chapter: idx, message: `第 ${idx} 章没有抽取到故事内时间/地点，时间线不完整` });
  }

  return out;
}

export function aliasIssues(store: Store, bookId: number): ConsistencyIssue[] {
  const out: ConsistencyIssue[] = [];
  for (const c of aliasConflicts(store, bookId)) {
    out.push({ severity: 'warn', type: 'alias', chapter: 0, message: `「${c.alias}」同时是 ${c.owner} 的名字/别名，${c.name} 也用了它——正文里读者会分不清是谁` });
  }
  // 同一人被别名替代：某章只用别名、从不用正名
  const chapters = store.all<{ idx: number; content: string }>('SELECT idx, content FROM chapters WHERE book_id=? ORDER BY idx', bookId);
  for (const c of listCharacters(store, bookId)) {
    const aliases = (c.aliases || '').split(/[、,，\s]+/).filter(Boolean);
    if (!aliases.length) continue;
    for (const ch of chapters) {
      const usesName = ch.content.includes(c.name);
      const usedAlias = aliases.find((a) => ch.content.includes(a));
      if (usedAlias && !usesName && (ch.content.split(usedAlias).length - 1) >= 2) {
        out.push({ severity: 'info', type: 'alias', chapter: ch.idx, message: `第 ${ch.idx} 章只用别名「${usedAlias}」，没出现正名「${c.name}」——如果读者刚认识他会认不出` });
      }
    }
  }
  return out;
}

export function castIssues(store: Store, bookId: number, chapterIdx: number, text: string): ConsistencyIssue[] {
  const out: ConsistencyIssue[] = [];
  for (const n of suspectNames(store, bookId, text)) {
    out.push({ severity: 'warn', type: 'cast', chapter: chapterIdx, message: `正文里「${n}」反复出现但没登记人物卡` });
  }
  const dead = listCharacters(store, bookId).filter((c) => c.status === 'dead');
  for (const c of dead) {
    const re = new RegExp(`${c.name}\s*(?:说|道|问|答|笑|喊)`);
    if (re.test(text)) out.push({ severity: 'block', type: 'cast', chapter: chapterIdx, message: `${c.name} 已经死了，本章却还在说话/行动` });
  }
  return out;
}

export function fullCheck(store: Store, bookId: number) {
  const timeline = timelineIssues(store, bookId);
  const alias = aliasIssues(store, bookId);
  const poison: ConsistencyIssue[] = [];
  const knownNames = new Set(listCharacters(store, bookId).map((c) => c.name));
  for (const ch of store.all<{ idx: number; checks: string }>('SELECT idx, checks FROM chapters WHERE book_id=? ORDER BY idx', bookId)) {
    let c: any = {};
    try {
      c = JSON.parse(ch.checks || '{}');
    } catch {}
    for (const issue of c.review?.issues || []) {
      if (issue.type === 'poison' || issue.type === 'character') {
        const raw = `${issue.message || ''} ${issue.why || ''}`;
        const unregistered = raw.match(/([\u4e00-\u9fa5]{2,3})是人物卡外/);
        if (issue.type === 'character' && unregistered && knownNames.has(unregistered[1])) continue;
        poison.push({ severity: issue.severity === 'block' ? 'block' : 'warn', type: 'cast', chapter: ch.idx, message: `[${issue.type}] ${issue.message || issue.why || ''}`, quote: issue.quote });
      }
    }
  }
  const summary = {
    block: [...timeline, ...alias, ...poison].filter((i) => i.severity === 'block').length,
    warn: [...timeline, ...alias, ...poison].filter((i) => i.severity === 'warn').length,
    info: [...timeline, ...alias, ...poison].filter((i) => i.severity === 'info').length,
  };
  return { summary, timeline, alias, poison };
}
