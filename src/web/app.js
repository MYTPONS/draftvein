// draftvein 控制台：原生 ESM，无构建
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  books: [],
  book: null,
  stats: null,
  health: null,
  chapters: [],
  plans: [],
  tree: { volumes: [], unassigned: [] },
  outlineDocs: [],
  outlineSel: null,
  charCats: [],
  bibleCats: [],
  characters: [],
  threads: [],
  route: { view: 'chapters', idx: null },
  running: false,
  logLines: 0,
  zuojia: null,
  zuojiaPoll: null,
  createOptions: null,
  createSite: 0,
  createCategory: '',
  createSubcategory: '',
  pendingPushIdx: null,
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 200) };
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, ms = 2600) {
  const box = $('#toast');
  const el = document.createElement('div');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}

// ── 启动 ──────────────────────────────────────────────
boot();
async function boot() {
  bindChrome();
  await loadBooks();
  await refreshAll();
  connectStream();
  setInterval(() => {
    if (!state.running) refreshQuiet();
  }, 15000);
}

function bindChrome() {
  $$('.tab').forEach((t) =>
    t.addEventListener('click', () => switchView(t.dataset.view)),
  );
  $$('#mobile-tabs button').forEach((t) =>
    t.addEventListener('click', () => switchView(t.dataset.view)),
  );
  $('#btn-new-book').addEventListener('click', newBookDialog);
  $('#rail-toggle').addEventListener('click', () => $('#rail').classList.toggle('open'));
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-backdrop').addEventListener('click', closeDrawer);
  $('#dialog-cancel').addEventListener('click', () => $('#dialog-backdrop').classList.remove('open'));
  $('#btn-clear-log').addEventListener('click', () => {
    $('#log').innerHTML = '';
    state.logLines = 0;
  });
  $('#btn-plan').addEventListener('click', () => planNext());
  $('#btn-export').addEventListener('click', exportBook);
  $('#btn-export-2').addEventListener('click', exportBook);
  $('#btn-export-docx').addEventListener('click', exportDocx);
  $('#btn-check-refresh').addEventListener('click', renderCheck);
  $('#btn-pacing-refresh').addEventListener('click', renderPacing);
  $('#btn-apply-template').addEventListener('click', applyStructureTemplate);
  $('#btn-add-expect').addEventListener('click', addExpectationDialog);
  $('#btn-add-rel').addEventListener('click', addRelationDialog);
  $('#btn-add-thread').addEventListener('click', addThreadDialog);
  $('#btn-add-bible').addEventListener('click', addBibleDialog);
  $('#btn-add-cast').addEventListener('click', () => castDialog(null));
  $('#btn-add-cat-char').addEventListener('click', () => categoryDialog('character'));
  $('#btn-add-cat-bible').addEventListener('click', () => categoryDialog('bible'));
  $('#btn-add-outline').addEventListener('click', addOutlineDialog);
  $('#btn-save-outline').addEventListener('click', saveOutlineDoc);
  $('#btn-add-volume').addEventListener('click', addVolumeDialog);
  $('#btn-edit-cast').addEventListener('click', () => castDialog(state.castSelected));
  $('#btn-book-settings').addEventListener('click', bookSettingsDialog);
  $('#btn-zuojia-refresh').addEventListener('click', refreshZuojia);
  $('#drawer-revise').addEventListener('click', () => reviseCurrent());
  $('#drawer-push').addEventListener('click', () => pushCurrent());
}

function switchView(view) {
  state.route.view = view;
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === view)));
  $$('#mobile-tabs button').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === view)));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'outline') renderOutline();
  if (view === 'cast') renderCast();
  if (view === 'structure') renderStructure();
  if (view === 'pacing') renderPacing();
  if (view === 'check') renderCheck();
  if (view === 'threads') renderThreads();
  if (view === 'bible') renderBible();
  if (view === 'push') renderPush();
}

// ── 数据 ──────────────────────────────────────────────
async function loadBooks() {
  state.books = await api('/books');
  renderBooks();
  if (!state.book && state.books.length) state.book = state.books[0];
  if (state.book) {
    const fresh = state.books.find((b) => b.id === state.book.id);
    if (fresh) state.book = fresh;
  }
}

function renderBooks() {
  const box = $('#book-list');
  if (!state.books.length) {
    box.innerHTML = `<div class="empty"><b>还没有书</b>先新建一本，再让它一章一章写下去</div>`;
    return;
  }
  box.innerHTML = state.books
    .map(
      (b) => `<button class="book-item" data-id="${b.id}" aria-current="${state.book?.id === b.id}">
        <span class="t">${esc(b.title)}</span>
        <span class="m">${b.chapters} 章 · ${fmtNum(b.words)} 字 · 未收 ${b.openThreads}</span>
      </button>`,
    )
    .join('');
  $$('.book-item', box).forEach((el) =>
    el.addEventListener('click', async () => {
      state.book = state.books.find((b) => b.id === Number(el.dataset.id));
      renderBooks();
      await refreshAll();
      if (window.innerWidth <= 760) $('#rail').classList.remove('open');
    }),
  );
}

async function refreshAll() {
  const health = await api('/health').catch(() => ({ provider: '?', model: '?' }));
  $('#pill-model').innerHTML = `<span class="dot ${health.provider === 'mock' ? 'warn' : 'ok'}"></span><span>${esc(health.provider)} · ${esc(
    String(health.model).split('/').pop(),
  )}</span>`;
  if (!state.book) {
    $('#chapters-body').innerHTML = `<div class="empty"><b>先建一本</b>左边「新建」起一本，然后点「写下一章」</div>`;
    return;
  }
  await refreshBook();
  await Promise.all([refreshZuojia(), loadPushes()]);
}

async function refreshQuiet() {
  if (!state.book) return;
  try {
    await refreshBook();
  } catch {
    /* 静默 */
  }
}

async function refreshBook() {
  const id = state.book.id;
  const [detail, chapters, tree, threads, characters, stats2, outlineDocs, charCats, bibleCats, structure, expect] = await Promise.all([
    api(`/books/${id}`),
    api(`/books/${id}/chapters`),
    api(`/books/${id}/tree`),
    api(`/books/${id}/threads`),
    api(`/books/${id}/characters`),
    api(`/books/${id}/stats`),
    api(`/books/${id}/outline-docs`),
    api(`/books/${id}/categories?scope=character`),
    api(`/books/${id}/categories?scope=bible`),
    api(`/books/${id}/structure`),
    api(`/books/${id}/expectations`),
  ]);
  state.structure = structure;
  state.expect = expect;
  state.tree = tree;
  state.outlineDocs = outlineDocs;
  state.charCats = charCats;
  state.bibleCats = bibleCats;
  state.characters = characters;
  state.daily = stats2.daily || [];
  state.relations = null;
  state.book = { ...detail.book, ...state.book };
  state.stats = { ...detail.stats, dailyGoal: stats2.dailyGoal || 0, streak: stats2.streak || 0, todayWords: stats2.todayWords || 0 };
  state.health = detail.health;
  state.chapters = chapters;
  state.plans = tree.unassigned.concat(...(tree.volumes || []).map((v) => v.items)).map((r) => r.plan).filter(Boolean);
  state.threads = threads.threads;
  state.health = threads.health;
  $('#brand-sub').textContent = state.book.slug;
  $('#tab-meta').textContent = `${state.stats.chapters} 章 · ${fmtNum(state.stats.words)} 字 · 未收线索 ${state.health.open}`;
  renderChapters();
  renderDaily();
  renderWriterPanel();
  if (state.route.view === 'cast') renderCast();
  if (state.route.view === 'threads') renderThreads();
  if (state.route.view === 'bible') renderBible();
}

// ── 目录 ──────────────────────────────────────────────
function chapterRow(r) {
  const ch = r.chapter;
  const plan = r.plan;
  const idx = r.idx;
  const beats = plan ? safeParse(plan.beats).length : 0;
  const score = ch ? Number(safeParse(ch.checks)?.report?.score ?? -1) : -1;
  const status = ch ? statusChip(ch.status) : '<span class="chip plain">仅计划</span>';
  return `<tr data-idx="${idx}" aria-selected="${state.route.idx === idx}">
    <td class="num">${idx}</td>
    <td class="title">${esc(ch?.title || plan?.title || '—')}</td>
    <td class="num">${ch ? fmtNum(ch.word_count) : '—'}</td>
    <td>${status}</td>
    <td class="num">${score >= 0 ? score : '—'}</td>
    <td class="num">${beats || '—'}</td>
    <td>
      <button class="btn ghost sm" data-act="open">查看</button>
      ${ch ? `<button class="btn ghost sm" data-act="revise">返工</button>` : ''}
      ${ch ? `<button class="btn ghost sm" data-act="push">递交</button>` : ''}
    </td>
  </tr>`;
}

function bindChapterRows() {
  $$('#chapters-body tbody tr[data-idx]').forEach((tr) => {
    const idx = Number(tr.dataset.idx);
    $$('button', tr).forEach((btn) =>
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        state.route.idx = idx;
        if (act === 'open') openChapter(idx);
        if (act === 'revise') stopAndRevise(idx);
        if (act === 'push') stopAndPush(idx);
      }),
    );
    tr.addEventListener('click', () => {
      state.route.idx = idx;
      renderChapters();
      renderWriterPanel();
    });
  });
}

