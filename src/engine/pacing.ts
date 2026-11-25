/**
 * 节奏 / 爆点：网文没有爆点就没人追。
 * 规则化盯三件事：
 *  1) 每章必须有章末钩子（hook）
 *  2) 不能连续多章没有中强度以上的爽点（dry streak）
 *  3) 高强爆点必须有铺垫（setup），不能凭空炸
 * 另外给黄金三章单独加码。
 */
import type { Store } from '../db/index.ts';
import { nowIso } from '../config.ts';
import { quoteExistsInText } from './ledger.ts';

export interface Highlight {
  id: number;
  book_id: number;
  chapter_idx: number;
  kind: 'hook' | 'beat' | 'climax' | string;
  type: string;
  intensity: number;
  title: string;
  quote: string;
  setup_note: string;
  created_at: string;
}

export const HIGHLIGHT_TYPES = ['打脸', '反转', '揭秘', '突破', '危机', '情感', '智斗', '收获'];

export function listHighlights(store: Store, bookId: number): Highlight[] {
  return store.all<Highlight>('SELECT * FROM highlights WHERE book_id=? ORDER BY chapter_idx, id', bookId);
}

export function addHighlight(store: Store, bookId: number, h: Omit<Highlight, 'id' | 'book_id' | 'created_at'>) {
  store.run(
    'INSERT INTO highlights (book_id, chapter_idx, kind, type, intensity, title, quote, setup_note, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    bookId,
    h.chapter_idx,
    h.kind,
    h.type,
    h.intensity,
    h.title,
    h.quote,
    h.setup_note ?? '',
    nowIso(),
  );
}

export interface HighlightEvent {
  kind: 'hook' | 'beat' | 'climax';
  type: string;
  intensity: number;
  title?: string;
  quote?: string;
  setup_note?: string;
}

export function withPlannedSetups(events: HighlightEvent[], planned: any[]): HighlightEvent[] {
  const plans = (planned || []).filter((p) => p && p.setup);
  return (events || []).map((ev) => {
    if (ev.setup_note || Number(ev.intensity) < 4) return ev;
    const match = plans.find(
      (p) =>
        String(p.kind || '') === String(ev.kind || '') &&
        (String(p.title || '') === String(ev.title || '') || String(p.type || '') === String(ev.type || '')),
    );
    return match ? { ...ev, setup_note: String(match.setup) } : ev;
  });
}

/** 应用抽取结果：quote 必须能在正文里找到，找不到就拒绝（防止"自称有爆点"） */
export function applyHighlights(store: Store, bookId: number, chapterIdx: number, events: HighlightEvent[], text: string) {
  const applied: HighlightEvent[] = [];
  const rejected: { event: HighlightEvent; reason: string }[] = [];
  for (const ev of events || []) {
    if (!ev?.kind) continue;
    if (!ev.quote || !quoteExistsInText(ev.quote, text)) {
      rejected.push({ event: ev, reason: `爆点证据不在正文中：${(ev.quote || '(空)').slice(0, 30)}` });
      continue;
    }
    addHighlight(store, bookId, {
      chapter_idx: chapterIdx,
      kind: ev.kind,
      type: ev.type || '爽感',
      intensity: Math.max(1, Math.min(5, Number(ev.intensity) || 3)),
      title: ev.title || '',
      quote: ev.quote,
      setup_note: ev.setup_note || '',
    });
    applied.push(ev);
  }
  return { applied, rejected };
}

export interface PacingIssue {
  severity: 'block' | 'warn' | 'info';
  chapter: number;
  message: string;
}

export interface PacingReport {
  chapters: { idx: number; hook: boolean; maxIntensity: number; types: string[]; count: number }[];
  hookCoverage: number;
  avgIntensity: number;
  dryStreak: number;
  issues: PacingIssue[];
  nextAdvice: { neededIntensity: number; suggestTypes: string[]; mustHook: boolean; note: string };
}

const MIN_HOOK_WORDS = 1;

