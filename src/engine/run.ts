import type { Store } from '../db/index.ts';
import type { Llm } from '../llm/client.ts';
import type { Book } from './book.ts';
import { nextChapterIdx, listChapters } from './book.ts';
import { writeChapter, type ChapterResult } from './chapter.ts';
import { threadHealth } from './ledger.ts';
import { ensureWindow } from './outline.ts';
import { nowIso } from '../config.ts';

export interface RunOptions {
  count?: number;
  from?: number;
  signal?: AbortSignal;
  onEvent?: (stage: string, message: string, data?: any) => void;
  /** 独立审稿模型 */
  reviewLlm?: Llm;
}

export interface RunSummary {
  runId: number;
  chapters: { idx: number; title: string; words: number; score: number; status: string }[];
  health: ReturnType<typeof threadHealth>;
  errors: { idx: number; error: string }[];
}

/** 逐章推进：绝不是"一次生成 N 章"，而是循环调用单章流水线 */
export async function runChapters(store: Store, llm: Llm, book: Book, opts: RunOptions = {}): Promise<RunSummary> {
  const count = Math.max(1, Math.min(opts.count ?? 1, 20));
  const start = opts.from ?? nextChapterIdx(store, book.id);
  const runId = Number(
    store.run(
      'INSERT INTO runs (book_id, kind, status, detail, started_at) VALUES (?,?,?,?,?)',
      book.id,
      'write',
      'running',
      `from ${start} count ${count}`,
      nowIso(),
    ).lastInsertRowid,
  );

  const emit = (stage: string, message: string, data?: any) => {
    store.run('INSERT INTO events (run_id, book_id, level, stage, message, data, created_at) VALUES (?,?,?,?,?,?,?)', runId, book.id, 'info', stage, message, JSON.stringify(data ?? {}), nowIso());
    opts.onEvent?.(stage, message, data);
  };

  const done: RunSummary['chapters'] = [];
  const errors: RunSummary['errors'] = [];

  emit('run', `开始：从第 ${start} 章起推进 ${count} 章`);

  for (let n = 0; n < count; n++) {
    const idx = start + n;
    if (opts.signal?.aborted) {
      emit('run', `已中止于第 ${idx} 章之前`);
      break;
    }
    try {
      const result: ChapterResult = await writeChapter(store, llm, book, idx, {
        signal: opts.signal,
        reviewLlm: opts.reviewLlm,
        onEvent: (stage, msg, data) => emit(stage, msg, data),
      });
      const saved = store.get<{ status: string }>('SELECT status FROM chapters WHERE book_id=? AND idx=?', book.id, idx)!;
      done.push({ idx, title: result.title, words: result.words, score: result.report.score, status: saved.status });
      const health = threadHealth(store, book.id, idx + 1);
      if (health.overdue > 0) emit('ledger', `注意：第 ${idx} 章后仍有 ${health.overdue} 条线索逾期未收`, { overdue: health.overdueList.map((t) => t.code) });
    } catch (err) {
      const message = (err as Error).message;
      errors.push({ idx, error: message });
      emit('error', `第 ${idx} 章失败：${message}`);
      break;
    }
  }

  // 写完顺手把下一章的计划补上（仍是单章规划）
  if (!opts.signal?.aborted && errors.length === 0) {
    try {
      await ensureWindow(store, llm, book, start + done.length, 1, { signal: opts.signal, onEvent: (m) => emit('plan', m) });
    } catch (err) {
      emit('plan', `下一章预规划失败（不影响已写内容）：${(err as Error).message}`);
    }
  }

  const health = threadHealth(store, book.id, nextChapterIdx(store, book.id));
  store.run('UPDATE runs SET status=?, detail=?, ended_at=? WHERE id=?', errors.length ? 'partial' : 'done', JSON.stringify({ done: done.length, errors: errors.length }), nowIso(), runId);
  emit('run', `结束：完成 ${done.length} 章，失败 ${errors.length} 章`);

  return { runId, chapters: done, health, errors };
}

export function runView(store: Store, bookId: number, limit = 20) {
  return store.all('SELECT * FROM runs WHERE book_id=? ORDER BY id DESC LIMIT ?', bookId, limit);
}

export function eventView(store: Store, bookId: number, afterId = 0, limit = 200) {
  return store.all('SELECT * FROM events WHERE book_id=? AND id>? ORDER BY id LIMIT ?', bookId, afterId, limit);
}

export function lastEvents(store: Store, bookId: number, limit = 60) {
  return store.all('SELECT * FROM events WHERE book_id=? ORDER BY id DESC LIMIT ?', bookId, limit).reverse();
}

export function bookStats(store: Store, bookId: number) {
  const chapters = listChapters(store, bookId);
  const words = chapters.reduce((a, c) => a + c.word_count, 0);
  const avg = chapters.length ? Math.round(words / chapters.length) : 0;
  const statusCount: Record<string, number> = {};
  for (const c of chapters) statusCount[c.status] = (statusCount[c.status] || 0) + 1;
  const cost = store.get<{ p: number; o: number; n: number }>(
    'SELECT COALESCE(SUM(prompt_chars),0) p, COALESCE(SUM(output_chars),0) o, COUNT(*) n FROM llm_calls WHERE book_id=?',
    bookId,
  )!;
  return { chapters: chapters.length, words, avg, statusCount, llmCalls: cost.n, promptChars: cost.p, outputChars: cost.o };
}
