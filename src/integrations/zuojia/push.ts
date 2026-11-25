import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../../db/index.ts';
import type { ForgeConfig } from '../../config.ts';
import { nowIso } from '../../config.ts';
import type { Book } from '../../engine/book.ts';
import { getChapter, listChapters } from '../../engine/book.ts';
import { ZuojiaClient, ZuojiaError } from './client.ts';
import { buildDocx } from '../../export/docx.ts';

export interface PushOutcome {
  idx: number;
  action: 'draft' | 'publish';
  remoteChapterId: string;
  title: string;
  words: number;
  raw?: any;
}

export interface PushOptions {
  /** 远端作品 CBID；不传则用配置映射 */
  cbid?: string;
  /** 远端卷 CVID；不传则用远端第一卷 */
  cvid?: string;
  publish?: boolean;
  dryRun?: boolean;
  client?: ZuojiaClient;
}

function remoteMap(store: Store, bookId: number, idx: number) {
  return store.get<{ remote_chapter_id: string; remote_volume_id: string; remote_book_id: string }>(
    "SELECT remote_chapter_id, remote_volume_id, remote_book_id FROM pushes WHERE book_id=? AND chapter_idx=? AND platform='zuojia' AND status='ok' ORDER BY id DESC LIMIT 1",
    bookId,
    idx,
  );
}

export function makeClient(cfg: ForgeConfig, overrides: Partial<{ token: string; serial: string; cookie: string }> = {}) {
  const token = overrides.token || cfg.zuojia.token;
  if (!token) {
    throw new ZuojiaError(
      '缺少作家助手登录态。请在工作的「递交」页点「扫码登录作家助手」；终端用户也可运行 novel-forge zuojia-login',
    );
  }
  return new ZuojiaClient({ token, serial: overrides.serial || cfg.zuojia.serial, cookie: overrides.cookie || cfg.zuojia.cookie, baseUrl: cfg.zuojia.baseUrl });
}

export async function pushChapter(store: Store, cfg: ForgeConfig, book: Book, idx: number, opts: PushOptions = {}): Promise<PushOutcome> {
  const ch = getChapter(store, book.id, idx);
  if (!ch || !ch.content.trim()) throw new Error(`第 ${idx} 章还没有正文`);

  const cbid = opts.cbid || cfg.zuojia.books[book.slug] || cfg.zuojia.books[String(book.id)];
  if (!cbid) throw new Error(`这本书还没有绑定远端作品。请在「递交」页创建工作台作品，或选择已有作品绑定（${book.slug}）`);

  const prev = remoteMap(store, book.id, idx);
  const cvid = opts.cvid || prev?.remote_volume_id || '';
  const ccid = prev?.remote_chapter_id || '-1';
  const action: 'draft' | 'publish' = opts.publish ? 'publish' : 'draft';

  if (opts.dryRun) {
    return { idx, action, remoteChapterId: ccid, title: ch.title, words: ch.word_count };
  }

  const client = opts.client ?? makeClient(cfg);

  let raw: any;
  let remoteId = ccid;
  if (action === 'draft') {
    raw = await client.saveChapter({ cbid, ccid, cvid, title: ch.title, content: ch.content, extra: ch.summary, sort: idx });
    remoteId = String(raw?.CCID || raw?.CID || ccid);
  } else {
    if (ccid === '-1') throw new Error('发布前必须先推一次草稿，拿到远端章节 ID');
    raw = await client.publishChapter({ cbid, ccid, cvid, bookTitle: book.title, title: ch.title, content: ch.content, words: ch.word_count });
    remoteId = ccid;
  }

  store.run(
    `INSERT INTO pushes (book_id, chapter_idx, platform, remote_book_id, remote_volume_id, remote_chapter_id, action, status, response, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    book.id,
    idx,
    'zuojia',
    cbid,
    cvid,
    remoteId,
    action,
    'ok',
    JSON.stringify(raw ?? {}).slice(0, 4000),
    nowIso(),
  );

  return { idx, action, remoteChapterId: remoteId, title: ch.title, words: ch.word_count, raw };
}

/** 导出为可导入的 txt / docx（每章一文件 + 合并本 + 元数据） */
export function exportBook(store: Store, book: Book, outDir: string, opts: { format?: 'txt' | 'docx' } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const chapters = listChapters(store, book.id);
  const merged: string[] = [`# ${book.title}`, ''];
  for (const c of chapters) {
    if (!c.content.trim()) continue;
    const name = `${String(c.idx).padStart(4, '0')}-${safeName(c.title)}.txt`;
    fs.writeFileSync(path.join(outDir, name), c.content, 'utf8');
    merged.push(`第${c.idx}章 ${c.title}`, '', c.content, '');
  }
  fs.writeFileSync(path.join(outDir, 'merged.txt'), merged.join('\n'), 'utf8');
  let meta: any = {};
  try {
    meta = JSON.parse(book.data || '{}');
  } catch {}
  const manifest = {
    title: book.title,
    genre: book.genre,
    intro: book.premise,
    audience: book.audience,
    tags: String(meta.tags || '').split(/[、,，\s]+/).filter(Boolean),
    chapters: chapters.map((c) => ({ idx: c.idx, title: c.title, words: c.word_count, status: c.status })),
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  let docxFile = '';
  if (opts.format === 'docx') {
    const buf = buildDocx({
      title: book.title,
      author: String(meta.author || ''),
      intro: book.premise,
      tags: manifest.tags,
      chapters: chapters.filter((c) => c.content.trim()).map((c) => ({ idx: c.idx, title: c.title, content: c.content })),
    });
    docxFile = path.join(outDir, `${safeName(book.title)}.docx`);
    fs.writeFileSync(docxFile, buf);
  }
  return { dir: outDir, files: chapters.length, docx: docxFile || undefined };
}

function safeName(s: string): string {
  return String(s || 'untitled')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .slice(0, 40);
}