export function pacingReport(store: Store, bookId: number): PacingReport {
  const chapters = store.all<{ idx: number; content: string }>('SELECT idx, content FROM chapters WHERE book_id=? ORDER BY idx', bookId);
  const hs = listHighlights(store, bookId);
  const plannedByChapter = new Map<number, any[]>();
  for (const row of store.all<{ idx: number; highlights: string }>('SELECT idx, highlights FROM chapter_plans WHERE book_id=?', bookId)) {
    try {
      const value = JSON.parse(row.highlights || '[]');
      plannedByChapter.set(row.idx, Array.isArray(value) ? value : []);
    } catch {
      plannedByChapter.set(row.idx, []);
    }
  }
  const byChapter = new Map<number, Highlight[]>();
  for (const h of hs) {
    if (!byChapter.has(h.chapter_idx)) byChapter.set(h.chapter_idx, []);
    byChapter.get(h.chapter_idx)!.push(h);
  }
  const curve = chapters.map((c) => {
    const list = byChapter.get(c.idx) || [];
    return {
      idx: c.idx,
      hook: list.some((h) => h.kind === 'hook'),
      maxIntensity: list.reduce((a, h) => Math.max(a, h.intensity), 0),
      types: [...new Set(list.map((h) => h.type))],
      count: list.length,
    };
  });

  const issues: PacingIssue[] = [];
  // 钩子覆盖
  for (const c of curve) {
    if (!c.hook) issues.push({ severity: c.idx >= curve.length - 1 ? 'block' : 'warn', chapter: c.idx, message: `第 ${c.idx} 章没有章末钩子——读者没有理由点下一章` });
  }
  // 连续无爽点
  let streak = 0;
  for (const c of curve) {
    if (c.maxIntensity >= 3) streak = 0;
    else {
      streak++;
      if (streak >= 2) issues.push({ severity: streak >= 3 ? 'block' : 'warn', chapter: c.idx, message: `连续 ${streak} 章没有中强度以上的爽点/爆点` });
    }
  }
  // 高强爆点缺铺垫
  for (const h of hs) {
    const plannedSetup = withPlannedSetups([h], plannedByChapter.get(h.chapter_idx) || [])[0]?.setup_note;
    if (h.intensity >= 4 && !plannedSetup) issues.push({ severity: 'warn', chapter: h.chapter_idx, message: `第 ${h.chapter_idx} 章「${h.title || h.type}」强度 ${h.intensity}，但没有铺垫记录（凭空高潮读者会出戏）` });
  }
  // 黄金三章
  const golden = curve.slice(0, 3);
  golden.forEach((c, i) => {
    const need = [3, 2, 4][i] ?? 3;
    if (c.maxIntensity < need) issues.push({ severity: 'warn', chapter: c.idx, message: `黄金三章：第 ${c.idx} 章强度 ${c.maxIntensity || 0}，建议至少 ${need}（第一章立冲突/异象，第二章给小胜，第三章给第一个爆点）` });
  });

  const withHook = curve.filter((c) => c.hook).length;
  const avg = curve.length ? curve.reduce((a, c) => a + c.maxIntensity, 0) / curve.length : 0;
  let dry = 0;
  for (let i = curve.length - 1; i >= 0; i--) {
    if (curve[i].maxIntensity >= 3) break;
    dry++;
  }
  const lastTypes = curve.slice(-4).flatMap((c) => c.types);
  const suggestTypes = HIGHLIGHT_TYPES.filter((t) => !lastTypes.includes(t)).slice(0, 3);
  const needed = dry >= 2 ? 4 : dry === 1 ? 3 : 2;

  return {
    chapters: curve,
    hookCoverage: curve.length ? withHook / curve.length : 0,
    avgIntensity: Number(avg.toFixed(2)),
    dryStreak: dry,
    issues,
    nextAdvice: {
      neededIntensity: needed,
      suggestTypes: suggestTypes.length ? suggestTypes : ['反转', '揭秘'],
      mustHook: true,
      note: dry >= 2 ? `已经连续 ${dry} 章没有够劲的爆点，下一章必须给一个强度≥4 的` : '保持每章一个钩子',
    },
  };
}

/** 给规划用的紧凑提示：本章该写到什么强度、什么类型、必须有什么 */
export function pacingAdviceFor(store: Store, bookId: number, chapterIdx: number) {
  const r = pacingReport(store, bookId);
  const golden = chapterIdx <= 3 ? `黄金三章规则：第 ${chapterIdx} 章要${['立刻立起核心冲突与异象（金手指/麻烦上门）', '让主角拿到第一次小胜或小收获', '放第一个真正的爆点（打脸/反转/揭秘三选一）'][chapterIdx - 1] || '保持强推进'}。` : '';
  return {
    ...r.nextAdvice,
    golden,
    dryStreak: r.dryStreak,
    hookCoverage: r.hookCoverage,
  };
}