function renderChapters() {
  const tree = state.tree || { volumes: [], unassigned: [] };
  const all = [...(tree.unassigned || []), ...(tree.volumes || []).flatMap((v) => v.items || [])];
  if (!all.length) {
    $('#chapters-body').innerHTML = `<div class="empty"><b>还没有章节</b>右侧「写下一章」会先规划这一章，再逐场景写正文</div>`;
    $('#chapters-meta').textContent = '—';
    return;
  }
  const volumeCount = (tree.volumes || []).length;
  $('#chapters-meta').textContent = `${state.chapters.length} 章已落库 · ${volumeCount} 卷`;

  const head = `<thead><tr>
      <th class="num" style="width:52px">章</th><th>标题</th><th class="num" style="width:64px">字数</th>
      <th style="width:88px">状态</th><th class="num" style="width:52px">质检</th><th class="num" style="width:52px">节拍</th><th style="width:120px"></th>
    </tr></thead>`;

  const blocks = (tree.volumes || []).map((v) => {
    const words = v.items.reduce((a, r) => a + (r.chapter?.word_count || 0), 0);
    return `<tbody>
      <tr class="vol-row"><td colspan="7">
        <span class="vol-name">${esc(v.volume.title)}</span>
        <span class="vol-meta">第 ${v.volume.start_chapter}-${v.volume.end_chapter} 章 · ${v.items.length} 章 · ${fmtNum(words)} 字</span>
        <button class="btn ghost sm" data-vol="${v.volume.id}">编辑卷</button>
      </td></tr>
      ${v.items.map(chapterRow).join('')}
    </tbody>`;
  });

  if ((tree.unassigned || []).length) {
    blocks.push(`<tbody>
      <tr class="vol-row"><td colspan="7"><span class="vol-name">未归卷</span><span class="vol-meta">${tree.unassigned.length} 章</span></td></tr>
      ${tree.unassigned.map(chapterRow).join('')}
    </tbody>`);
  }

  $('#chapters-body').innerHTML = `<table class="grid">${head}${blocks.join('')}</table>`;
  bindChapterRows();
  $$('#chapters-body button[data-vol]').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      editVolumeDialog(state.tree.volumes.find((v) => v.volume.id === Number(btn.dataset.vol)).volume);
    }),
  );
}

function statusChip(s) {
  const map = {
    reviewed: ['ok', '已过审'],
    draft: ['warn', '待返工'],
    pushed: ['ok', '已递交'],
  };
  const [cls, text] = map[s] || ['plain', s || '未知'];
  return `<span class="chip ${cls}">${text}</span>`;
}

