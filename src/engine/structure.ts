/**
 * 故事结构：把"这一段该干什么"固定下来，避免写成流水账。
 * 结构用百分比切，按当前规划总章数换算成章号，所以卷变了也能自动对齐。
 */
import type { Store } from '../db/index.ts';

export interface Stage {
  id: number;
  book_id: number;
  sort: number;
  name: string;
  start_pct: number;
  end_pct: number;
  goal: string;
}

export interface StructureTemplate {
  key: string;
  name: string;
  desc: string;
  stages: { name: string; start_pct: number; end_pct: number; goal: string }[];
}

export const TEMPLATES: StructureTemplate[] = [
  {
    key: 'three_act',
    name: '三幕结构',
    desc: '最通用：建立 → 对抗 → 收束。适合大部分长篇。',
    stages: [
      { name: '第一幕 · 建立', start_pct: 0, end_pct: 25, goal: '把主角的常态、缺口、以及逼他上路的麻烦交代清楚；20% 处必须做出不可回头的选择。' },
      { name: '第二幕 · 对抗', start_pct: 25, end_pct: 75, goal: '冲突不断升级，每次胜利都带来更大代价；中点要有一次彻底的反转或真相。' },
      { name: '第三幕 · 收束', start_pct: 75, end_pct: 100, goal: '收束所有主线与伏笔，主角付出代价完成改变，结局要回应开篇的缺口。' },
    ],
  },
  {
    key: 'qidian',
    name: '起点连载流',
    desc: '黄金三章 + 升级打脸循环 + 卷末大高潮，最贴男频爽文。',
    stages: [
      { name: '黄金三章', start_pct: 0, end_pct: 3, goal: '第一章立冲突与异象，第二章给小胜，第三章给第一个真爆点；三章内必须让读者知道这本书爽在哪。' },
      { name: '立足期', start_pct: 3, end_pct: 20, goal: '建立金手指规则与代价，收第一批盟友，立第一个明确对手；每 2-3 章一个小爽点。' },
      { name: '升级期', start_pct: 20, end_pct: 60, goal: '不断换更大的舞台与更强的对手，旧问题解决立刻抛新问题；爽点密度不低于每 2 章一次。' },
      { name: '卷末高潮', start_pct: 60, end_pct: 85, goal: '把前面埋的对手与伏笔集中引爆，主角付出可见代价赢下阶段性胜利。' },
      { name: '新篇铺垫', start_pct: 85, end_pct: 100, goal: '收尾当前卷并埋下全书级的新威胁，给下一卷留钩子。' },
    ],
  },
  {
    key: 'hero',
    name: '英雄之旅',
    desc: '12 阶段简化版，适合成长线清晰的故事。',
    stages: [
      { name: '平凡世界 / 冒险召唤', start_pct: 0, end_pct: 15, goal: '展示常态与缺口，召唤出现，主角拒绝后被迫上路。' },
      { name: '跨越门槛 / 试炼盟友敌人', start_pct: 15, end_pct: 45, goal: '进入新规则的世界，遇到导师与盟友，第一次试炼失败或惨胜。' },
      { name: '接近核心 / 磨难', start_pct: 45, end_pct: 75, goal: '逼近最大秘密，遭遇"死亡与重生"式的低谷。' },
      { name: '报酬 / 归返 / 改变', start_pct: 75, end_pct: 100, goal: '拿到奖赏，带着改变回到常态世界，解决最初的问题。' },
    ],
  },
];

export function templateByKey(key: string): StructureTemplate {
  return TEMPLATES.find((t) => t.key === key) || TEMPLATES[0];
}

export function seedStructure(store: Store, bookId: number, key = 'three_act') {
  const tpl = templateByKey(key);
  store.run('DELETE FROM structure_stages WHERE book_id=?', bookId);
  for (const [i, s] of tpl.stages.entries()) {
    store.run(
      'INSERT INTO structure_stages (book_id, sort, name, start_pct, end_pct, goal) VALUES (?,?,?,?,?,?)',
      bookId,
      i,
      s.name,
      s.start_pct,
      s.end_pct,
      s.goal,
    );
  }
  return tpl;
}

export function listStages(store: Store, bookId: number): Stage[] {
  return store.all<Stage>('SELECT * FROM structure_stages WHERE book_id=? ORDER BY sort, id', bookId);
}

export function plannedTotal(store: Store, bookId: number): number {
  const v = store.get<{ m: number }>('SELECT COALESCE(MAX(end_chapter),0) m FROM arcs WHERE book_id=?', bookId)!;
  const c = store.get<{ m: number }>('SELECT COALESCE(MAX(idx),0) m FROM chapter_plans WHERE book_id=?', bookId)!;
  const done = store.get<{ m: number }>('SELECT COALESCE(MAX(idx),0) m FROM chapters WHERE book_id=?', bookId)!;
  return Math.max(v.m, c.m, done.m, 30);
}

export function stageAt(store: Store, bookId: number, chapterIdx: number) {
  const total = plannedTotal(store, bookId);
  const pct = (chapterIdx / total) * 100;
  const stages = listStages(store, bookId);
  const stage = stages.find((s) => pct >= s.start_pct && pct < s.end_pct) || stages[stages.length - 1];
  if (!stage) return null;
  return {
    stage,
    pct: Number(pct.toFixed(1)),
    total,
    chapterRange: {
      start: Math.max(1, Math.round((stage.start_pct / 100) * total)),
      end: Math.max(1, Math.round((stage.end_pct / 100) * total)),
    },
    stages: stages.map((s) => ({ ...s, from: Math.round((s.start_pct / 100) * total), to: Math.round((s.end_pct / 100) * total) })),
  };
}

/** 规划提示用：当前结构阶段该干什么 */
export function structureAdvice(store: Store, bookId: number, chapterIdx: number) {
  const at = stageAt(store, bookId, chapterIdx);
  if (!at) return '';
  const { stage, pct } = at;
  return `结构位置：${stage.name}（全书 ${pct}%，本阶段 ${at.chapterRange.start}-${at.chapterRange.end} 章）。本阶段职能：${stage.goal}`;
}
