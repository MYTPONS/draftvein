#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from './config.ts';
import { Store } from './db/index.ts';
import { Llm } from './llm/client.ts';
import { createBook, getBook, listBooks, listChapters, getChapter, getPlan, listVersions, restoreVersion, saveChapter, type Book } from './engine/book.ts';
import { writeChapter, chapterDetail } from './engine/chapter.ts';
import { runChapters, bookStats, lastEvents } from './engine/run.ts';
import { ensurePlan, ensureWindow, outlineView } from './engine/outline.ts';
import { listThreads, threadHealth, upsertThread } from './engine/ledger.ts';
import { inspect } from './engine/quality.ts';
import { exportBook, pushChapter, makeClient } from './integrations/zuojia/push.ts';
import { browserLogin, saveLoginToConfig } from './integrations/zuojia/login.ts';
import { deconstructFile, listTemplates, templatePrompt } from './engine/deconstruct.ts';
import { rewriteParagraph } from './engine/rewrite.ts';
import { inspect as inspectQuality, missingMusts } from './engine/quality.ts';
import { updateBook } from './engine/book.ts';
import { startServer } from './server/index.ts';
import { parseBeats } from './engine/context.ts';
import { ensureVoiceProfile, readVoiceProfile } from './engine/voice.ts';

function parseArgs(argv: string[]) {
  const out: { _: string[]; flags: Record<string, any> } = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out.flags[key] = next;
        i++;
      } else out.flags[key] = true;
    } else out._.push(a);
  }
  return out;
}

function open() {
  const cfg = loadConfig();
  const store = new Store(path.join(cfg.dataDir, 'draftvein.db'));
  const llm = new Llm(cfg.llm);
  const reviewModel = process.env.DRAFTVEIN_REVIEW_MODEL;
  const reviewLlm = reviewModel ? new Llm({ ...cfg.llm, model: reviewModel, temperature: 0.3 }) : undefined;
  return { cfg, store, llm, reviewLlm };
}

function requireBook(store: Store, ref: string | undefined): Book {
  if (!ref) throw new Error('需要指定书籍：--book <id|slug>');
  const b = getBook(store, ref);
  if (!b) throw new Error(`找不到书：${ref}`);
  return b;
}