function safeParse(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

// ── 生成台 ────────────────────────────────────────────
function renderWriterPanel() {
  const next = nextChapterIdx();
  const plan = state.plans.find((p) => p.idx === next);
  $('#next-idx').textContent = `下一章：第 ${next} 章`;
  const target = state.route.idx && state.chapters.find((c) => c.idx === state.route.idx);
  const shown = target && state.plans.find((p) => p.idx === target.idx);
  const activePlan = shown || plan;

  const beats = activePlan ? safeParse(activePlan.beats) : [];
  const overdue = state.health.overdueList || [];
  const dueSoon = state.health.dueSoonList || [];
  const bookData = safeParse(state.book.data) || {};
  const voice = bookData.voiceProfile;

  $('#writer-plan').innerHTML = `
    <div class="row wrap" style="margin-bottom:9px">
      <button class="btn primary" id="btn-write">写下一章</button>
      <button class="btn" id="btn-write-3">连写 3 章</button>
      <label class="row" style="gap:4px;font-size:12px;color:var(--ink-2)">
        从 <input type="number" id="from-idx" value="${next}" style="width:58px;height:24px"> 章起
      </label>
    </div>
    <div class="plan-box" style="margin-bottom:9px">
      <div class="row">
        <span class="meta">本书专属声纹</span><div class="spacer"></div>
        <button class="btn ghost sm" id="btn-voice-regen">${voice ? '重生成' : '生成声纹'}</button>
      </div>
      ${
        voice
          ? `<div style="margin-top:5px">${esc(voice.tone || '')}</div><div class="muted" style="font-size:11px;margin-top:3px">${esc(voice.narrator || '')}｜${esc(voice.signature || '')}</div>`
          : '<div class="muted" style="margin-top:5px">下一次规划/写作时自动建立，避免和其它书共用同一套腔调。</div>'
      }
    </div>
    ${
      overdue.length
        ? `<div class="error-box" style="margin:0 0 9px">${overdue.length} 条线索已逾期：${overdue
            .slice(0, 4)
            .map((t) => esc(t.code))
            .join('、')}<div class="fix">本章会被要求处理它们；不处理台账不会通过。</div></div>`
        : ''
    }
    ${
      activePlan
        ? `<div class="plan-box">
            <h3>第 ${activePlan.idx} 章 · ${esc(activePlan.title || '未命名')}</h3>
            <div class="goal">${esc(activePlan.goal || '（无目标）')}</div>
            <ul class="beats">${beats
              .map(
                (b, i) => `<li><span class="n">${String(i + 1).padStart(2, '0')}</span><span>${esc(b.action || '')}${
                  b.shift ? `<div class="shift">→ ${esc(b.shift)}</div>` : ''
                }</span></li>`,
              )
              .join('')}</ul>
            <div class="row wrap" style="margin-top:7px">
              <span class="chip plain">${beats.length} 节拍</span>
              <span class="chip plain">目标 ${fmtNum(activePlan.word_target || state.book.target_words)} 字</span>
              ${dueSoon.length ? `<span class="chip warn">${dueSoon.length} 条即将到期</span>` : ''}
            </div>
            ${
              safeParse(activePlan.highlights).length
                ? `<div class="row wrap" style="margin-top:6px">${safeParse(activePlan.highlights)
                    .map((h) => `<span class="chip ${h.kind === 'hook' ? 'warn' : 'ok'}">${esc(h.type)}·强度${h.intensity}${h.kind === 'hook' ? '·钩子' : ''}</span>`)
                    .join('')}</div>`
                : ''
            }
            ${
              safeParse(activePlan.cast).length
                ? `<div class="row wrap" style="margin-top:6px">${safeParse(activePlan.cast)
                    .map((n) => `<span class="chip ${state.characters.some((c) => c.name === n) ? 'ok' : 'bad'}">${esc(n)}</span>`)
                    .join('')}</div>`
                : ''
            }
          </div>`
        : `<div class="empty" style="padding:16px 0"><b>第 ${next} 章还没有计划</b>点「写下一章」会自动只规划这一章</div>`
    }`;

  $('#btn-write')?.addEventListener('click', () => runWrite(1));
  $('#btn-write-3')?.addEventListener('click', () => runWrite(3));
  $('#btn-voice-regen')?.addEventListener('click', regenerateVoice);
}

async function regenerateVoice() {
  try {
    const r = await api(`/books/${state.book.id}/voice`, { method: 'POST' });
    toast(`已生成本书声纹：${r.profile?.tone || ''}`);
    await refreshBook();
    renderWriterPanel();
  } catch (err) {
    toast(err.message, 5000);
  }
}

function nextChapterIdx() {
  return Math.max(0, ...state.chapters.map((c) => c.idx)) + 1;
}

async function planNext() {
  if (!state.book || state.running) return;
  state.running = true;
  log('plan', '规划下一章…');
  try {
    const from = Number($('#from-idx')?.value) || nextChapterIdx();
    await api(`/books/${state.book.id}/plan`, { method: 'POST', body: { from, count: 1 } });
    await refreshBook();
    log('plan', '计划已就绪', 'ok');
  } catch (err) {
    log('plan', err.message, 'err');
    toast(err.message);
  } finally {
    state.running = false;
  }
}

async function runWrite(count) {
  if (!state.book || state.running) return;
  const from = Number($('#from-idx')?.value) || nextChapterIdx();
  state.running = true;
  setWritingUi(true);
  log('run', `开始：第 ${from} 章起，${count} 章（逐章推进）`);
  try {
    const out = await api(`/books/${state.book.id}/run`, { method: 'POST', body: { from, count } });
    for (const c of out.chapters) log('commit', `第 ${c.idx} 章《${c.title}》 ${fmtNum(c.words)} 字 · 质检 ${c.score} · ${c.status}`, 'commit');
    for (const e of out.errors) log('run', `第 ${e.idx} 章失败：${e.error}`, 'err');
    await refreshBook();
  } catch (err) {
    log('run', err.message, 'err');
    toast(err.message);
  } finally {
    state.running = false;
    setWritingUi(false);
  }
}

function setWritingUi(running) {
  $$('#writer-plan button').forEach((b) => (b.disabled = running));
  if (running) $('#next-idx').textContent = '生成中…';
}

function log(stage, msg, cls = '') {
  const box = $('#log');
  const line = document.createElement('div');
  line.className = `line ${cls}`;
  line.innerHTML = `<span class="st">${esc(stage)}</span><span class="msg">${esc(msg)}</span>`;
  box.appendChild(line);
  state.logLines++;
  if (state.logLines > 400) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function connectStream() {
  const es = new EventSource('/api/events/stream');
  es.addEventListener('log', (e) => {
    const d = JSON.parse(e.data);
    const cls = d.stage === 'error' ? 'err' : d.stage === 'commit' ? 'commit' : d.stage === 'ledger' ? 'warn' : '';
    log(d.stage, d.message, cls);
  });
  es.onerror = () => {
    es.close();
    setTimeout(connectStream, 3000);
  };
}

// ── 大纲 ──────────────────────────────────────────────
function renderOutline() {
  if (!state.book) return;
  const docs = state.outlineDocs || [];
  if (!state.outlineSel) state.outlineSel = docs[0] || null;
  $('#outline-list').innerHTML = docs
    .map(
      (d) => `<button class="book-item" data-oid="${d.id}" aria-current="${state.outlineSel?.id === d.id}">
        <span class="t">${esc(d.name)}</span>
        <span class="m">${d.kind === 'master' ? '总纲' : d.kind === 'chapter' ? '章纲' : '自定义纲'}</span>
      </button>`,
    )
    .join('');
  $$('#outline-list [data-oid]').forEach((el) =>
    el.addEventListener('click', () => {
      state.outlineSel = docs.find((d) => d.id === Number(el.dataset.oid));
      renderOutline();
    }),
  );
  const cur = state.outlineSel;
  $('#outline-title').textContent = cur?.name || '总纲';
  $('#outline-meta').textContent = cur ? (cur.kind === 'custom' ? '自定义纲' : cur.kind === 'master' ? '全书主线' : '本卷章节推进') : '';
  $('#outline-editor').value = cur?.content || '';
  $('#outline-editor').disabled = cur?.kind === 'chapter';

  const plans = (state.plans || []).slice().sort((a, b) => a.idx - b.idx);
  $('#chapter-outline-meta').textContent = `${plans.length} 章计划`;
  $('#chapter-outline').innerHTML = plans.length
    ? `<table class="grid"><thead><tr><th class="num" style="width:48px">章</th><th style="width:150px">标题</th><th>本章目标</th></tr></thead><tbody>${plans
        .map(
          (p) =>
            `<tr><td class="num">${p.idx}</td><td class="title">${esc(p.title)}</td><td class="wrap">${esc(p.goal || '—')}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : `<div class="empty">还没有章节计划，写第一章时会生成</div>`;
}

async function saveOutlineDoc() {
  const cur = state.outlineSel;
  if (!cur || cur.kind === 'chapter') return toast('章纲来自章节计划，不能直接改');
  const content = $('#outline-editor').value;
  await api(`/books/${state.book.id}/outline-docs/${cur.id}`, { method: 'PATCH', body: { name: cur.name, content } });
  await refreshBook();
  toast('已保存');
}

function addOutlineDialog() {
  dialog(
    '新增纲',
    [
      { key: 'name', label: '纲名（如：势力谱 / 修炼体系 / 事件簿）' },
      { key: 'content', label: '内容', type: 'textarea' },
    ],
    async (d) => {
      if (!d.name) throw new Error('纲名不能为空');
      const doc = await api(`/books/${state.book.id}/outline-docs`, { method: 'POST', body: { name: d.name, content: d.content, kind: 'custom' } });
      await refreshBook();
      state.outlineSel = state.outlineDocs.find((x) => x.id === doc.id) || null;
      renderOutline();
      toast('已新增');
    },
  );
}

function addVolumeDialog() {
  dialog(
    '新建卷',
    [
      { key: 'title', label: '卷名' },
      { key: 'premise', label: '这一卷要发生什么', type: 'textarea' },
      { key: 'start', label: '起始章', type: 'number' },
      { key: 'end', label: '结束章', type: 'number' },
    ],
    async (d) => {
      if (!d.title) throw new Error('卷名不能为空');
      await api(`/books/${state.book.id}/volumes`, {
        method: 'POST',
        body: { title: d.title, premise: d.premise, start: d.start ? Number(d.start) : undefined, end: d.end ? Number(d.end) : undefined },
      });
      await refreshBook();
      toast('已建卷');
    },
  );
}

function editVolumeDialog(v) {
  dialog(
    '编辑卷',
    [
      { key: 'title', label: '卷名', value: v.title },
      { key: 'premise', label: '这一卷要发生什么', type: 'textarea', value: v.premise },
      { key: 'start_chapter', label: '起始章', type: 'number', value: v.start_chapter },
      { key: 'end_chapter', label: '结束章', type: 'number', value: v.end_chapter },
    ],
    async (d) => {
      await api(`/books/${state.book.id}/volumes/${v.id}`, {
        method: 'PATCH',
        body: { title: d.title, premise: d.premise, start_chapter: Number(d.start_chapter), end_chapter: Number(d.end_chapter), realign: true },
      });
      await refreshBook();
      toast('已保存');
    },
  );
}

// ── 码字条 ────────────────────────────────────────────
function renderDaily() {
  const daily = state.daily || [];
  if (!daily.length) return;
  const today = daily[daily.length - 1]?.words || 0;
  const week = daily.slice(-7).reduce((a, d) => a + d.words, 0);
  const total = state.stats?.words || 0;
  const max = Math.max(1, ...daily.map((d) => d.words));
  const goal = state.stats?.dailyGoal || 0;
  const streak = state.stats?.streak || 0;
  $('#daily-strip').innerHTML = `
    <div class="stat">今日<b>${fmtNum(today)}</b></div>
    ${goal ? `<div class="stat goal">目标 ${fmtNum(goal)}<b class="${today >= goal ? 'over' : ''}">${Math.round((today / goal) * 100)}%</b><div class="goalbar"><i style="width:${Math.min(100, Math.round((today / goal) * 100))}%"></i></div></div>` : ''}
    <div class="stat">连续<b>${streak} 天</b></div>
    <div class="stat">近 7 天<b>${fmtNum(week)}</b></div>
    <div class="stat">全书<b>${fmtNum(total)}</b></div>
    <div class="stat">日均 / 章<b>${fmtNum(state.stats?.avg || 0)}</b></div>
    <div class="bars">${daily.map((d) => `<i class="${d.words ? 'has' : ''}" style="height:${Math.max(3, Math.round((d.words / max) * 26))}px" title="${d.date} ${d.words} 字"></i>`).join('')}</div>`;
}

// ── 人物 ──────────────────────────────────────────────
function renderCast() {
  renderCastTimeline();
  if (!state.book) return;
  const list = state.characters || [];
  $('#cast-meta').textContent = `${list.length} 人`;
  if (!list.length) {
    $('#cast-body').innerHTML = `<div class="empty"><b>还没有人物卡</b>第一次规划时会自动建 3 个人；也可以点「新增人物」自己立</div>`;
    return;
  }
  const cats = (state.charCats || []).map((c) => c.name);
  const groups = new Map();
  for (const c of list) {
    const k = c.category || '主要角色';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  for (const k of groups.keys()) if (!cats.includes(k)) cats.push(k);
  const row = (c) => `<tr data-id="${c.id}" aria-selected="${state.castSelected?.id === c.id}">
      <td class="mono">${esc(c.name)}</td>
      <td><span class="chip ${c.role === 'protagonist' ? 'ok' : c.role === 'antagonist' ? 'bad' : 'plain'}">${roleName(c.role)}</span></td>
      <td class="title">${esc(c.identity || '—')}</td>
      <td class="title muted">${esc(c.speech || '—')}</td>
      <td class="num">${c.first_idx ?? '—'}</td>
      <td class="num">${c.mentions || 0}</td>
      <td>${c.status === 'alive' ? '在场' : esc(c.status)}</td>
    </tr>`;
  const bodies = cats
    .filter((k) => groups.has(k))
    .map(
      (k) => `<tbody>
        <tr class="vol-row"><td colspan="7"><span class="vol-name">${esc(k)}</span><span class="vol-meta">${groups.get(k).length} 人</span></td></tr>
        ${groups.get(k).map(row).join('')}
      </tbody>`,
    )
    .join('');
  $('#cast-body').innerHTML = `<table class="grid"><thead><tr>
      <th style="width:96px">姓名</th><th style="width:72px">定位</th><th>身份</th>
      <th style="width:120px">说话方式</th><th class="num" style="width:52px">登场</th><th class="num" style="width:52px">提及</th><th style="width:64px">状态</th>
    </tr></thead>${bodies}</table>`;
  $$('#cast-body tbody tr[data-id]').forEach((tr) =>
    tr.addEventListener('click', () => {
      state.castSelected = state.characters.find((c) => c.id === Number(tr.dataset.id));
      renderCast();
      renderCastDetail();
    }),
  );
  if (!state.relations) loadRelations().then(renderRelGraph);
  else renderRelGraph();
  if (state.castSelected) renderCastDetail();
}

async function loadRelations() {
  if (!state.book) return { current: [], history: [] };
  try {
    state.relations = await api(`/books/${state.book.id}/relations`);
  } catch {
    state.relations = { current: [], history: [] };
  }
  return state.relations;
}

function renderRelGraph() {
  const rel = state.relations || { current: [] };
  const chars = (state.characters || []).slice(0, 12);
  const box = $('#rel-graph');
  if (!chars.length) {
    box.innerHTML = '<div class="empty" style="padding:16px">还没有人物，无法画关系</div>';
    return;
  }
  const W = 372;
  const H = Math.max(180, 60 + chars.length * 12);
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(W, H) / 2 - 34;
  const pos = new Map(chars.map((c, i) => [c.name, {
    x: cx + R * Math.cos((i / chars.length) * Math.PI * 2 - Math.PI / 2),
    y: cy + R * Math.sin((i / chars.length) * Math.PI * 2 - Math.PI / 2),
  }]));
  const edges = (rel.current || []).filter((e) => pos.has(e.from_name) && pos.has(e.to_name));
  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="人物关系图">
    ${edges
      .map((e, i) => {
        const a = pos.get(e.from_name);
        const b = pos.get(e.to_name);
        const t = 0.3 + 0.16 * (i % 3);
        const mx = a.x + (b.x - a.x) * t;
        const my = a.y + (b.y - a.y) * t;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = (-dy / len) * 7;
        const ny = (dx / len) * 7;
        const label = e.relation.length > 8 ? e.relation.slice(0, 8) + '…' : e.relation;
        return `<line class="edge" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"/>
          <text class="edge-label" x="${(mx + nx).toFixed(1)}" y="${(my + ny).toFixed(1)}" text-anchor="middle">${esc(label)}</text>`;
      })
      .join('')}
    ${chars
      .map((c) => {
        const p = pos.get(c.name);
        const fill = c.role === 'protagonist' ? '#2b6b52' : c.role === 'antagonist' ? '#a3312a' : '#7c827c';
        return `<g class="node" data-name="${esc(c.name)}" style="cursor:pointer">
          <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" fill="${fill}"/>
          <text x="${(p.x + 7).toFixed(1)}" y="${(p.y + 3).toFixed(1)}">${esc(c.name)}</text>
        </g>`;
      })
      .join('')}
  </svg>`;
  box.innerHTML = svg;
  $$('#rel-graph .node').forEach((g) =>
    g.addEventListener('click', () => {
      state.castSelected = state.characters.find((c) => c.name === g.dataset.name);
      renderCast();
      renderCastDetail();
    }),
  );
  $('#rel-meta').textContent = `${edges.length} 条关系`;
}

function addRelationDialog() {
  const names = (state.characters || []).map((c) => c.name);
  if (names.length < 2) return toast('至少要有两个人物');
  dialog(
    '加一条关系',
    [
      { key: 'from_name', label: '从谁', type: 'select', options: names.map((n) => [n, n]) },
      { key: 'to_name', label: '到谁', type: 'select', options: names.map((n) => [n, n]), value: names[1] },
      { key: 'relation', label: '关系（一句话）' },
      { key: 'chapter_idx', label: '发生在第几章', type: 'number' },
    ],
    async (d) => {
      if (d.from_name === d.to_name) throw new Error('不能指向自己');
      await api(`/books/${state.book.id}/relations`, { method: 'POST', body: { ...d, chapter_idx: Number(d.chapter_idx) || null } });
      await loadRelations();
      renderRelGraph();
      toast('已记录');
    },
  );
}

function categoryDialog(scope) {
  const list = scope === 'character' ? state.charCats : state.bibleCats;
  dialog(
    scope === 'character' ? '新增角色分类' : '新增设定分类',
    [{ key: 'name', label: '分类名（如：反派 / 势力 / 金手指）' }],
    async (d) => {
      if (!d.name) throw new Error('分类名不能为空');
      await api(`/books/${state.book.id}/categories`, { method: 'POST', body: { scope, name: d.name } });
      await refreshBook();
      toast('已新增分类');
    },
  );
}

function roleName(r) {
  return { protagonist: '主角', support: '配角', antagonist: '反派', extra: '龙套' }[r] || r;
}

function renderCastDetail() {
  const c = state.castSelected;
  if (!c) return;
  const rels = safeParse(c.relations);
  const rows = [
    ['姓名', c.name],
    ['别名', c.aliases],
    ['定位', roleName(c.role)],
    ['身份', c.identity],
    ['外貌', c.appearance],
    ['性格', c.personality],
    ['想要', c.goal],
    ['怕', c.fear],
    ['说话方式', c.speech],
    ['口头禅', c.catchphrase],
    ['禁忌', c.taboo],
    ['状态', c.status],
    ['首次登场', c.first_idx ?? '—'],
    ['提及章数', c.mentions],
    ['备注', c.notes],
  ];
  $('#cast-detail').innerHTML = `<table class="grid"><tbody>${rows
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `<tr><th style="width:88px">${k}</th><td class="wrap">${esc(v)}</td></tr>`)
    .join('')}
    ${rels.length ? `<tr><th>关系</th><td class="wrap">${rels.map((r) => `${esc(r.name)}（${esc(r.relation)}）`).join('、')}</td></tr>` : ''}
    </tbody></table>`;
}

function castDialog(c) {
  dialog(
    c ? '编辑人物' : '新增人物',
    [
      { key: 'name', label: '姓名', value: c?.name || '' },
      { key: 'role', label: '定位', type: 'select', options: [['protagonist', '主角'], ['support', '配角'], ['antagonist', '反派'], ['extra', '龙套']], value: c?.role || 'support' },
      { key: 'category', label: '分类', type: 'select', options: (state.charCats.length ? state.charCats : [{ name: '主要角色' }, { name: '次要角色' }]).map((x) => [x.name, x.name]), value: c?.category || '主要角色' },
      { key: 'identity', label: '身份', value: c?.identity || '' },
      { key: 'personality', label: '性格（写异于常人的点）', type: 'textarea', value: c?.personality || '' },
      { key: 'goal', label: '想要什么', value: c?.goal || '' },
      { key: 'fear', label: '怕什么', value: c?.fear || '' },
      { key: 'speech', label: '说话方式', value: c?.speech || '' },
      { key: 'catchphrase', label: '口头禅', value: c?.catchphrase || '' },
      { key: 'taboo', label: '禁忌/雷点', value: c?.taboo || '' },
      { key: 'importance', label: '重要度 1-5', type: 'number', value: c?.importance ?? 3 },
    ],
    async (d) => {
      if (!d.name) throw new Error('姓名不能为空');
      const body = { ...d, importance: Number(d.importance) || 3 };
      if (c) await api(`/books/${state.book.id}/characters/${c.id}`, { method: 'PATCH', body });
      else await api(`/books/${state.book.id}/characters`, { method: 'POST', body });
      state.castSelected = null;
      await refreshBook();
      toast(c ? '已保存' : '已新增人物');
    },
  );
}

function bookSettingsDialog() {
  const b = state.book;
  let data = {};
  try {
    data = JSON.parse(b.data || '{}');
  } catch {}
  dialog(
    '书信息',
    [
      { key: 'title', label: '书名', value: b.title },
      { key: 'genre', label: '题材', value: b.genre },
      { key: 'premise', label: '核心设定', type: 'textarea', value: b.premise },
      { key: 'audience', label: '目标读者', value: b.audience },
      { key: 'target_words', label: '每章目标字数', type: 'number', value: b.target_words },
      { key: 'dailyGoal', label: '日更目标字数（0 为不设）', type: 'number', value: data.dailyGoal || 0 },
      { key: 'tags', label: '标签（逗号分隔）', value: data.tags || '' },
      { key: 'styleSample', label: '文风样本（贴一段你自己的文字）', type: 'textarea', value: data.styleSample || '' },
    ],
    async (d) => {
      await api(`/books/${b.id}`, {
        method: 'PATCH',
        body: {
          title: d.title,
          genre: d.genre,
          premise: d.premise,
          audience: d.audience,
          target_words: Number(d.target_words) || b.target_words,
          data: JSON.stringify({ ...data, styleSample: d.styleSample, dailyGoal: Number(d.dailyGoal) || 0, tags: d.tags || '' }),
        },
      });
      await loadBooks();
      await refreshBook();
      toast('已保存');
    },
  );
}

// ── 台账 ──────────────────────────────────────────────
function renderThreads() {
  if (!state.book) return;
  const h = state.health || {};
  $('#thread-metrics').innerHTML = [
    ['未回收', h.open ?? 0, `共 ${h.total ?? 0} 条`],
    ['已逾期', h.overdue ?? 0, `即将到期 ${h.dueSoon ?? 0}`],
    ['回收率', `${Math.round((h.resolveRate ?? 0) * 100)}%`, `已收 ${h.resolved ?? 0}`],
    ['平均跨度', (h.avgSpan ?? 0).toFixed(1), '章'],
  ]
    .map(
      ([k, v, s]) => `<div class="metric"><div class="k">${k}</div><div class="v">${v}<small>${s}</small></div></div>`,
    )
    .join('');

  $('#threads-meta').textContent = `第 ${nextChapterIdx()} 章视角`;
  if (!state.threads.length) {
    $('#threads-body').innerHTML = `<div class="empty"><b>台账是空的</b>写第一章时出现的伏笔会自动登记；也可以手动「登记线索」</div>`;
    return;
  }
  const rows = state.threads
    .slice()
    .sort((a, b) => rank(a) - rank(b))
    .map((t) => {
      const overdue = t.status === 'open' && t.due_to != null && t.due_to < nextChapterIdx();
      return `<tr>
        <td class="mono">${esc(t.code)}</td>
        <td class="title">${esc(t.title)}</td>
        <td><span class="chip ${t.status === 'resolved' ? 'ok' : t.status === 'abandoned' ? 'plain' : overdue ? 'bad' : 'warn'}">${
          t.status === 'resolved' ? '已回收' : t.status === 'abandoned' ? '放弃' : overdue ? '逾期' : '未回收'
        }</span></td>
        <td class="num">${t.planted_idx ?? '—'}</td>
        <td class="num">${t.resolved_idx ?? '—'}</td>
        <td class="num">${t.due_from ?? '—'}-${t.due_to ?? '—'}</td>
        <td class="wrap muted" style="max-width:280px;font-size:12px">${esc(t.plant_quote || t.detail || '')}</td>
      </tr>`;
    })
    .join('');
  $('#threads-body').innerHTML = `<table class="grid"><thead><tr>
      <th style="width:130px">code</th><th>标题</th><th style="width:84px">状态</th>
      <th class="num" style="width:44px">埋</th><th class="num" style="width:44px">收</th>
      <th class="num" style="width:88px">窗口</th><th>证据</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function rank(t) {
  if (t.status === 'resolved') return 2;
  if (t.status === 'abandoned') return 3;
  return t.due_to != null && t.due_to < nextChapterIdx() ? -1 : 0;
}

// ── 设定 ──────────────────────────────────────────────
async function renderBible() {
  if (!state.book) return;
  const id = state.book.id;
  const [bible, facts, timeline] = await Promise.all([api(`/books/${id}/bible`), api(`/books/${id}/facts`), api(`/books/${id}/timeline`)]);
  $('#bible-meta').textContent = `${bible.length} 条`;
  if (!bible.length) {
    $('#bible-body').innerHTML = `<div class="empty"><b>设定集为空</b>背景设定、势力、规则越具体，写出来的东西越不容易自相矛盾</div>`;
  } else {
    const cats = (state.bibleCats || []).map((c) => c.name);
    const groups = new Map();
    for (const b of bible) {
      const k = b.category || '其他设定';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(b);
    }
    for (const k of groups.keys()) if (!cats.includes(k)) cats.push(k);
    const bodies = cats
      .filter((k) => groups.has(k))
      .map(
        (k) => `<tbody><tr class="vol-row"><td colspan="3"><span class="vol-name">${esc(k)}</span><span class="vol-meta">${groups.get(k).length} 条</span></td></tr>
        ${groups
          .get(k)
          .map(
            (b) => `<tr><td><span class="chip plain">${esc(kindName(b.kind))}</span></td><td>${esc(b.name)}</td><td class="wrap">${esc(b.content)}</td></tr>`,
          )
          .join('')}</tbody>`,
      )
      .join('');
    $('#bible-body').innerHTML = `<table class="grid"><thead><tr><th style="width:64px">类型</th><th style="width:120px">名称</th><th>内容</th></tr></thead>${bodies}</table>`;
  }
  $('#facts-body').innerHTML = facts.length
    ? `<table class="grid"><thead><tr><th class="num" style="width:44px">章</th><th style="width:96px">主体</th><th>事实</th></tr></thead><tbody>${facts
        .map((f) => `<tr><td class="num">${f.idx}</td><td>${esc(f.subject || '—')}</td><td class="wrap">${esc(f.fact)}</td></tr>`)
        .join('')}</tbody></table>`
    : `<div class="empty">还没有抽取到硬事实</div>`;
  $('#timeline-body').innerHTML = timeline.length
    ? `<table class="grid"><thead><tr><th class="num" style="width:44px">章</th><th style="width:110px">时间</th><th>事件</th></tr></thead><tbody>${timeline
        .map(
          (t) =>
            `<tr><td class="num">${t.idx}</td><td>${esc(t.story_time || '—')}</td><td class="wrap">${esc(t.event)}${
              t.location ? `<span class="muted"> · ${esc(t.location)}</span>` : ''
            }</td></tr>`,
        )
        .join('')}</tbody></table>`
    : `<div class="empty">还没有时间线事件</div>`;
}

function kindName(k) {
  return { world: '世界', character: '人物', faction: '势力', location: '地点', item: '物品', rule: '规则' }[k] || k;
}

// ── 结构 ──────────────────────────────────────────────
async function renderStructure() {
  if (!state.book) return;
  let s1, e1;
  try {
    [s1, e1] = await Promise.all([api(`/books/${state.book.id}/structure`), api(`/books/${state.book.id}/expectations`)]);
  } catch (err) {
    $('#structure-current').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    return;
  }
  state.structure = s1;
  state.expect = e1;
  $('#structure-meta').textContent = `${s1.templateName} · 规划 ${s1.current?.total ?? '?'} 章`;
  const sel = $('#structure-template');
  sel.innerHTML = (s1.templates || []).map((t) => `<option value="${t.key}" ${t.key === s1.template ? 'selected' : ''}>${esc(t.name)}（${t.stages} 阶段）</option>`).join('');

  const cur = s1.current;
  $('#structure-current').innerHTML = cur
    ? `<div class="plan-box"><h3>当前位置：${esc(cur.stage.name)}（全书 ${cur.pct}%）</h3>
        <div class="goal">${esc(cur.stage.goal)}</div>
        <div class="row wrap"><span class="chip plain">本阶段第 ${cur.chapterRange.start}-${cur.chapterRange.end} 章</span>
        <span class="chip plain">下一章：第 ${nextChapterIdx()} 章</span></div></div>`
    : `<div class="empty">还没有卷/章节，先建卷再写</div>`;

  const stages = s1.stages || [];
  const span = Math.max(1, stages.reduce((a, x) => a + (x.end_pct - x.start_pct), 0));
  $('#structure-bar').innerHTML = stages.length
    ? `<div class="sbar">${stages
        .map(
          (st) => `<div class="seg ${cur && cur.stage.id === st.id ? 'cur' : ''}" style="width:${((st.end_pct - st.start_pct) / span) * 100}%" title="${esc(st.name)} ${st.start_pct}-${st.end_pct}%">${esc(st.name)}</div>`,
        )
        .join('')}</div>
      <div class="sbar-legend">${stages.map((st) => `<span>${esc(st.name)}：第 ${st.from}-${st.to} 章</span>`).join('')}</div>`
    : '';

  $('#structure-stages').innerHTML = stages.length
    ? `<table class="grid"><thead><tr><th style="width:150px">阶段</th><th class="num" style="width:96px">章范围</th><th>职能</th></tr></thead><tbody>${stages
        .map(
          (st) => `<tr><td>${esc(st.name)}</td><td class="num">${st.from}-${st.to}</td><td class="wrap">${esc(st.goal)}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '';

  const rep = e1.report || {};
  const list = e1.list || [];
  $('#expect-meta').textContent = `未兑现 ${rep.open ?? 0} · 逾期 ${rep.overdue ?? 0} · 已兑现 ${rep.fulfilled ?? 0}（平均 ${rep.avgSpan ?? 0} 章）`;
  $('#expect-body').innerHTML = list.length
    ? `<table class="grid"><thead><tr><th style="width:120px">code</th><th style="width:120px">期待</th><th style="width:64px">类型</th>
        <th class="num" style="width:48px">强度</th><th style="width:84px">状态</th><th class="num" style="width:48px">立</th><th class="num" style="width:48px">兑</th><th class="num" style="width:88px">窗口</th><th>证据</th></tr></thead><tbody>${list
        .map((e) => {
          const overdue = e.status === 'open' && e.due_to != null && e.due_to < nextChapterIdx();
          return `<tr><td class="mono">${esc(e.code)}</td><td>${esc(e.title)}</td><td>${esc(e.type)}</td>
            <td class="num">${e.strength}</td>
            <td><span class="chip ${e.status === 'fulfilled' ? 'ok' : overdue ? 'bad' : 'warn'}">${e.status === 'fulfilled' ? '已兑现' : overdue ? '逾期' : '未兑现'}</span></td>
            <td class="num">${e.planted_idx ?? '—'}</td><td class="num">${e.fulfilled_idx ?? '—'}</td>
            <td class="num">${e.due_from ?? '—'}-${e.due_to ?? '—'}</td>
            <td class="muted" style="max-width:300px;font-size:12px">${esc(e.fulfill_quote || e.plant_quote || '')}</td></tr>`;
        })
        .join('')}</tbody></table>`
    : `<div class="empty"><b>还没有期待记录</b>写章节时会自动立与兑现；强度≥4 的爆点必须挂在期待上</div>`;
}

async function applyStructureTemplate() {
  const key = $('#structure-template').value;
  try {
    await api(`/books/${state.book.id}/structure/template`, { method: 'POST', body: { key } });
    await renderStructure();
    toast('已切换结构');
  } catch (err) {
    toast(err.message);
  }
}

function addExpectationDialog() {
  dialog(
    '登记期待',
    [
      { key: 'code', label: 'code（英文短 id）', placeholder: 'flag_name' },
      { key: 'title', label: '读者在等什么' },
      { key: 'type', label: '类型', type: 'select', options: [['羞辱', '羞辱'], ['立旗', '立旗'], ['约定', '约定'], ['威胁', '威胁'], ['悬念', '悬念'], ['许诺', '许诺']] },
      { key: 'detail', label: '细节', type: 'textarea' },
      { key: 'strength', label: '强度 1-5', type: 'number', value: 3 },
      { key: 'due_from', label: '起章', type: 'number' },
      { key: 'due_to', label: '最晚兑现章', type: 'number' },
    ],
    async (d) => {
      await api(`/books/${state.book.id}/expectations`, {
        method: 'POST',
        body: { ...d, strength: Number(d.strength) || 3, due_from: Number(d.due_from) || null, due_to: Number(d.due_to) || null },
      });
      await renderStructure();
      toast('已登记');
    },
  );
}

// ── 爆点节奏 ──────────────────────────────────────────
async function renderPacing() {
  if (!state.book) return;
  let r;
  try {
    r = await api(`/books/${state.book.id}/pacing`);
  } catch (err) {
    $('#pacing-issues').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    return;
  }
  state.pacing = r;
  const adv = r.nextAdvice || {};
  $('#pacing-metrics').innerHTML = [
    ['钩子覆盖率', `${Math.round((r.hookCoverage || 0) * 100)}%`, '章末有钩子的比例'],
    ['平均强度', (r.avgIntensity || 0).toFixed(1), '1-5'],
    ['连续无爆点', r.dryStreak || 0, '章'],
    ['爆点数', (r.highlights || []).length, '条'],
  ]
    .map(([k, v, sub]) => `<div class="metric"><div class="k">${k}</div><div class="v">${v}<small>${sub}</small></div></div>`)
    .join('');

  $('#pacing-meta').textContent = adv.note ? `下一章：强度≥${adv.neededIntensity} · ${(adv.suggestTypes || []).join('/')} · ${adv.mustHook ? '必须钩子' : ''}` : '';
  const max = Math.max(5, ...(r.chapters || []).map((c) => c.maxIntensity));
  $('#pacing-curve').innerHTML = (r.chapters || []).length
    ? `<div class="curve-wrap"><div class="curve">${r.chapters
        .map(
          (c) => `<div class="col" title="第${c.idx}章 强度${c.maxIntensity} ${c.types.join('/')}">
            <i class="bar ${c.maxIntensity >= 5 ? 'lv5' : c.maxIntensity >= 4 ? 'lv4' : c.maxIntensity >= 3 ? 'lv3' : ''}" style="height:${Math.max(3, Math.round((c.maxIntensity / max) * 84))}px"></i>
            <span class="hook ${c.hook ? 'on' : ''}"></span>
            <span class="n">${c.idx}</span>
          </div>`,
        )
        .join('')}</div></div>`
    : `<div class="empty" style="padding:12px">还没有章节，写第一章时就会记账</div>`;

  const issues = r.issues || [];
  $('#pacing-issue-count').textContent = issues.length ? `${issues.length} 条` : '无';
  $('#pacing-issues').innerHTML = issues.length
    ? `<table class="grid"><thead><tr><th style="width:78px">等级</th><th class="num" style="width:48px">章</th><th>说明</th></tr></thead><tbody>${issues
        .map(
          (i) => `<tr><td><span class="chip ${i.severity === 'block' ? 'bad' : 'warn'}">${i.severity === 'block' ? '阻断' : '警告'}</span></td>
          <td class="num">${i.chapter}</td><td class="wrap">${esc(i.message)}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : `<div class="empty" style="padding:14px">节奏没硬伤：每章有钩子，强度也够</div>`;

  const hs = r.highlights || [];
  $('#pacing-list-meta').textContent = `${hs.length} 条`;
  $('#pacing-list').innerHTML = hs.length
    ? `<table class="grid"><thead><tr><th class="num" style="width:48px">章</th><th style="width:64px">类型</th><th style="width:76px">种类</th><th class="num" style="width:52px">强度</th><th>爆点</th><th>证据</th></tr></thead><tbody>${hs
        .map(
          (h) => `<tr><td class="num">${h.chapter_idx}</td><td>${esc(h.type)}</td>
          <td><span class="chip ${h.kind === 'hook' ? 'plain' : 'ok'}">${h.kind === 'hook' ? '章末钩子' : h.kind === 'climax' ? '高潮' : '爽点'}</span></td>
          <td class="num">${h.intensity}</td><td class="wrap">${esc(h.title || '—')}</td>
          <td class="muted" style="max-width:320px;font-size:12px">${esc(h.quote || '')}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : `<div class="empty" style="padding:14px">还没有爆点记录</div>`;
}

// ── 体检 ──────────────────────────────────────────────
async function renderCheck() {
  if (!state.book) return;
  $('#check-body').innerHTML = `<div class="skeleton"><i style="width:60%"></i><i style="width:40%"></i></div>`;
  let r;
  try {
    r = await api(`/books/${state.book.id}/check`);
  } catch (err) {
    $('#check-body').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    return;
  }
  const s = r.summary || { block: 0, warn: 0, info: 0 };
  $('#check-metrics').innerHTML = [
    ['阻断', s.block, '必须改，否则会崩'],
    ['警告', s.warn, '建议改'],
    ['提示', s.info, '可忽略'],
    ['未登记人名', (r.suspects || []).reduce((a, x) => a + (x.names || []).length, 0), '需要补卡'],
  ]
    .map(([k, v, sub]) => `<div class="metric"><div class="k">${k}</div><div class="v">${v}<small>${sub}</small></div></div>`)
    .join('');

  const sections = [
    ['人物与死而复生', r.timeline?.filter((i) => /已标记死亡/.test(i.message)) || []],
    ['时间线', r.timeline?.filter((i) => !/已标记死亡/.test(i.message)) || []],
    ['别名', r.alias || []],
    ['毒点 / 人物问题', r.poison || []],
    ['爆点与钩子', r.pacing || []],
    ['期待兑现', r.expectations || []],
    ['未登记人名', (r.suspects || []).map((x) => ({ severity: 'warn', type: 'cast', chapter: x.chapter, message: `第 ${x.chapter} 章出现：${(x.names || []).join('、')}` }))],
  ];
  const total = sections.reduce((a, [, list]) => a + list.length, 0);
  $('#check-meta').textContent = total ? `${total} 条` : '干净';
  if (!total) {
    $('#check-body').innerHTML = `<div class="empty"><b>没有发现问题</b>时间线、别名、人名、毒点都过了</div>`;
    return;
  }
  $('#check-body').innerHTML = sections
    .filter(([, list]) => list.length)
    .map(
      ([title, list]) => `<div class="pane-head" style="background:var(--panel-2)"><h2>${title}</h2><span class="meta">${list.length}</span></div>
      <table class="grid"><thead><tr><th style="width:120px">等级</th><th class="num" style="width:52px">章</th><th>说明</th></tr></thead><tbody>${list
        .map(
          (i) => `<tr><td><span class="chip ${i.severity === 'block' ? 'bad' : i.severity === 'warn' ? 'warn' : 'plain'}">${
            i.severity === 'block' ? '阻断' : i.severity === 'warn' ? '警告' : '提示'
          }</span></td><td class="num">${i.chapter || '—'}</td><td class="wrap">${esc(i.message)}${
            i.quote ? `<div class="muted" style="font-size:11px">「${esc(i.quote)}」</div>` : ''
          }</td></tr>`,
        )
        .join('')}</tbody></table>`,
    )
    .join('');
}

// ── 递交 ──────────────────────────────────────────────
async function refreshZuojia() {
  const pill = $('#pill-zuojia');
  try {
    const r = await api(`/books/${state.book.id}/zuojia`);
    if (r.connected) {
      pill.className = 'pill ok';
      pill.innerHTML = `<span class="dot"></span><span>作家助手已连接</span>`;
    } else if (r.login?.status === 'waiting_scan' || r.login?.status === 'starting') {
      pill.className = 'pill warn';
      pill.innerHTML = `<span class="dot"></span><span>作家助手待扫码</span>`;
    } else {
      pill.className = 'pill warn';
      pill.innerHTML = `<span class="dot"></span><span>作家助手未连接</span>`;
    }
    state.zuojia = r;
  } catch {
    pill.className = 'pill bad';
    pill.innerHTML = `<span class="dot"></span><span>作家助手不可用</span>`;
    state.zuojia = { connected: false, reason: '接口不可达' };
  }
  if (state.zuojia?.login?.status === 'starting' || state.zuojia?.login?.status === 'waiting_scan') scheduleZuojiaPoll();
  if (state.route.view === 'push') renderPush();
}

async function loadPushes() {
  if (!state.book) return;
  try {
    state.pushes = await api(`/books/${state.book.id}/pushes`);
  } catch {
    state.pushes = [];
  }
}

function renderPush() {
  if (!state.book) return;
  const z = state.zuojia || {};
  const login = z.login || {};
  $('#zuojia-meta').textContent = z.connected ? '已登录' : login.status === 'waiting_scan' ? '等待扫码' : '未登录';
  const waiting = login.status === 'starting' || login.status === 'waiting_scan';
  const account = z.me?.nickname || z.me?.name || z.me?.username || '';
  $('#zuojia-body').innerHTML = `
    ${
      z.connected
        ? `<div style="padding:10px 12px"><div class="row wrap"><span class="chip ok">已连接</span>${
            account ? `<span class="muted">${esc(account)}</span>` : ''
          }<span class="spacer"></span><button class="btn ghost sm" id="btn-zuojia-logout">退出登录</button></div></div>`
        : `<div class="error-box">未连接：${esc(z.reason || '尚未登录')}
             <div class="fix">扫码登录后，登录态直接写入工作台配置，不需要手改 JSON 或重启服务。</div>
           </div>`
    }
    ${
      waiting
        ? `<div class="plan-box" style="margin:10px 12px;display:grid;grid-template-columns:220px minmax(0,1fr);gap:14px;align-items:start">
             ${
               login.status === 'waiting_scan'
                 ? `<img alt="作家助手微信登录二维码" width="220" height="220" style="width:220px;height:220px;object-fit:contain;border:1px solid var(--line);background:#fff" src="/api/zuojia/qr?t=${Date.now()}">`
                 : `<div class="empty"><b>正在准备二维码</b>浏览器启动后会自动显示，请稍等。</div>`
             }
             <div><b>用微信扫码登录阅文作家专区</b><div class="muted" style="margin-top:6px;line-height:1.7">二维码由工作台内启动的 Firefox 获取。扫码成功后会自动校验登录态并刷新远端作品。</div></div>
           </div>`
        : ''
    }
    ${login.status === 'failed' ? `<div class="error-box">${esc(login.error || '扫码登录失败')}</div>` : ''}
    <div style="padding:10px 12px">
      <div class="row wrap" style="margin-bottom:8px">
        ${z.connected ? '' : `<button class="btn primary" id="btn-zuojia-login" ${waiting ? 'disabled' : ''}>${waiting ? '等待扫码…' : '扫码登录作家助手'}</button>`}
        <button class="btn" id="btn-list-remote" ${z.connected ? '' : 'disabled'}>拉取远端作品</button>
        ${z.connected && !z.binding ? '<button class="btn primary" id="btn-create-remote">在工作台创建远端作品</button>' : ''}
        <span class="chip ${z.binding ? 'ok' : 'plain'}">${z.binding ? `本书已绑定 ${esc(z.binding)}` : '本书未绑定远端作品'}</span>
        <span class="muted" id="remote-hint">递交默认只存草稿，发布需手动开 allowPublish</span>
      </div>
      ${z.connected && !z.binding ? '<div class="muted" style="margin:0 0 8px">远端还没有可绑定的作品时，直接在这里建一本，成功后会自动绑定当前书。</div>' : ''}
      <div id="remote-books"></div>
    </div>`;
  $('#btn-list-remote')?.addEventListener('click', listRemoteBooks);
  $('#btn-create-remote')?.addEventListener('click', () => createRemoteBookDialog());
  $('#btn-zuojia-login')?.addEventListener('click', startZuojiaLogin);
  $('#btn-zuojia-logout')?.addEventListener('click', logoutZuojia);
  if (waiting) scheduleZuojiaPoll();

  const pushes = state.pushes || [];
  $('#push-body').innerHTML = pushes.length
    ? `<table class="grid"><thead><tr><th class="num" style="width:44px">章</th><th style="width:88px">动作</th><th>远端章节</th><th style="width:150px">时间</th></tr></thead><tbody>${pushes
        .map(
          (p) =>
            `<tr><td class="num">${p.chapter_idx}</td><td><span class="chip ${p.action === 'publish' ? 'ok' : 'plain'}">${
              p.action === 'publish' ? '发布' : '草稿'
            }</span></td><td class="mono">${esc(p.remote_chapter_id || '—')}</td><td class="muted mono">${esc(
              (p.created_at || '').replace('T', ' ').slice(0, 16),
            )}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : `<div class="empty"><b>还没有递交记录</b>章节落库后点「递交」，会写进作家助手对应作品的草稿</div>`;
}

async function startZuojiaLogin() {
  try {
    const login = await api('/zuojia/login', { method: 'POST' });
    state.zuojia = { ...(state.zuojia || {}), login };
    renderPush();
    scheduleZuojiaPoll();
  } catch (err) {
    toast(err.message, 5000);
  }
}

function scheduleZuojiaPoll() {
  if (state.zuojiaPoll) clearTimeout(state.zuojiaPoll);
  state.zuojiaPoll = setTimeout(async () => {
    state.zuojiaPoll = null;
    try {
      const login = await api('/zuojia/login');
      state.zuojia = { ...(state.zuojia || {}), login };
      if (login.status === 'connected') {
        toast(`作家助手已连接${login.me?.nickname ? `：${login.me.nickname}` : ''}`);
        await refreshZuojia();
        return;
      }
      if (login.status === 'failed') {
        toast(login.error || '扫码登录失败', 5000);
        if (state.route.view === 'push') renderPush();
        return;
      }
      if (state.route.view === 'push') renderPush();
      scheduleZuojiaPoll();
    } catch {
      scheduleZuojiaPoll();
    }
  }, 900);
}

async function logoutZuojia() {
  try {
    await api('/zuojia/logout', { method: 'POST' });
    state.zuojia = { connected: false, reason: '已退出登录', binding: state.zuojia?.binding, login: { status: 'idle' }, canLogin: true };
    await refreshZuojia();
  } catch (err) {
    toast(err.message, 5000);
  }
}

async function listRemoteBooks() {
  try {
    const books = await api(`/books/${state.book.id}/zuojia/books`);
    $('#remote-books').innerHTML = books.length
      ? `<table class="grid"><thead><tr><th>CBID</th><th>书名</th><th class="num">字数</th><th style="width:100px">绑定</th></tr></thead><tbody>${books
          .map((b) => `<tr><td class="mono">${esc(b.cbid)}</td><td>${esc(b.title)}</td><td class="num">${fmtNum(b.words)}</td><td>${
            state.zuojia?.binding === b.cbid ? '<span class="chip ok">当前书</span>' : `<button class="btn ghost sm" data-bind-cbid="${esc(b.cbid)}">绑定本书</button>`
          }</td></tr>`)
          .join('')}</tbody></table>`
      : `<div class="empty"><b>远端还没有作品</b>点上方「在工作台创建远端作品」，不用去客户端或网页手动建书</div>`;
    $$('#remote-books [data-bind-cbid]').forEach((btn) => btn.addEventListener('click', () => bindRemoteBook(btn.dataset.bindCbid)));
  } catch (err) {
    $('#remote-books').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
  }
}

async function bindRemoteBook(cbid) {
  try {
    const r = await api(`/books/${state.book.id}/zuojia/bind`, { method: 'POST', body: { cbid } });
    state.zuojia = { ...(state.zuojia || {}), binding: r.binding };
    toast(`已绑定远端作品 ${r.binding}`);
    renderPush();
    await listRemoteBooks();
  } catch (err) {
    toast(err.message, 5000);
  }
}

async function createRemoteBookDialog(retryPushIdx = null) {
  if (!state.zuojia?.connected) return toast('请先扫码登录作家助手');
  state.pendingPushIdx = retryPushIdx;
  try {
    const first = state.createSite || state.createOptions?.selectedSite || 0;
    const options = await api(`/zuojia/create-options${first ? `?site=${encodeURIComponent(first)}` : ''}`);
    state.createOptions = options;
    state.createSite = options.selectedSite || options.sites[0]?.site || 0;
    state.createCategory = '';
    state.createSubcategory = '';
    if (!options.sites.length) throw new Error('没有可用的发布站点');
    renderCreateRemoteBook(options);
  } catch (err) {
    toast(err.message, 5000);
  }
}

function renderCreateRemoteBook(options) {
  const selectedSite = state.createSite || options.selectedSite || options.sites[0]?.site;
  const categories = options.categories || [];
  const genre = String(state.book?.genre || '').trim();
  const genreCategory = genre
    ? categories.find((c) => genre.includes(c.categoryname) || c.categoryname.includes(genre))
    : undefined;
  const selectedCategory = categories.find((c) => c.categoryid === state.createCategory) || genreCategory || categories[0];
  state.createCategory = selectedCategory?.categoryid || '';
  const subcategories = selectedCategory?.subcategories || [];
  const genreSubcategory = genre
    ? subcategories.find((s) => genre.includes(s.subcategoryname) || s.subcategoryname.includes(genre))
    : undefined;
  const selectedSubcategory = subcategories.find((s) => s.subcategoryid === state.createSubcategory) || genreSubcategory || subcategories[0];
  state.createSubcategory = selectedSubcategory?.subcategoryid || '';

  $('#dialog-title').textContent = '在工作台创建远端作品';
  $('#dialog-body').innerHTML = `
    <div class="field"><label>作品名</label><input id="f-remote-title" maxlength="15" value="${esc(state.book?.title || '')}"></div>
    <div class="field"><label>发布站点</label><select id="f-remote-site">${options.sites
      .map((s) => `<option value="${s.site}" ${s.site === selectedSite ? 'selected' : ''}>${esc(s.name)}</option>`)
      .join('')}</select></div>
    <div class="field"><label>分类</label><select id="f-remote-category">${categories
      .map((c) => `<option value="${esc(c.categoryid)}" ${c.categoryid === state.createCategory ? 'selected' : ''}>${esc(c.categoryname)}</option>`)
      .join('') || '<option value="">该站点暂无分类</option>'}</select></div>
    <div class="field"><label>子分类</label><select id="f-remote-subcategory">${subcategories
      .map((s) => `<option value="${esc(s.subcategoryid)}" ${s.subcategoryid === state.createSubcategory ? 'selected' : ''}>${esc(s.subcategoryname)}</option>`)
      .join('') || '<option value="">该分类暂无子分类</option>'}</select></div>
    <div class="field"><label>简介</label><textarea id="f-remote-intro" placeholder="留空则使用本地书的核心设定">${esc(state.book?.premise || '')}</textarea></div>
    <div class="muted" style="line-height:1.7">只创建作品并绑定当前书，不自动发布章节。建好后可在章节旁点「递交」写草稿。</div>`;
  $('#dialog-backdrop').classList.add('open');

  $('#f-remote-site').addEventListener('change', async (event) => {
    state.createSite = Number(event.target.value);
    state.createCategory = '';
    state.createSubcategory = '';
    const siteSelect = event.target;
    siteSelect.disabled = true;
    try {
      const next = await api(`/zuojia/create-options?site=${encodeURIComponent(state.createSite)}`);
      state.createOptions = { ...options, ...next, selectedSite: state.createSite };
      renderCreateRemoteBook(state.createOptions);
    } catch (err) {
      toast(err.message, 5000);
      siteSelect.disabled = false;
    }
  });
  $('#f-remote-category').addEventListener('change', (event) => {
    state.createCategory = event.target.value;
    const category = categories.find((c) => c.categoryid === state.createCategory);
    const sub = category?.subcategories?.[0];
    state.createSubcategory = sub?.subcategoryid || '';
    const select = $('#f-remote-subcategory');
    if (select) {
      select.innerHTML = (category?.subcategories || [])
        .map((s) => `<option value="${esc(s.subcategoryid)}">${esc(s.subcategoryname)}</option>`)
        .join('') || '<option value="">该分类暂无子分类</option>';
    }
  });
  $('#f-remote-subcategory').addEventListener('change', (event) => {
    state.createSubcategory = event.target.value;
  });

  const ok = $('#dialog-ok');
  ok.textContent = '创建并绑定';
  ok.onclick = async () => {
    const title = $('#f-remote-title').value.trim();
    const site = Number($('#f-remote-site').value);
    const categoryid = $('#f-remote-category').value;
    const subcategoryid = $('#f-remote-subcategory').value;
    const intro = $('#f-remote-intro').value.trim();
    if (!title) return toast('作品名不能为空');
    if (!site || !categoryid || !subcategoryid) return toast('请选择站点和分类');
    ok.disabled = true;
    try {
      const result = await api(`/books/${state.book.id}/zuojia/create`, {
        method: 'POST',
        body: { title, site, categoryid, subcategoryid, intro },
      });
      state.zuojia = { ...(state.zuojia || {}), binding: result.binding };
      $('#dialog-backdrop').classList.remove('open');
      toast(`已创建并绑定远端作品 ${result.cbid}`);
      ok.onclick = null;
      renderPush();
      await listRemoteBooks();
      const pendingPushIdx = state.pendingPushIdx;
      state.pendingPushIdx = null;
      if (pendingPushIdx) {
        state.route.idx = pendingPushIdx;
        await pushCurrent();
      }
    } catch (err) {
      toast(err.message, 5000);
    } finally {
      ok.disabled = false;
      ok.textContent = '确定';
    }
  };
}

async function pushCurrent() {
  const idx = state.route.idx;
  if (!idx || !state.book) return;
  try {
    const out = await api(`/books/${state.book.id}/push`, { method: 'POST', body: { idx } });
    toast(`第 ${idx} 章已递交草稿（远端 ${out.remoteChapterId}）`);
    log('push', `第 ${idx} 章 → 作家助手草稿 ${out.remoteChapterId}`, 'commit');
    await loadPushes();
    if (state.route.view === 'push') renderPush();
  } catch (err) {
    if (state.zuojia?.connected && !state.zuojia?.binding && /还没有绑定远端作品/.test(err.message)) {
      toast('这本书还没有远端作品，先创建工作台作品', 4000);
      await createRemoteBookDialog(idx);
      return;
    }
    toast(err.message, 5000);
    log('push', err.message, 'err');
  }
}

// ── 抽屉 ──────────────────────────────────────────────
async function openChapter(idx) {
  const detail = await api(`/books/${state.book.id}/chapters/${idx}`);
  const ch = detail.chapter;
  if (!ch) return toast('这一章还没有正文');
  state.route.idx = idx;
  state.drawerChapter = ch;
  $('#drawer-title').textContent = `第 ${idx} 章 · ${ch.title}`;
  const report = safeParse(ch.checks)?.report;
  const review = safeParse(ch.checks)?.review;
  $('#drawer-meta').innerHTML = `${fmtNum(ch.word_count)} 字 · ${statusChip(ch.status)}`;
  const suspects = safeParse(ch.checks)?.suspects || [];
  const issues = [...(report?.issues || []), ...(review?.issues || [])];
  $('#drawer-body').innerHTML = `
    <div class="row wrap" style="margin-bottom:10px">
      ${report ? `<span class="chip ${report.score >= 70 ? 'ok' : 'warn'}">质检 ${report.score}</span>` : ''}
      ${report ? `<span class="chip plain">段 ${report.stats.paragraphs} · 均 ${report.stats.avgParagraph} 字</span>` : ''}
      ${report ? `<span class="chip ${report.stats.bannedHits > 3 ? 'bad' : 'plain'}">套话 ${report.stats.bannedHits}</span>` : ''}
      ${review?.verdict ? `<span class="chip ${review.verdict === 'pass' ? 'ok' : 'warn'}">审稿 ${review.verdict}</span>` : ''}
    </div>
    ${
      suspects.length
        ? `<div class="error-box" style="margin:0 0 12px">正文出现未登记人名：${suspects.map(esc).join('、')}
             <div class="fix">先到「人物」页补卡，再点「返工」，否则后面容易把这些人写成另一个人。</div></div>`
        : ''
    }
    ${issues.length ? `<div class="plan-box" style="margin-bottom:12px"><h3>需要处理</h3><ul class="beats">${issues
      .slice(0, 8)
      .map((i) => `<li><span class="n">${i.severity === 'block' ? '!' : '·'}</span><span>${esc(i.message)}${
        i.quote ? `<div class="shift">「${esc(i.quote)}」</div>` : ''
      }</span></li>`)
      .join('')}</ul></div>` : ''}
    <div class="prose" id="drawer-prose">${String(ch.content)
      .split(/\n+/)
      .filter((x) => x.trim())
      .map((x, i) => `<p data-p="${i}"><span>${esc(x.trim())}</span><button class="btn ghost sm rw" data-p="${i}" title="只改这一段">改</button></p>`)
      .join('')}</div>
    ${
      (safeParse(ch.checks)?.pacing?.highlights || []).length
        ? `<div class="plan-box" style="margin:12px 0"><h3>本章爆点</h3><ul class="beats">${safeParse(ch.checks).pacing.highlights
            .map((h) => `<li><span class="n">${h.intensity}</span><span>${esc(h.type)}·${h.kind === 'hook' ? '章末钩子' : h.kind === 'climax' ? '高潮' : '爽点'}：${esc(h.title || '')}</span></li>`)
            .join('')}</ul></div>`
        : ''
    }
    ${detail.facts?.length ? `<div class="pane-head" style="padding-left:0"><h2>本章事实</h2></div><ul class="beats">${detail.facts
      .map((f) => `<li><span class="n">·</span><span>${esc(f.subject || '')}：${esc(f.fact)}</span></li>`)
      .join('')}</ul>` : ''}`;
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#drawer-backdrop').classList.add('open');
  renderChapters();
  $$('#drawer-prose button.rw').forEach((btn) =>
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.p);
      const paras = String(ch.content).split(/\n+/).filter((x) => x.trim());
      rewriteParagraphFlow(idx, paras[i]);
    }),
  );
}

