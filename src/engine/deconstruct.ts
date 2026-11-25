/**
 * 拆书：把一本参考小说拆成"写法指纹"，供规划/写作阶段照抄节奏（不抄内容）。
 * 只做确定性统计 + 轻量启发式，可离线跑，不需要模型。
 */
import fs from 'node:fs';
import type { Store } from '../db/index.ts';
import { countWords, dialogueRatio, paragraphsOf } from './quality.ts';

export interface WritingTemplate {
  id: number;
  name: string;
  genre: string;
  source: string;
  chapters: number;
  avg_words: number;
  dialogue: number;
  para_avg: number;
  hook_dist: string;
  opening_dist: string;
  top_names: string;
  beat_rhythm: string;
  samples: string;
  created_at: string;
}

export function splitChapters(text: string): string[] {
  const t = text.replace(/\r/g, '\n');
  const idxs: number[] = [];
  const re = /(?:^|\n)\s*(第[0-9一二三四五六七八九十百千两]{1,6}章|Chapter\s+\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) idxs.push(m.index);
  if (idxs.length < 3) {
    // 没有章节标记：按每 3000 字切
    const out: string[] = [];
    for (let i = 0; i < t.length; i += 3000) out.push(t.slice(i, i + 3000));
    return out.filter((x) => countWords(x) > 20);
  }
  return idxs.map((start, i) => t.slice(start, idxs[i + 1] ?? t.length)).filter((x) => countWords(x) > 20);
}

const SUMMARY_WORDS = /(知道|明白|意味着|从此|注定|一切都|这一刻)/;

export function classifyEnding(ch: string): 'dialogue' | 'action' | 'object' | 'summary' {
  const paras = paragraphsOf(ch);
  const last = paras[paras.length - 1] || '';
  // 结尾段里对白占比高 → 算对白收尾
  const quoted = [...last.matchAll(/[“"]([^”"]{1,})[”"]/g)].reduce((n, m) => n + m[1].replace(/\s/g, '').length, 0);
  if (quoted > 0 && quoted / Math.max(1, last.replace(/\s/g, '').length) > 0.3) return 'dialogue';
  if (/[“"]/.test(last) && /[”"]\s*$/.test(last)) return 'dialogue';
  if (/[“"][^”"]*$/.test(last) || /[，,]$/.test(last)) return 'dialogue';
  if (SUMMARY_WORDS.test(last) && last.length < 220) return 'summary';
  if (/[。！？]$/.test(last) && countWords(last) <= 60 && /[他她我你]|手|门|灯|铃|声/.test(last)) return 'action';
  return 'object';
}

export function classifyOpening(ch: string): string {
  const paras = paragraphsOf(ch);
  const first = paras[0] || '';
  if (/^[“"]/.test(first)) return 'dialogue';
  if (/^[0-9一二三四五六七八九十]+[年月日]|天|夜|晨|午/.test(first)) return 'time';
  if (/[他她我你]/.test(first)) return 'character';
  return 'scene';
}

export function deconstruct(input: { name: string; genre?: string; source: string; text: string }) {
  const chapters = splitChapters(input.text);
  const words = chapters.map((c) => countWords(c));
  const dialogues = chapters.map((c) => dialogueRatio(c));
  const paras = chapters.map((c) => paragraphsOf(c).length);
  const hookDist: Record<string, number> = {};
  const openingDist: Record<string, number> = {};
  const nameCount = new Map<string, number>();
  for (const ch of chapters) {
    const h = classifyEnding(ch);
    hookDist[h] = (hookDist[h] || 0) + 1;
    const o = classifyOpening(ch);
    openingDist[o] = (openingDist[o] || 0) + 1;
    for (const m of ch.matchAll(/([\u4e00-\u9fa5]{2,3})(?:说|道|问|答|喊|笑)/g)) {
      nameCount.set(m[1], (nameCount.get(m[1]) || 0) + 1);
    }
  }
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
  const topNames = [...nameCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n]) => n);
  const avgWords = Math.round(avg(words));
  const beatRhythm = `${avgWords} 字/章，对白 ${(avg(dialogues) * 100).toFixed(0)}%，每章约 ${Math.round(avg(paras))} 段；` +
    Object.entries(hookDist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `章末${k} ${Math.round((v / chapters.length) * 100)}%`).join('，');
  const samples = {
    openings: chapters.slice(0, 3).map((c) => paragraphsOf(c)[0]?.slice(0, 60) || ''),
    hooks: chapters.slice(-3).map((c) => {
      const ps = paragraphsOf(c);
      return (ps[ps.length - 1] || '').slice(0, 60);
    }),
  };
  return {
    name: input.name,
    genre: input.genre || '',
    source: input.source,
    chapters: chapters.length,
    avg_words: avgWords,
    dialogue: Number(avg(dialogues).toFixed(3)),
    para_avg: Number(avg(paras).toFixed(1)),
    hook_dist: JSON.stringify(hookDist),
    opening_dist: JSON.stringify(openingDist),
    top_names: JSON.stringify(topNames),
    beat_rhythm: beatRhythm,
    samples: JSON.stringify(samples),
  };
}

export function saveTemplate(store: Store, t: ReturnType<typeof deconstruct>): WritingTemplate {
  store.run(
    `INSERT INTO writing_templates (name, genre, source, chapters, avg_words, dialogue, para_avg, hook_dist, opening_dist, top_names, beat_rhythm, samples, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(name) DO UPDATE SET genre=excluded.genre, source=excluded.source, chapters=excluded.chapters,
       avg_words=excluded.avg_words, dialogue=excluded.dialogue, para_avg=excluded.para_avg,
       hook_dist=excluded.hook_dist, opening_dist=excluded.opening_dist, top_names=excluded.top_names,
       beat_rhythm=excluded.beat_rhythm, samples=excluded.samples, created_at=excluded.created_at`,
    t.name,
    t.genre,
    t.source,
    t.chapters,
    t.avg_words,
    t.dialogue,
    t.para_avg,
    t.hook_dist,
    t.opening_dist,
    t.top_names,
    t.beat_rhythm,
    t.samples,
    new Date().toISOString(),
  );
  return store.get<WritingTemplate>('SELECT * FROM writing_templates WHERE name=?', t.name)!;
}

export function listTemplates(store: Store): WritingTemplate[] {
  return store.all<WritingTemplate>('SELECT * FROM writing_templates ORDER BY id DESC');
}

export function deconstructFile(store: Store, file: string, opts: { name?: string; genre?: string } = {}) {
  const text = fs.readFileSync(file, 'utf8');
  const t = deconstruct({
    name: opts.name || file.split('/').pop()?.replace(/\.[^.]+$/, '') || 'template',
    genre: opts.genre || '',
    source: file,
    text,
  });
  return saveTemplate(store, t);
}

/** 模板压缩成给模型看的一段话 */
export function templatePrompt(t: WritingTemplate | undefined): string {
  if (!t) return '';
  let samples: any = {};
  try {
    samples = JSON.parse(t.samples || '{}');
  } catch {}
  const open = (samples.openings || []).slice(0, 2).map((x: string) => `- ${x}`).join('\n');
  const hooks = (samples.hooks || []).slice(0, 2).map((x: string) => `- ${x}`).join('\n');
  return `【参考写法（拆自《${t.name}》，只学节奏与结构，不抄内容）】
- ${t.beat_rhythm}
- 对白占比 ${(t.dialogue * 100).toFixed(0)}%，平均每段 ${t.para_avg} 段/章
- 开头样例：
${open}
- 章末样例：
${hooks}`;
}
