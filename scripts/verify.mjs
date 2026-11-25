#!/usr/bin/env node
/** 一键验收：单测 + 起服务走真实 HTTP 链路（mock provider，离线可跑） */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-verify-'));
const port = 4400 + Math.floor(Math.random() * 300);
const env = {
  ...process.env,
  DRAFTVEIN_PROVIDER: 'mock',
  DRAFTVEIN_HOME: tmpHome,
  DRAFTVEIN_PORT: String(port),
};

const results = [];
function ok(name, extra = '') {
  results.push({ name, pass: true, extra });
  console.log(`✔ ${name}${extra ? ' — ' + extra : ''}`);
}
function bad(name, err) {
  results.push({ name, pass: false, extra: String(err) });
  console.log(`✖ ${name} — ${err}`);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: root, env, ...opts });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

// 1. 单测
const testFiles = fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.ts')).map((f) => path.join('test', f));
const t = await run('node', ['--test', ...testFiles]);
if (t.code === 0) ok('单元测试', (t.out.match(/ℹ pass \d+/) || [''])[0]);
else {
  bad('单元测试', t.out.split('\n').slice(-20).join('\n'));
  process.exit(1);
}

// 2. 起服务
const server = spawn('node', ['src/cli.ts', 'serve'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const base = `http://127.0.0.1:${port}`;
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

try {
  if (!(await waitUp())) throw new Error(`服务没起来：${serverLog}`);
  ok('服务启动', base);

  const health = await (await fetch(`${base}/api/health`)).json();
  health.ok ? ok('health', `provider=${health.provider}`) : bad('health', JSON.stringify(health));

  const idx = await (await fetch(`${base}/`)).text();
  idx.includes('draftvein') ? ok('静态页可访问') : bad('静态页可访问', 'index.html 不含品牌');

  const css = await fetch(`${base}/style.css`);
  css.ok ? ok('样式表可访问') : bad('样式表', String(css.status));

  const created = await (
    await fetch(`${base}/api/books`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '验收样本', genre: '悬疑', premise: '不能拒绝的差事' }) })
  ).json();
  created.id ? ok('创建书籍', `id=${created.id}`) : bad('创建书籍', JSON.stringify(created));

  const bid = created.id;
  // 结构：大纲 / 分类 / 卷
  const docs0 = await (await fetch(`${base}/api/books/${bid}/outline-docs`)).json();
  docs0.length === 2 && docs0[0].name === '总纲' && docs0[1].name === '章纲' ? ok('默认总纲+章纲', docs0.map((d) => d.name).join('/')) : bad('默认纲目', JSON.stringify(docs0).slice(0, 200));
  const docNew = await (await fetch(`${base}/api/books/${bid}/outline-docs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '势力谱', content: '三股势力', kind: 'custom' }) })).json();
  (await (await fetch(`${base}/api/books/${bid}/outline-docs`)).json()).length === 3 ? ok('可加自定义纲', docNew.name) : bad('自定义纲', JSON.stringify(docNew).slice(0, 120));

  const catsC = await (await fetch(`${base}/api/books/${bid}/categories?scope=character`)).json();
  const catsB = await (await fetch(`${base}/api/books/${bid}/categories?scope=bible`)).json();
  catsC.length === 2 && catsB.length === 2 ? ok('默认分类', `角色 ${catsC.map((c) => c.name).join('/')}｜设定 ${catsB.map((c) => c.name).join('/')}`) : bad('默认分类', JSON.stringify({ catsC, catsB }).slice(0, 200));
  await fetch(`${base}/api/books/${bid}/categories`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'character', name: '反派' }) });
  await fetch(`${base}/api/books/${bid}/categories`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'bible', name: '金手指规则' }) });
  const catsC2 = await (await fetch(`${base}/api/books/${bid}/categories?scope=character`)).json();
  const catsB2 = await (await fetch(`${base}/api/books/${bid}/categories?scope=bible`)).json();
  catsC2.length === 3 && catsB2.length === 3 ? ok('可加分类', '反派 / 金手指规则') : bad('加分类', JSON.stringify({ catsC2, catsB2 }).slice(0, 200));

  const vols = await (await fetch(`${base}/api/books/${bid}/volumes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '第一卷 · 换命', start: 1, end: 10 }) })).json();
  vols.length === 1 ? ok('建卷', vols[0].title) : bad('建卷', JSON.stringify(vols).slice(0, 200));

  const plan = await (
    await fetch(`${base}/api/books/${bid}/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: 1, count: 1 }) })
  ).json();
  Array.isArray(plan) && plan[0]?.beats?.length >= 3 ? ok('单章规划', `${plan[0].beats.length} 个节拍`) : bad('单章规划', JSON.stringify(plan).slice(0, 200));

  const voice = await (await fetch(`${base}/api/books/${bid}/voice`)).json();
  voice.profile?.tone && voice.profile?.sample ? ok('本书专属声纹', voice.profile.tone) : bad('本书专属声纹', JSON.stringify(voice).slice(0, 200));

  const cast = await (await fetch(`${base}/api/books/${bid}/characters`)).json();
  cast.length >= 3 && cast.some((c) => c.role === 'protagonist')
    ? ok('人物卡自动建立', cast.map((c) => c.name).join('、'))
    : bad('人物卡自动建立', JSON.stringify(cast).slice(0, 200));

  const outline0 = await (await fetch(`${base}/api/books/${bid}/outline`)).json();
  const planCast = JSON.parse(outline0.plans?.[0]?.cast || '[]');
  planCast.length >= 1 ? ok('计划只收已登记人物', planCast.join('、')) : bad('计划人物', JSON.stringify(outline0.plans?.[0]?.cast));

  const runRes = await (
    await fetch(`${base}/api/books/${bid}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: 1, count: 2 }) })
  ).json();
  const chapterCount = runRes.chapters?.length || 0;
  chapterCount === 2 ? ok('逐章生成 2 章', runRes.chapters.map((c) => `${c.idx}:${c.words}字`).join(' ')) : bad('逐章生成', JSON.stringify(runRes).slice(0, 300));

  const pace = await (await fetch(`${base}/api/books/${bid}/pacing`)).json();
  const hookOk = pace.chapters?.length >= 2 && pace.chapters.every((c) => c.hook);
  const hlCount = (pace.highlights || []).length;
  hookOk && hlCount >= 2 ? ok('爆点与钩子记账', `钩子覆盖 ${Math.round(pace.hookCoverage * 100)}% · 爆点 ${hlCount} 条 · 平均强度 ${pace.avgIntensity}`) : bad('爆点记账', JSON.stringify(pace).slice(0, 300));
  pace.nextAdvice && typeof pace.nextAdvice.neededIntensity === 'number' ? ok('下一章节奏建议', `强度≥${pace.nextAdvice.neededIntensity} · ${(pace.nextAdvice.suggestTypes || []).join('/')}`) : bad('节奏建议', JSON.stringify(pace.nextAdvice));

  const st = await (await fetch(`${base}/api/books/${bid}/structure`)).json();
  st.template === 'three_act' && st.stages?.length === 3 ? ok('默认三幕结构', st.stages.map((x) => x.name).join(' / ')) : bad('结构', JSON.stringify(st).slice(0, 240));
  const stTpl = await (await fetch(`${base}/api/books/${bid}/structure/template`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'qidian' }) })).json();
  const st3 = await (await fetch(`${base}/api/books/${bid}/structure`)).json();
  stTpl.ok !== false && st3.template === 'qidian' && st3.stages.length === 5 ? ok('切换结构模板', `${st3.templateName} ${st3.stages.length} 阶段`) : bad('切模板', JSON.stringify(st3).slice(0, 200));
  const cur = await (await fetch(`${base}/api/books/${bid}/structure`)).json();
  cur.current?.stage?.name ? ok('当前结构位置', `${cur.current.stage.name} ${cur.current.pct}%`) : bad('结构位置', JSON.stringify(cur.current));

  const exps = await (await fetch(`${base}/api/books/${bid}/expectations`)).json();
  const fulfilled = (exps.list || []).filter((e) => e.status === 'fulfilled');
  fulfilled.length >= 1 ? ok('期待-兑现台账', `已兑现 ${fulfilled.length} 条 · 平均 ${exps.report.avgSpan} 章`) : bad('期待台账', JSON.stringify(exps).slice(0, 300));
  exps.report && typeof exps.report.overdue === 'number' ? ok('期待健康度', `未兑现 ${exps.report.open} · 逾期 ${exps.report.overdue} · 兑现率 ${Math.round(exps.report.fulfillRate * 100)}%`) : bad('期待健康度', JSON.stringify(exps.report));

  const tree = await (await fetch(`${base}/api/books/${bid}/tree`)).json();
  const grouped = tree.volumes?.[0]?.items?.length || 0;
  grouped >= 2 && tree.unassigned.length === 0 ? ok('分卷再分章', `${tree.volumes[0].volume.title} 含 ${grouped} 章`) : bad('分卷分组', JSON.stringify(tree).slice(0, 300));

  const outline = await (await fetch(`${base}/api/books/${bid}/outline`)).json();
  const maxPlan = Math.max(0, ...outline.plans.map((p) => p.idx));
  maxPlan <= 3 ? ok('滚动窗口不越界', `plans 最多到第 ${maxPlan} 章`) : bad('滚动窗口', `plans 到第 ${maxPlan} 章`);

  const threads = await (await fetch(`${base}/api/books/${bid}/threads`)).json();
  const planted = (threads.threads || []).filter((t) => t.planted_idx != null);
  planted.length >= 1 && planted[0].plant_quote ? ok('伏笔台账带证据', `${planted[0].code} @${planted[0].planted_idx}`) : bad('伏笔台账', JSON.stringify(threads).slice(0, 200));

  const castAfter = await (await fetch(`${base}/api/books/${bid}/characters`)).json();
  const touched = castAfter.filter((c) => c.mentions > 0 && c.first_idx != null);
  touched.length >= 1 ? ok('人物出场回写', `${touched[0].name}·首次第${touched[0].first_idx}章·提及${touched[0].mentions}`) : bad('人物出场回写', JSON.stringify(castAfter).slice(0, 200));

  const stats = await (await fetch(`${base}/api/books/${bid}/stats`)).json();
  Array.isArray(stats.daily) && stats.daily.length === 14 ? ok('码字统计', `今日 ${stats.daily.at(-1).words} 字`) : bad('码字统计', JSON.stringify(stats).slice(0, 200));

  // 关系
  const [a, b2] = [castAfter[0].name, castAfter[1].name];
  const rel = await (
    await fetch(`${base}/api/books/${bid}/relations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from_name: a, to_name: b2, relation: '互相提防', chapter_idx: 1 }) })
  ).json();
  const relList = await (await fetch(`${base}/api/books/${bid}/relations`)).json();
  rel.id && relList.current.length >= 1 ? ok('关系写入与当前值', `${rel.from_name}→${rel.to_name}：${rel.relation}`) : bad('关系', JSON.stringify(relList).slice(0, 200));

  // 体检
  const check = await (await fetch(`${base}/api/books/${bid}/check`)).json();
  check.summary && typeof check.summary.block === 'number' && Array.isArray(check.timeline) && Array.isArray(check.alias)
    ? ok('一致性体检', `阻断 ${check.summary.block} / 警告 ${check.summary.warn} / 提示 ${check.summary.info}`)
    : bad('一致性体检', JSON.stringify(check).slice(0, 200));

  const detail = await (await fetch(`${base}/api/books/${bid}/chapters/1`)).json();
  // 局部改写
  const para = String(detail.chapter.content || '').split(/\n+/).filter((x) => x.trim())[1];
  if (para) {
    const rw = await (
      await fetch(`${base}/api/books/${bid}/chapters/1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paragraph: para, instruction: '压短一半' }) })
    ).json();
    rw.next && rw.chapter?.content?.includes(rw.next) ? ok('选中段落局部改写', `原 ${para.length} 字 → 新 ${String(rw.next).length} 字`) : bad('局部改写', JSON.stringify(rw).slice(0, 200));
  } else bad('局部改写', '找不到可改写段落');

  // 导出 docx
  const exp2 = await (await fetch(`${base}/api/books/${bid}/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format: 'docx' }) })).json();
  const head = exp2.docx && fs.existsSync(exp2.docx) ? fs.readFileSync(exp2.docx).subarray(0, 2).toString('latin1') : '';
  head === 'PK' ? ok('导出 docx', exp2.docx) : bad('导出 docx', JSON.stringify(exp2));

  // 码字目标
  const st2 = await (await fetch(`${base}/api/books/${bid}/stats`)).json();
  'dailyGoal' in st2 && 'streak' in st2 ? ok('日更目标与连续天数', `目标 ${st2.dailyGoal} · 连续 ${st2.streak} 天`) : bad('日更目标', JSON.stringify(st2).slice(0, 200));
  detail.chapter?.word_count > 1500 ? ok('章节落库', `${detail.chapter.word_count} 字`) : bad('章节落库', JSON.stringify(detail).slice(0, 200));

  const exp = await (await fetch(`${base}/api/books/${bid}/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  fs.existsSync(path.join(exp.dir, 'merged.txt')) ? ok('导出 txt', exp.dir) : bad('导出 txt', JSON.stringify(exp));

  const push = await (
    await fetch(`${base}/api/books/${bid}/push`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idx: 1, dryRun: true, cbid: 'CB_TEST' }) })
  ).json();
  push.idx === 1 ? ok('递交接口（dry-run）', push.action) : bad('递交接口', JSON.stringify(push));

  // 静态资源之外，404 走 JSON 错误而不是崩溃
  const notFound = await fetch(`${base}/api/nope`);
  notFound.status === 404 ? ok('未知接口返回 404') : bad('未知接口', String(notFound.status));
} catch (err) {
  bad('链路验收', err.message);
} finally {
  server.kill('SIGTERM');
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${failed.length ? 'FAIL' : 'PASS'} — ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项：', failed.map((f) => `${f.name}: ${f.extra}`).join('\n'));
  process.exit(1);
}
fs.rmSync(tmpHome, { recursive: true, force: true });