function rewriteParagraphFlow(idx, paragraph) {
  dialog(
    '只改这一段',
    [{ key: 'instruction', label: '怎么改（不写则按默认：去套话、情绪落到动作）', type: 'textarea', placeholder: '例：压缩到一半长度，把最后一句改成动作' }],
    async (d) => {
      const r = await api(`/books/${state.book.id}/chapters/${idx}`, { method: 'POST', body: { paragraph, instruction: d.instruction } });
      toast('已替换该段');
      await refreshBook();
      await openChapter(idx);
    },
  );
}

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#drawer-backdrop').classList.remove('open');
}

async function reviseCurrent() {
  const idx = state.route.idx;
  if (!idx) return;
  try {
    log('revise', `第 ${idx} 章只返工不重写…`);
    const r = await api(`/books/${state.book.id}/write`, { method: 'POST', body: { idx, reviseOnly: true } });
    log('revise', `返工完成：${fmtNum(r.words)} 字 · 质检 ${r.report.score}`, 'commit');
    await refreshBook();
    await openChapter(idx);
  } catch (err) {
    toast(err.message);
    log('revise', err.message, 'err');
  }
}

async function stopAndRevise(idx) {
  state.route.idx = idx;
  await reviseCurrent();
}

async function stopAndPush(idx) {
  state.route.idx = idx;
  await pushCurrent();
}

