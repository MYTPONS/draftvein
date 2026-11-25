import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type ForgeConfig } from '../config.ts';
import { Store } from '../db/index.ts';
import { Llm } from '../llm/client.ts';
import {
  createBook,
  getBook,
  listBooks,
  listChapters,
  getChapter,
  updateBook,
  saveChapter,
  listFacts,
  listTimeline,
  listCharacters,
  upsertCharacter,
  listRelations,
  currentRelations,
  addRelation,
  listOutlineDocs,
  upsertOutlineDoc,
  deleteOutlineDoc,
  listCategories,
  addCategory,
  removeCategory,
  listVolumes,
  createVolume,
  updateVolume,
  chapterTree,
  characterTimeline,
  repairStoredSuspectCharacters,
  type Book,
} from '../engine/book.ts';
import { buildContext, parseBeats } from '../engine/context.ts';
import { ensurePlan, ensureWindow, outlineView } from '../engine/outline.ts';
import { writeChapter, chapterDetail } from '../engine/chapter.ts';
import { runChapters, runView, eventView, lastEvents, bookStats } from '../engine/run.ts';
import { listThreads, threadHealth, upsertThread } from '../engine/ledger.ts';
import { pushChapter, exportBook, makeClient } from '../integrations/zuojia/push.ts';
import type { ZuojiaClient } from '../integrations/zuojia/client.ts';
import { createZuojiaSession, resolveConfigPath } from '../integrations/zuojia/session.ts';
import { fullCheck } from '../engine/consistency.ts';
import { pacingReport, listHighlights, addHighlight } from '../engine/pacing.ts';
import { TEMPLATES, listStages, seedStructure, stageAt, templateByKey } from '../engine/structure.ts';
import { listExpectations, upsertExpectation, expectationReport } from '../engine/expectations.ts';
import { suspectNames } from '../engine/book.ts';
import { rewriteParagraph } from '../engine/rewrite.ts';
import { pathToFileURL } from 'node:url';
import { ensureVoiceProfile, readVoiceProfile } from '../engine/voice.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '..', 'web');