async function main() {
  const { _: pos, flags } = parseArgs(process.argv.slice(2));
  const cmd = pos[0] || 'help';

  if (cmd === 'serve') {
    const h = await startServer();
    console.log(`draftvein 控制台：${h.url}`);
    return;
  }

  if (cmd === 'new') {
    const { store } = open();
    const title = pos[1] || flags.title;
    if (!title) throw new Error('用法：draftvein new "书名" --genre 玄幻 --premise "..."');
    const book = createBook(store, {
      title,
      genre: flags.genre,
      premise: flags.premise,
      audience: flags.audience,
      targetWords: flags.words ? Number(flags.words) : undefined,
    });
    console.log(JSON.stringify(book, null, 2));
    store.close();
    return;
  }

  if (cmd === 'books') {
    const { store } = open();
    for (const b of listBooks(store)) {
      console.log(`${b.id}\t${b.slug}\t${b.title}\t${b.chapters}章/${b.words}字\t未收线索 ${b.openThreads}`);
    }
    store.close();
    return;
  }

  if (cmd === 'plan') {
    const { cfg, store, llm } = open();
    const book = requireBook(store, flags.book);
    const from = Number(flags.from) || 1;
    const count = Number(flags.count) || 1;
    const plans = await ensureWindow(store, llm, book, from, count, { onEvent: (m) => console.log(`· ${m}`) });
    console.log(JSON.stringify(plans, null, 2));
    store.close();
    return;
  }

  if (cmd === 'voice') {
    const { store, llm } = open();
    const book = requireBook(store, flags.book);
    const updated = await ensureVoiceProfile(store, llm, book, {
      force: Boolean(flags.regen),
      onEvent: (m) => console.log(`· ${m}`),
    });
    console.log(JSON.stringify(readVoiceProfile(updated), null, 2));
    store.close();
    return;
  }

  if (cmd === 'write') {
    const { store, llm, reviewLlm } = open();
    const book = requireBook(store, flags.book);
    const from = Number(flags.from) || 0;
    const count = Number(flags.count) || 1;
    console.log(reviewLlm ? `审稿模型：${reviewLlm.cfg.model}` : '审稿模型：与主模型相同');
    const summary = await runChapters(store, llm, book, {
      count,
      from: from || undefined,
      onEvent: (stage, message) => console.log(`[${stage}] ${message}`),
      reviewLlm,
    });
    console.log(JSON.stringify(summary, null, 2));
    store.close();
    return;
  }

  if (cmd === 'revise') {
    const { store, llm, reviewLlm } = open();
    const book = requireBook(store, flags.book);
    const idx = Number(flags.idx);
    const r = await writeChapter(store, llm, book, idx, { reviseOnly: true, reviewLlm, onEvent: (s, m) => console.log(`[${s}] ${m}`) });
    console.log(JSON.stringify({ idx: r.idx, words: r.words, score: r.report.score, issues: r.report.issues }, null, 2));
    store.close();
    return;
  }

  if (cmd === 'show') {
    const { store } = open();
    const book = requireBook(store, flags.book);
    const idx = Number(flags.idx);
    const d = chapterDetail(store, book.id, idx);
    if (!d.chapter) throw new Error(`第 ${idx} 章不存在`);
    console.log(`第${idx}章 ${d.chapter.title}（${d.chapter.word_count} 字，${d.chapter.status}）\n`);
    console.log(d.chapter.content);
    console.log('\n--- 摘要 ---\n' + d.chapter.summary);
    store.close();
    return;
  }

  if (cmd === 'check') {
    const { store } = open();
    const book = requireBook(store, flags.book);
    const idx = Number(flags.idx);
    const ch = getChapter(store, book.id, idx);
    if (!ch) throw new Error(`第 ${idx} 章不存在`);
    const report = inspect(ch.content, { targetWords: book.target_words });
    console.log(JSON.stringify(report, null, 2));
    store.close();
    return;
  }

  if (cmd === 'outline') {
    const { store } = open();
    const book = requireBook(store, flags.book);
    console.log(JSON.stringify(outlineView(store, book.id), null, 2));
    store.close();
    return;
  }

  if (cmd === 'threads') {
    const { store } = open();
    const book = requireBook(store, flags.book);
    if (flags.add) {
      const t = upsertThread(store, book.id, {
        code: String(flags.add),
        title: String(flags.title || flags.add),
        detail: String(flags.detail || ''),
        due_from: flags.dueFrom ? Number(flags.dueFrom) : undefined,
        due_to: flags.dueTo ? Number(flags.dueTo) : undefined,
        priority: flags.priority ? Number(flags.priority) : 2,
      });
      console.log(JSON.stringify(t, null, 2));
    }
    const h = threadHealth(store, book.id, Number(flags.at) || 1);
    console.log(
      `线索 ${h.total} 条：open ${h.open}／逾期 ${h.overdue}／即将到期 ${h.dueSoon}／已收 ${h.resolved}（回收率 ${(h.resolveRate * 100).toFixed(0)}%，平均跨度 ${h.avgSpan.toFixed(1)} 章）`,
    );
    for (const t of listThreads(store, book.id)) {
      console.log(`  [${t.status}] ${t.code}｜${t.title}｜埋${t.planted_idx ?? '-'}→收${t.resolved_idx ?? '-'}｜窗口 ${t.due_from ?? '-'}-${t.due_to ?? '-'}`);
    }
    store.close();
    return;
  }

  if (cmd === 'export') {
    const { cfg, store } = open();
    const book = requireBook(store, flags.book);
    const dir = flags.dir || path.join(cfg.dataDir, 'exports', book.slug);
    const r = exportBook(store, book, dir);
    console.log(`导出 ${r.files} 章 → ${r.dir}`);
    store.close();
    return;
  }

  if (cmd === 'push') {
    const { cfg, store } = open();
    const book = requireBook(store, flags.book);
    const out = await pushChapter(store, cfg, book, Number(flags.idx), {
      cbid: flags.cbid,
      cvid: flags.cvid,
      publish: Boolean(flags.publish),
      dryRun: Boolean(flags.dryRun),
    });
    console.log(JSON.stringify(out, null, 2));
    store.close();
    return;
  }

  if (cmd === 'zuojia-login') {
    const { cfg } = open();
    const timeoutSec = Number(flags.timeout || 300);
    const qrPath = String(flags.qr || '');
    console.log(`打开阅文登录页，二维码存到 ${qrPath || '~/.draftvein/zuojia-qr.png'}，用微信扫（${timeoutSec}s 内有效）`);
    const r = await browserLogin({
      timeoutSec,
      qrPath: qrPath || undefined,
      user: flags.user ? String(flags.user) : undefined,
      pass: flags.pass ? String(flags.pass) : undefined,
    });
    if (!r.ok) {
      console.log(`没抓到登录态。二维码：${r.qrPath}，扫码后再跑一次或加大 --timeout`);
      console.log(`已拿到的 cookie：${r.cookies.map((c) => c.name).join(',') || '（空）'}`);
      process.exitCode = 2;
      return;
    }
    const cfgPath = String(flags.config || `${process.env.DRAFTVEIN_HOME || cfg.dataDir + '/..'}/config.json`);
    saveLoginToConfig(cfgPath, r);
    console.log(`登录成功，已写入 ${cfgPath}`);
    console.log(`token: ${r.token.slice(0, 8)}…  cookie 数：${r.cookies.length}`);
    const client = makeClient({ ...cfg.zuojia, token: r.token, cookie: r.cookie });
    const me = await client.me().catch((e: any) => ({ error: String(e.message || e) }));
    console.log('远端校验：', JSON.stringify(me).slice(0, 240));
    return;
  }

  if (cmd === 'zuojia') {
    const { cfg } = open();
    const sub = pos[1] || 'me';
    const client = makeClient(cfg);
    if (sub === 'me') console.log(JSON.stringify(await client.me(), null, 2));
    else if (sub === 'books') console.log(JSON.stringify(await client.books(), null, 2));
    else if (sub === 'volumes') console.log(JSON.stringify(await client.volumes(String(flags.cbid)), null, 2));
    else throw new Error('用法：draftvein zuojia me|books|volumes --cbid <id>');
    return;
  }

  if (cmd === 'deconstruct') {
    const { store } = open();
    const file = String(flags.file || pos[1] || '');
    if (!file) throw new Error('用法：draftvein deconstruct --file 参考小说.txt [--name 模板名] [--genre 悬疑]');
    const t = deconstructFile(store, file, { name: flags.name, genre: flags.genre });
    console.log(`拆完：${t.name}｜${t.chapters} 章｜${t.avg_words} 字/章｜对白 ${(t.dialogue * 100).toFixed(0)}%｜钩子分布 ${t.hook_dist}`);
    console.log(t.beat_rhythm);
    store.close();
    return;
  }

  if (cmd === 'templates') {
    const { store } = open();
    const list = listTemplates(store);
    if (!list.length) console.log('还没有模板，先 deconstruct 一本参考书');
    for (const t of list) console.log(`${t.id}\t${t.name}\t${t.genre || '-'}\t${t.chapters}章\t${t.avg_words}字/章\t对白${(t.dialogue * 100).toFixed(0)}%`);
    store.close();
    return;
  }

  if (cmd === 'template-use') {
    const { store } = open();
    const book = requireBook(store, flags.book);
    const name = String(flags.name || '');
    const t = store.get<{ name: string }>('SELECT name FROM writing_templates WHERE name=?', name);
    if (!t) throw new Error(`模板不存在：${name}（先 templates 看列表）`);
    let data: any = {};
    try {
      data = JSON.parse(book.data || '{}');
    } catch {}
    updateBook(store, book.id, { data: JSON.stringify({ ...data, template: t.name }) });
    console.log(`已把《${book.title}》绑定到模板「${t.name}」`);
    console.log(templatePrompt(store.get<any>('SELECT * FROM writing_templates WHERE name=?', t.name)).slice(0, 300));
    store.close();
    return;
  }

  if (cmd === 'fix') {
    const { store, llm } = open();
    const book = requireBook(store, flags.book);
    const idx = Number(flags.chapter || 0);
    if (!idx) throw new Error('用法：draftvein fix --book 1 --chapter 3 --quote "原文片段" --instruction "怎么改"');
    const ch = getChapter(store, book.id, idx);
    if (!ch) throw new Error(`第 ${idx} 章不存在`);
    const quote = String(flags.quote || '');
    const instruction = String(flags.instruction || '');
    const paras = ch.content.split(/\n+/).filter((x) => x.trim());
    const hit = quote ? paras.findIndex((p) => p.includes(quote)) : -1;
    const i = hit >= 0 ? hit : Number(flags.paragraph || 0) - 1;
    if (i < 0 || i >= paras.length) throw new Error('找不到要改的段落：给 --quote 或 --paragraph');
    if (!instruction) throw new Error('缺 --instruction（要它怎么改）');
    const before = i > 0 ? paras[i - 1] : '';
    const after = i < paras.length - 1 ? paras[i + 1] : '';
    const next = await rewriteParagraph(llm, { book, chapterIdx: idx, paragraph: paras[i], instruction, before, after });
    paras[i] = next;
    const saved = saveChapter(store, book.id, idx, { ...ch, content: paras.join('\n\n'), revision: (ch.revision || 0) + 1 } as any);
    console.log(`已改第 ${idx} 章第 ${i + 1} 段（${ch.content.length} → ${saved.content.length} 字）`);
    console.log(next);
    store.close();
    return;
  }

  if (cmd === 'recheck') {
    const { store } = open();
    const book = requireBook(store, flags.book);
    const idx = Number(flags.chapter || 0);
    const ch = getChapter(store, book.id, idx);
    if (!ch) throw new Error(`第 ${idx} 章不存在`);
    const plan = getPlan(store, book.id, idx);
    const prev = listChapters(store, book.id).filter((c) => c.idx < idx).slice(-3).map((c) => c.content);
    let planCast: string[] = [];
    try {
      const parsed = JSON.parse(plan?.cast || '[]');
      planCast = Array.isArray(parsed) ? parsed : [];
    } catch {
      planCast = [];
    }
    const plannedPlaces = [...new Set(parseBeats(plan?.beats || '').map((b) => b.place).filter((x): x is string => Boolean(x)))];
    const report = inspectQuality(ch.content, {
      targetWords: book.target_words,
      previous: prev,
      pov: plan?.pov || planCast[0] || '',
      cast: planCast,
      plannedPlaces,
    });
    let musts: string[] = [];
    try {
      musts = JSON.parse(plan?.musts || '[]');
    } catch {
      musts = [];
    }
    const missing = missingMusts(musts, ch.content);
    if (missing.length) {
      report.issues.push({ severity: 'warn', type: 'must', message: `本章缺 ${missing.length} 项必须出现的东西：${missing.join('、')}`, fix: '补进具体动作或台词' });
      report.score = Math.max(1, report.score - 5 * Math.min(missing.length, 4));
    }
    const hs = store.all<{ kind: string; intensity: number }>('SELECT kind, intensity FROM highlights WHERE book_id=? AND chapter_idx=?', book.id, idx);
    const old = JSON.parse(ch.checks || '{}');
    const checks = {
      ...old,
      report,
      musts: { total: musts.length, missing },
      pacing: { hook: hs.some((h) => h.kind === 'hook'), maxIntensity: hs.reduce((a, h) => Math.max(a, h.intensity || 0), 0), highlights: old.pacing?.highlights || [] },
    };
    saveChapter(store, book.id, idx, { title: ch.title, content: ch.content, summary: ch.summary, status: ch.status, checks, revision: ch.revision });
    console.log(`第 ${idx} 章重算：质检 ${report.score}，must 缺 ${missing.length}/${musts.length}，钩子 ${checks.pacing.hook}`);
    store.close();
    return;
  }

  if (cmd === 'versions') {
    const { store } = open();
    const book = requireBook(store, flags.book);
    const idx = Number(flags.chapter || 1);
    const list = listVersions(store, book.id, idx);
    if (!list.length) console.log('没有历史版本');
    for (const v of list) console.log(`${v.id}\t第${idx}章\trev ${v.revision}\t${v.word_count}字\t${v.created_at}`);
    store.close();
    return;
  }

  if (cmd === 'rollback') {
    const { store } = open();
    const book = requireBook(store, flags.book);
    const versionId = Number(flags.version || 0);
    if (!versionId) throw new Error('用法：draftvein rollback --book 1 --version <id>（先 versions 查）');
    const ch = listVersions(store, book.id, Number(flags.chapter || 1)).find((v) => v.id === versionId);
    if (!ch) throw new Error('版本不存在');
    restoreVersion(store, book.id, Number(flags.chapter || 1), versionId);
    console.log(`已回滚到版本 ${versionId}`);
    store.close();
    return;
  }

  if (cmd === 'logs') {
    const { store } = open();
    const book = requireBook(store, flags.book);
    for (const e of lastEvents(store, book.id, Number(flags.limit) || 40)) {
      console.log(`${e.created_at} [${e.stage}] ${e.message}`);
    }
    console.log(JSON.stringify(bookStats(store, book.id), null, 2));
    store.close();
    return;
  }

  if (cmd === 'config') {
    const cfg = loadConfig();
    console.log(JSON.stringify({ ...cfg, llm: { ...cfg.llm, apiKey: cfg.llm.apiKey ? '***' : '' }, zuojia: { ...cfg.zuojia, token: cfg.zuojia.token ? '***' : '' } }, null, 2));
    return;
  }

  console.log(`draftvein — 逐章推进的长篇小说框架

  serve                         启动控制台（默认 http://127.0.0.1:4260）
  new "书名" --genre --premise   新建书
  books                         列出书
  plan --book B --from N --count K   只规划单章（K 章窗口，不生成正文）
  voice --book B [--regen]     查看本书专属叙事声纹；--regen 重生成
  write --book B [--from N] --count K  逐章生成（每章：规划→场景→质检→审稿→抽取）
  revise --book B --idx N       不重写，只对已落库正文返工
  show --book B --idx N         看某一章
  check --book B --idx N        规则质检报告
  outline --book B              卷/章计划视图
  threads --book B [--at N]     伏笔台账与健康度
  export --book B [--dir D]     导出 txt
  push --book B --idx N --cbid ID [--publish]   递交作家助手（默认草稿）
  zuojia me|books|volumes       查作家助手登录态与远端作品
  deconstruct --file F [--name N] [--genre G]   拆书：把参考小说拆成写法模板
  templates                     列出模板
  template-use --book B --name N  把模板绑定到书（规划/写作会照它的节奏）
  recheck --book B --chapter N   只重算质检（不重写正文）
  fix --book B --chapter N --quote "原句" --instruction "怎么改"  只改这一段
  versions --book B --chapter N  看章节历史版本
  rollback --book B --chapter N --version ID  回滚到某个版本
  logs --book B                 运行日志与统计

环境变量：DRAFTVEIN_PROVIDER=mock 可离线跑通全链路；DRAFTVEIN_API_KEY/BASE_URL/MODEL 接任意 OpenAI 兼容端点。`);
}

main().catch((err) => {
  console.error('错误：' + (err as Error).message);
  process.exit(1);
});