// ── 对话框 ────────────────────────────────────────────
function dialog(title, fields, onOk) {
  $('#dialog-title').textContent = title;
  $('#dialog-body').innerHTML = fields
    .map(
      (f) => `<div class="field"><label>${esc(f.label)}</label>${
        f.type === 'textarea'
          ? `<textarea id="f-${f.key}" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>`
          : f.type === 'select'
            ? `<select id="f-${f.key}">${f.options
                .map((o) => `<option value="${o[0]}" ${String(f.value) === String(o[0]) ? 'selected' : ''}>${esc(o[1])}</option>`)
                .join('')}</select>`
            : `<input type="${f.type || 'text'}" id="f-${f.key}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}">`
      }</div>`,
    )
    .join('');
  $('#dialog-backdrop').classList.add('open');
  const ok = $('#dialog-ok');
  ok.textContent = '确定';
  ok.onclick = async () => {
    const data = {};
    for (const f of fields) data[f.key] = $(`#f-${f.key}`).value;
    ok.disabled = true;
    try {
      await onOk(data);
      $('#dialog-backdrop').classList.remove('open');
      ok.onclick = null;
    } catch (err) {
      toast(err.message);
    } finally {
      ok.disabled = false;
    }
  };
}

function newBookDialog() {
  dialog(
    '新建书',
    [
      { key: 'title', label: '书名' },
      { key: 'genre', label: '题材', placeholder: '悬疑 / 玄幻 / 都市' },
      { key: 'premise', label: '核心设定（一句话）', type: 'textarea' },
      { key: 'audience', label: '目标读者' },
      { key: 'targetWords', label: '每章目标字数', type: 'number', value: 2600 },
    ],
    async (d) => {
      if (!d.title) throw new Error('书名不能为空');
      const book = await api('/books', { method: 'POST', body: { ...d, targetWords: Number(d.targetWords) || 2600 } });
      await loadBooks();
      state.book = state.books.find((b) => b.id === book.id) || book;
      await refreshAll();
      toast('已新建，点「写下一章」开始');
    },
  );
}