export interface ServerHandle {
  server: http.Server;
  url: string;
  store: Store;
  llm: Llm;
  close: () => Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

export function createServer(opts: {
  cfg?: ForgeConfig;
  dbFile?: string;
  configPath?: string;
  zuojiaLoginImpl?: Parameters<typeof createZuojiaSession>[2]['loginImpl'];
  zuojiaValidateImpl?: Parameters<typeof createZuojiaSession>[2]['validateImpl'];
  zuojiaClientFactory?: () => ZuojiaClient;
} = {}): ServerHandle {
  const cfg = opts.cfg ?? loadConfig();
  const store = new Store(opts.dbFile ?? path.join(cfg.dataDir, 'novel-forge.db'));
  for (const b of store.all<{ id: number }>('SELECT id FROM books')) repairStoredSuspectCharacters(store, b.id);
  const zuojiaSession = createZuojiaSession(cfg, opts.configPath ?? resolveConfigPath(cfg), {
    loginImpl: opts.zuojiaLoginImpl,
    validateImpl: opts.zuojiaValidateImpl,
  });
  const llm = new Llm(cfg.llm, {
    onCall: (rec) => {
      try {
        store.run(
          'INSERT INTO llm_calls (purpose, provider, model, prompt_chars, output_chars, ms, ok, error, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          rec.purpose,
          rec.provider,
          rec.model,
          rec.promptChars,
          rec.outputChars,
          rec.ms,
          rec.ok ? 1 : 0,
          rec.error ?? '',
          new Date().toISOString(),
        );
      } catch {
        /* 记录失败不影响主流程 */
      }
    },
  });

  const reviewModel = process.env.NOVEL_FORGE_REVIEW_MODEL;
  const reviewLlm = reviewModel ? new Llm({ ...cfg.llm, model: reviewModel, temperature: 0.3 }) : undefined;
  const zuojiaClient = () => opts.zuojiaClientFactory?.() ?? makeClient(cfg);
  const sseClients = new Set<{ res: http.ServerResponse; bookId: number }>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url, store, cfg, llm, sseClients, zuojiaSession, reviewLlm, zuojiaClient);
        return;
      }
      serveStatic(res, url.pathname);
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  });

  return {
    server,
    url: `http://${cfg.host}:${cfg.port}`,
    store,
    llm,
    close: async () => {
      for (const c of sseClients) c.res.end();
      sseClients.clear();
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    },
  };
}

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  store: Store,
  cfg: ForgeConfig,
  llm: Llm,
  sseClients: Set<{ res: http.ServerResponse; bookId: number }>,
  zuojiaSession: ReturnType<typeof createZuojiaSession>,
  reviewLlm: Llm | undefined,
  zuojiaClient: () => ZuojiaClient,
) {
  const p = url.pathname.replace(/^\/api/, '');
  const method = req.method || 'GET';

  // 全局登录接口必须在书籍路由之前；建书选项依赖当前登录态，但本身不依赖某本书。
  if (p === '/zuojia/login' && method === 'GET') return json(res, 200, zuojiaSession.status());
  if (p === '/zuojia/login' && method === 'POST') return json(res, 202, zuojiaSession.start());
  if (p === '/zuojia/logout' && method === 'POST') {
    zuojiaSession.logout();
    return json(res, 200, { ok: true });
  }
  if (p === '/zuojia/create-options' && method === 'GET') {
    try {
      const client = zuojiaClient();
      const sites = await client.sites();
      const selectedSite = Number(url.searchParams.get('site') || sites[0]?.site || 0);
      const categories = selectedSite ? await client.newNovelInfo(selectedSite) : [];
      return json(res, 200, { sites, selectedSite, categories });
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }
  }

  // ── 健康/配置
  if (p === '/health') return json(res, 200, { ok: true, provider: cfg.llm.provider, model: cfg.llm.model, dataDir: cfg.dataDir });
  if (p === '/config') return json(res, 200, { lookahead: cfg.lookahead, provider: cfg.llm.provider, model: cfg.llm.model });
  if (p === '/zuojia/qr' && method === 'GET') {
    const qr = zuojiaSession.status().qrPath;
    if (!qr || !fs.existsSync(qr)) return json(res, 404, { error: '二维码尚未生成' });
    res.writeHead(200, { 'content-type': /\.png$/i.test(qr) ? 'image/png' : 'image/jpeg', 'cache-control': 'no-store' });
    fs.createReadStream(qr).pipe(res);
    return;
  }
  if (p === '/events/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
    const client = { res, bookId: 0 };
    sseClients.add(client);
    req.on('close', () => sseClients.delete(client));
    return;
  }

  // ── 书籍
  if (p === '/books' && method === 'GET') return json(res, 200, listBooks(store));
  if (p === '/books' && method === 'POST') {
    const body = await readJson(req);
    if (!body?.title) return json(res, 400, { error: '缺少 title' });
    const book = createBook(store, body);
    return json(res, 201, book);
  }

  const m = p.match(/^\/books\/(\d+)(\/.*)?$/);
  if (!m) return json(res, 404, { error: 'unknown api' });
  const book = getBook(store, Number(m[1]));
  if (!book) return json(res, 404, { error: 'book not found' });
  const rest = m[2] || '';

  if (rest === '' && method === 'GET') {
    return json(res, 200, { book, stats: bookStats(store, book.id), health: threadHealth(store, book.id, nextIdx(store, book.id)) });
  }
  if (rest === '' && method === 'PATCH') {
    const body = await readJson(req);
    updateBook(store, book.id, body);
    return json(res, 200, getBook(store, book.id));
  }
  if (rest === '/chapters' && method === 'GET') return json(res, 200, listChapters(store, book.id));
  if (rest === '/voice' && method === 'GET') return json(res, 200, { profile: readVoiceProfile(book) || null });
  if (rest === '/voice' && method === 'POST') {
    try {
      const updated = await ensureVoiceProfile(store, llm, book, { force: true, onEvent: () => {} });
      return json(res, 200, { profile: readVoiceProfile(updated) || null });
    } catch (err) {
      return json(res, 500, { error: (err as Error).message });
    }
  }
  if (rest === '/outline' && method === 'GET') return json(res, 200, outlineView(store, book.id));
  if (rest === '/threads') return json(res, 200, { threads: listThreads(store, book.id), health: threadHealth(store, book.id, nextIdx(store, book.id)) });
  if (rest === '/threads' && method === 'POST') {
    const body = await readJson(req);
    if (!body?.code || !body?.title) return json(res, 400, { error: '缺少 code/title' });
    return json(res, 201, upsertThread(store, book.id, body));
  }
  if (rest === '/tree' && method === 'GET') return json(res, 200, chapterTree(store, book.id));
  if (rest === '/character-timeline' && method === 'GET') return json(res, 200, characterTimeline(store, book.id));
  if (rest === '/structure' && method === 'GET') {
    let meta: any = {};
    try {
      meta = JSON.parse(book.data || '{}');
    } catch {}
    const key = meta.structure || 'three_act';
    const at = stageAt(store, book.id, nextIdx(store, book.id));
    return json(res, 200, {
      template: key,
      templateName: templateByKey(key).name,
      templates: TEMPLATES.map((t) => ({ key: t.key, name: t.name, desc: t.desc, stages: t.stages.length })),
      stages: at ? at.stages : listStages(store, book.id),
      current: at ? { stage: at.stage, pct: at.pct, total: at.total, chapterRange: at.chapterRange } : null,
    });
  }
  if (rest === '/structure/template' && method === 'POST') {
    const body = await readJson(req);
    const key = String(body?.key || 'three_act');
    seedStructure(store, book.id, key);
    let meta: any = {};
    try {
      meta = JSON.parse(book.data || '{}');
    } catch {}
    updateBook(store, book.id, { data: JSON.stringify({ ...meta, structure: key }) });
    return json(res, 200, { ok: true, template: key });
  }
  const sm = rest.match(/^\/structure\/stages\/(\d+)$/);
  if (sm && method === 'PATCH') {
    const body = await readJson(req);
    store.run(
      'UPDATE structure_stages SET name=COALESCE(?,name), goal=COALESCE(?,goal), start_pct=COALESCE(?,start_pct), end_pct=COALESCE(?,end_pct) WHERE id=? AND book_id=?',
      body.name ?? null,
      body.goal ?? null,
      body.start_pct != null ? Number(body.start_pct) : null,
      body.end_pct != null ? Number(body.end_pct) : null,
      Number(sm[1]),
      book.id,
    );
    return json(res, 200, listStages(store, book.id));
  }

  if (rest === '/expectations' && method === 'GET') {
    const idx = Number(url.searchParams.get('at') || nextIdx(store, book.id));
    return json(res, 200, { list: listExpectations(store, book.id), report: expectationReport(store, book.id, idx) });
  }
  if (rest === '/expectations' && method === 'POST') {
    const body = await readJson(req);
    if (!body?.code || !body?.title) return json(res, 400, { error: '缺少 code/title' });
    return json(res, 201, upsertExpectation(store, book.id, body));
  }
  const em = rest.match(/^\/expectations\/(\d+)$/);
  if (em && method === 'PATCH') {
    const body = await readJson(req);
    if (body?.status === 'fulfilled') {
      store.run(
        "UPDATE expectations SET status='fulfilled', fulfilled_idx=COALESCE(?,fulfilled_idx), fulfill_quote=COALESCE(?,fulfill_quote), updated_at=? WHERE id=? AND book_id=?",
        body.fulfilled_idx ?? nextIdx(store, book.id),
        body.quote ?? '',
        new Date().toISOString(),
        Number(em[1]),
        book.id,
      );
    } else {
      store.run('UPDATE expectations SET title=COALESCE(?,title), detail=COALESCE(?,detail), due_to=COALESCE(?,due_to) WHERE id=? AND book_id=?', body.title ?? null, body.detail ?? null, body.due_to ?? null, Number(em[1]), book.id);
    }
    return json(res, 200, listExpectations(store, book.id));
  }

  if (rest === '/pacing' && method === 'GET') return json(res, 200, { ...pacingReport(store, book.id), highlights: listHighlights(store, book.id) });
  if (rest === '/highlights' && method === 'GET') return json(res, 200, listHighlights(store, book.id));
  if (rest === '/highlights' && method === 'POST') {
    const body = await readJson(req);
    if (!body?.chapter_idx) return json(res, 400, { error: '缺少 chapter_idx' });
    addHighlight(store, book.id, {
      chapter_idx: Number(body.chapter_idx),
      kind: body.kind || 'beat',
      type: body.type || '爽感',
      intensity: Math.max(1, Math.min(5, Number(body.intensity) || 3)),
      title: body.title || '',
      quote: body.quote || '',
      setup_note: body.setup_note || '',
    });
    return json(res, 201, pacingReport(store, book.id));
  }

  if (rest === '/volumes' && method === 'GET') return json(res, 200, listVolumes(store, book.id));
  if (rest === '/volumes' && method === 'POST') {
    const body = await readJson(req);
    if (!body?.title) return json(res, 400, { error: '缺少卷名' });
    return json(res, 201, createVolume(store, book.id, { title: body.title, premise: body.premise, start: body.start ? Number(body.start) : undefined, end: body.end ? Number(body.end) : undefined }));
  }
  const vm = rest.match(/^\/volumes\/(\d+)$/);
  if (vm && method === 'PATCH') {
    const body = await readJson(req);
    return json(res, 200, updateVolume(store, book.id, Number(vm[1]), { ...body, realign: body.realign !== false }));
  }

  if (rest === '/outline-docs' && method === 'GET') return json(res, 200, listOutlineDocs(store, book.id));
  if (rest === '/outline-docs' && method === 'POST') {
    const body = await readJson(req);
    if (!body?.name) return json(res, 400, { error: '缺少纲名' });
    return json(res, 201, upsertOutlineDoc(store, book.id, body));
  }
  const om = rest.match(/^\/outline-docs\/(\d+)$/);
  if (om) {
    if (method === 'PATCH') {
      const body = await readJson(req);
      return json(res, 200, upsertOutlineDoc(store, book.id, { ...body, id: Number(om[1]) }));
    }
    if (method === 'DELETE') {
      deleteOutlineDoc(store, book.id, Number(om[1]));
      return json(res, 200, listOutlineDocs(store, book.id));
    }
  }

  if (rest === '/categories' && method === 'GET') {
    const scope = (url.searchParams.get('scope') || 'character') as 'character' | 'bible';
    return json(res, 200, listCategories(store, book.id, scope));
  }
  if (rest === '/categories' && method === 'POST') {
    const body = await readJson(req);
    const scope = (body?.scope || 'character') as 'character' | 'bible';
    if (!body?.name) return json(res, 400, { error: '缺少分类名' });
    return json(res, 201, addCategory(store, book.id, scope, String(body.name)));
  }
  if (rest === '/categories' && method === 'DELETE') {
    const name = url.searchParams.get('name') || '';
    const scope = (url.searchParams.get('scope') || 'character') as 'character' | 'bible';
    return json(res, 200, removeCategory(store, book.id, scope, name));
  }

  if (rest === '/relations' && method === 'GET') {
    return json(res, 200, { current: currentRelations(store, book.id), history: listRelations(store, book.id) });
  }
  if (rest === '/relations' && method === 'POST') {
    const body = await readJson(req);
    if (!body?.from_name || !body?.to_name || !body?.relation) return json(res, 400, { error: '缺少 from_name/to_name/relation' });
    return json(res, 201, addRelation(store, book.id, body));
  }
  if (rest === '/check' && method === 'GET') {
    const c = fullCheck(store, book.id);
    const p = pacingReport(store, book.id);
    const pacing = p.issues.map((i) => ({ severity: i.severity, type: 'pacing', chapter: i.chapter, message: i.message }));
    const exp = expectationReport(store, book.id, nextIdx(store, book.id));
    const expect = exp.issues.map((i) => ({ severity: i.severity, type: 'expectation', chapter: i.chapter, message: i.message }));
    return json(res, 200, {
      ...c,
      pacing,
      expectations: expect,
      summary: {
        block: c.summary.block + pacing.filter((i) => i.severity === 'block').length + expect.filter((i) => i.severity === 'block').length,
        warn: c.summary.warn + pacing.filter((i) => i.severity === 'warn').length + expect.filter((i) => i.severity === 'warn').length,
        info: c.summary.info + pacing.filter((i) => i.severity === 'info').length + expect.filter((i) => i.severity === 'info').length,
      },
      suspects: suspectsByChapter(store, book.id),
    });
  }
  if (rest === '/characters' && method === 'GET') {
    return json(res, 200, listCharacters(store, book.id));
  }
  if (rest === '/characters' && method === 'POST') {
    const body = await readJson(req);
    if (!body?.name) return json(res, 400, { error: '缺少 name' });
    return json(res, 201, upsertCharacter(store, book.id, body));
  }
  const cm2 = rest.match(/^\/characters\/(\d+)$/);
  if (cm2) {
    const id = Number(cm2[1]);
    if (method === 'PATCH') {
      const body = await readJson(req);
      const cur = store.get<{ name: string }>('SELECT name FROM characters WHERE id=? AND book_id=?', id, book.id);
      if (!cur) return json(res, 404, { error: 'character not found' });
      return json(res, 200, upsertCharacter(store, book.id, { ...body, name: body.name || cur.name }));
    }
    if (method === 'DELETE') {
      store.run('DELETE FROM characters WHERE id=? AND book_id=?', id, book.id);
      return json(res, 200, { ok: true });
    }
  }
  if (rest === '/bible' && method === 'GET') {
    return json(res, 200, store.all('SELECT * FROM bible WHERE book_id=? ORDER BY kind, importance DESC, id', book.id));
  }
  if (rest === '/bible' && method === 'POST') {
    const body = await readJson(req);
    if (!body?.name) return json(res, 400, { error: '缺少 name' });
    const r = store.run(
      'INSERT INTO bible (book_id, kind, category, name, content, tags, importance, locked, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      book.id,
      body.kind || 'character',
      body.category || '背景设定',
      body.name,
      body.content || '',
      body.tags || '',
      Number(body.importance) || 2,
      0,
      new Date().toISOString(),
    );
    return json(res, 201, store.get('SELECT * FROM bible WHERE id=?', r.lastInsertRowid));
  }
  if (rest === '/facts') return json(res, 200, listFacts(store, book.id));
  if (rest === '/timeline') return json(res, 200, listTimeline(store, book.id));
  if (rest === '/runs') return json(res, 200, runView(store, book.id));
  if (rest === '/events') return json(res, 200, lastEvents(store, book.id, Number(url.searchParams.get('limit') || 60)));
  if (rest === '/pushes') {
    return json(res, 200, store.all('SELECT * FROM pushes WHERE book_id=? ORDER BY id DESC LIMIT 50', book.id));
  }
  if (rest === '/stats') {
    const daily = dailyWords(store, book.id);
    return json(res, 200, { ...bookStats(store, book.id), daily, ...goalStats(store, book, daily) });
  }

  if (rest === '/events/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ bookId: book.id })}\n\n`);
    const client = { res, bookId: book.id };
    sseClients.add(client);
    req.on('close', () => sseClients.delete(client));
    return;
  }

  // 单章生成
  if (rest === '/write' && method === 'POST') {
    const body = await readJson(req);
    const idx = Number(body?.idx) || nextIdx(store, book.id);
    const emit = (stage: string, message: string, data?: any) => {
      const payload = { stage, message, data, at: new Date().toISOString(), idx };
      for (const c of sseClients) {
        if (!c.bookId || c.bookId === book.id) c.res.write(`event: log\ndata: ${JSON.stringify(payload)}\n\n`);
      }
    };
    try {
      const result = await writeChapter(store, llm, book, idx, { onEvent: emit, reviseOnly: Boolean(body?.reviseOnly), reviewLlm });
      return json(res, 200, result);
    } catch (err) {
      return json(res, 500, { error: (err as Error).message });
    }
  }

  // 批量推进（仍是逐章循环）
  if (rest === '/run' && method === 'POST') {
    const body = await readJson(req);
    const emit = (stage: string, message: string, data?: any) => {
      const payload = { stage, message, data, at: new Date().toISOString() };
      for (const c of sseClients) c.res.write(`event: log\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    try {
      const summary = await runChapters(store, llm, book, { count: Number(body?.count) || 1, from: body?.from ? Number(body.from) : undefined, onEvent: emit, reviewLlm });
      return json(res, 200, summary);
    } catch (err) {
      return json(res, 500, { error: (err as Error).message });
    }
  }

  // 规划窗口
  if (rest === '/plan' && method === 'POST') {
    const body = await readJson(req);
    const from = Number(body?.from) || nextIdx(store, book.id);
    const count = Math.max(1, Math.min(Number(body?.count) || 1, 5));
    try {
      const plans = await ensureWindow(store, llm, book, from, count, { onEvent: () => {} });
      return json(res, 200, plans);
    } catch (err) {
      return json(res, 500, { error: (err as Error).message });
    }
  }

  const cm = rest.match(/^\/chapters\/(\d+)$/);
  if (cm) {
    const idx = Number(cm[1]);
    if (method === 'GET') return json(res, 200, chapterDetail(store, book.id, idx));
    if (method === 'POST') {
      // 选中段落局部改写
      const body = await readJson(req);
      const ch = getChapter(store, book.id, idx);
      if (!ch) return json(res, 404, { error: `第 ${idx} 章没有正文` });
      const target = String(body?.paragraph || '');
      if (!target || !ch.content.includes(target)) return json(res, 400, { error: '要改写的段落不在正文里（内容可能已变）' });
      const pos = ch.content.indexOf(target);
      const before = ch.content.slice(Math.max(0, pos - 400), pos);
      const after = ch.content.slice(pos + target.length, pos + target.length + 400);
      const next = await rewriteParagraph(llm, { book, chapterIdx: idx, paragraph: target, instruction: String(body?.instruction || ''), before, after });
      const content = ch.content.replace(target, next);
      const saved = saveChapter(store, book.id, idx, { title: ch.title, content, status: ch.status });
      return json(res, 200, { old: target, next, chapter: saved });
    }
    if (method === 'PATCH') {
      const body = await readJson(req);
      if (body?.volume_id !== undefined) {
        store.run('UPDATE chapters SET volume_id=? WHERE book_id=? AND idx=?', body.volume_id === null ? null : Number(body.volume_id), book.id, idx);
        store.run('UPDATE chapter_plans SET volume_id=? WHERE book_id=? AND idx=?', body.volume_id === null ? null : Number(body.volume_id), book.id, idx);
      }
      return json(res, 200, { ok: true });
    }
    if (method === 'PUT') {
      const body = await readJson(req);
      const ch = getChapter(store, book.id, idx);
      const saved = saveChapter(store, book.id, idx, {
        title: body?.title ?? ch?.title ?? '',
        content: body?.content ?? ch?.content ?? '',
        status: body?.status ?? ch?.status ?? 'draft',
      });
      return json(res, 200, saved);
    }
  }

  if (rest === '/push' && method === 'POST') {
    const body = await readJson(req);
    const idx = Number(body?.idx);
    try {
      const out = await pushChapter(store, cfg, book, idx, {
        cbid: body?.cbid,
        cvid: body?.cvid,
        publish: Boolean(body?.publish),
        dryRun: Boolean(body?.dryRun),
      });
      return json(res, 200, out);
    } catch (err) {
      return json(res, 400, { error: (err as Error).message, kind: (err as any)?.name });
    }
  }

  if (rest === '/zuojia' && method === 'GET') {
    const binding = cfg.zuojia.books[book.slug] || cfg.zuojia.books[String(book.id)] || '';
    const login = zuojiaSession.status();
    if (login.status === 'connected') return json(res, 200, { connected: true, me: login.me, binding, login, canLogin: true });
    if (!cfg.zuojia.token) return json(res, 200, { connected: false, reason: '尚未登录', binding, login, canLogin: true });
    try {
      const client = makeClient(cfg);
      const me = await client.me();
      return json(res, 200, { connected: true, me, binding, login, canLogin: true });
    } catch (err) {
      return json(res, 200, { connected: false, reason: (err as Error).message, binding, login, canLogin: true });
    }
  }

  if (rest === '/zuojia/bind' && method === 'POST') {
    const body = await readJson(req);
    try {
      zuojiaSession.bindBook(book.slug, String(body?.cbid || ''));
      return json(res, 200, { ok: true, binding: cfg.zuojia.books[book.slug] });
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }
  }

  if (rest === '/zuojia/books' && method === 'GET') {
    try {
      return json(res, 200, await zuojiaClient().books());
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }
  }

  if (rest === '/zuojia/create' && method === 'POST') {
    const body = await readJson(req);
    try {
      const title = String(body?.title || book.title || '').trim();
      const site = Number(body?.site);
      if (!title) throw new Error('作品名不能为空');
      if ([...title].length > 15) throw new Error('作品名最多 15 个字');
      if (!Number.isFinite(site) || site <= 0) throw new Error('请选择发布站点');
      const client = zuojiaClient();
      const categories = await client.newNovelInfo(site);
      const categoryid = String(body?.categoryid || categories[0]?.categoryid || '');
      const category = categories.find((c) => c.categoryid === categoryid) || categories[0];
      if (!category) throw new Error('该站点没有可用分类');
      const subcategoryid = String(body?.subcategoryid || category.subcategories[0]?.subcategoryid || '');
      if (!subcategoryid) throw new Error('该分类没有可用子分类');
      let novelgroup = '';
      try {
        const groupInfo = await client.novelGroups({ site, categoryid: category.categoryid, subcategoryid });
        novelgroup = groupInfo.lastNovelGroup || groupInfo.groups[0]?.novelgroup || '';
      } catch {
        // 编辑组接口偶发失败时仍可建书；网页端也允许不选编辑组继续提交。
      }
      const created = await client.createNovel({
        site,
        categoryid: category.categoryid,
        subcategoryid,
        title,
        intro: String(body?.intro || book.premise || ''),
        novelgroup,
      });
      zuojiaSession.bindBook(book.slug, created.cbid);
      return json(res, 200, { ok: true, ...created, binding: cfg.zuojia.books[book.slug] });
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }
  }

  if (rest === '/export' && method === 'POST') {
    const body = await readJson(req);
    const outDir = body?.dir || path.join(cfg.dataDir, 'exports', book.slug);
    return json(res, 200, exportBook(store, book, outDir, { format: body?.format === 'docx' ? 'docx' : 'txt' }));
  }

  return json(res, 404, { error: `unknown endpoint ${rest}` });
}

function suspectsByChapter(store: Store, bookId: number) {
  const out: { chapter: number; names: string[] }[] = [];
  for (const ch of store.all<{ idx: number; checks: string }>('SELECT idx, checks FROM chapters WHERE book_id=?', bookId)) {
    try {
      const c = JSON.parse(ch.checks || '{}');
      if (Array.isArray(c.suspects) && c.suspects.length) out.push({ chapter: ch.idx, names: c.suspects });
    } catch {}
  }
  return out;
}

/** 按日落字数（取自 chapters.created_at 的本地日期） */
/** 日更目标与连续打卡天数 */
export function goalStats(store: Store, book: Book, daily: { date: string; words: number }[]) {
  let meta: any = {};
  try {
    meta = JSON.parse(book.data || '{}');
  } catch {}
  const goal = Number(meta.dailyGoal) || 0;
  const today = daily.at(-1)?.words || 0;
  let streak = 0;
  for (let i = daily.length - 1; i >= 0; i--) {
    const d = daily[i];
    const isToday = i === daily.length - 1;
    if (goal > 0) {
      if (d.words >= goal) streak++;
      else if (isToday) continue; // 今天还没达标不算断
      else break;
    } else {
      if (d.words > 0) streak++;
      else if (isToday) continue;
      else break;
    }
  }
  return { dailyGoal: goal, todayWords: today, goalProgress: goal ? Math.min(1, today / goal) : 0, streak };
}

export function dailyWords(store: Store, bookId: number) {
  const rows = store.all<{ d: string; w: number; n: number }>(
    "SELECT substr(created_at,1,10) d, SUM(word_count) w, COUNT(*) n FROM chapters WHERE book_id=? GROUP BY d ORDER BY d",
    bookId,
  );
  const map = new Map(rows.map((r) => [r.d, r]));
  const out: { date: string; words: number; chapters: number }[] = [];
  const today = new Date();
  for (let i = 13; i >= 0; i--) {
    const dt = new Date(today.getTime() - i * 86400000);
    const key = dt.toISOString().slice(0, 10);
    const hit = map.get(key);
    out.push({ date: key, words: hit ? Number(hit.w) : 0, chapters: hit ? Number(hit.n) : 0 });
  }
  return out;
}

function nextIdx(store: Store, bookId: number): number {
  const a = store.get<{ m: number }>('SELECT COALESCE(MAX(idx),0) m FROM chapters WHERE book_id=?', bookId)!;
  return a.m + 1;
}

function json(res: http.ServerResponse, status: number, data: any) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`body 不是合法 JSON: ${(err as Error).message}`));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res: http.ServerResponse, pathname: string) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(webDir, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(webDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

export async function startServer(overrides: Partial<ForgeConfig> = {}): Promise<ServerHandle> {
  const cfg = loadConfig(overrides);
  const handle = createServer({ cfg });
  await new Promise<void>((resolve, reject) => {
    handle.server.once('error', reject);
    handle.server.listen(cfg.port, cfg.host, () => resolve());
  });
  handle.url = `http://${cfg.host}:${cfg.port}`;
  return handle;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const h = await startServer();
  console.log(`novel-forge 控制台：${h.url}`);
}