function addThreadDialog() {
  dialog(
    '登记线索',
    [
      { key: 'code', label: 'code（英文短 id）', placeholder: 'list_shadow' },
      { key: 'title', label: '标题' },
      { key: 'detail', label: '内容', type: 'textarea' },
      { key: 'dueFrom', label: '开始回收章', type: 'number' },
      { key: 'dueTo', label: '最晚回收章', type: 'number' },
    ],
    async (d) => {
      await api(`/books/${state.book.id}/threads`, {
        method: 'POST',
        body: { ...d, due_from: Number(d.dueFrom) || null, due_to: Number(d.dueTo) || null },
      });
      await refreshBook();
      toast('已登记');
    },
  );
}

function addBibleDialog() {
  dialog(
    '新增设定',
    [
      { key: 'category', label: '分类', type: 'select', options: (state.bibleCats.length ? state.bibleCats : [{ name: '背景设定' }, { name: '其他设定' }]).map((x) => [x.name, x.name]), value: '背景设定' },
      { key: 'kind', label: '类型', type: 'select', options: [['world', '世界'], ['location', '地点'], ['faction', '势力'], ['item', '物品'], ['rule', '规则']] },
      { key: 'name', label: '名称' },
      { key: 'content', label: '内容', type: 'textarea' },
      { key: 'importance', label: '重要度 1-5', type: 'number', value: 3 },
    ],
    async (d) => {
      await api(`/books/${state.book.id}/bible`, { method: 'POST', body: { ...d, importance: Number(d.importance) || 3 } });
      await renderBible();
      toast('已加入设定集');
    },
  );
}

async function exportDocx() {
  if (!state.book) return;
  try {
    const r = await api(`/books/${state.book.id}/export`, { method: 'POST', body: { format: 'docx' } });
    toast(r.docx ? `已导出 docx：${r.docx}` : '导出完成', 6000);
  } catch (err) {
    toast(err.message);
  }
}

async function exportBook() {
  if (!state.book) return;
  try {
    const r = await api(`/books/${state.book.id}/export`, { method: 'POST', body: {} });
    toast(`已导出 ${r.files} 章 → ${r.dir}`, 5000);
  } catch (err) {
    toast(err.message);
  }
}

async function renderCastTimeline() {
  if (!state.book) return;
  try {
    const rows = await api(`/books/${state.book.id}/character-timeline`);
    $('#cast-timeline-meta').textContent = `${rows.length} 人`;
    $('#cast-timeline').innerHTML = rows.length
      ? `<table class="grid"><thead><tr><th style="width:96px">人物</th><th>计划章</th><th>实际章</th><th class="num" style="width:64px">缺场</th><th class="num" style="width:88px">首次/末次</th></tr></thead><tbody>${rows
          .slice(0, 12)
          .map(
            (r) => `<tr><td class="mono">${esc(r.name)}</td>
              <td class="muted">${r.planned.join(',') || '—'}</td>
              <td>${r.actual.join(',') || '—'}</td>
              <td class="num">${r.missing.length || '—'}</td>
              <td class="num">${r.firstIdx ?? '—'}/${r.lastIdx ?? '—'}</td></tr>`,
          )
          .join('')}</tbody></table>`
      : `<div class="empty">还没有出场记录</div>`;
  } catch {
    $('#cast-timeline').innerHTML = '';
  }
}
