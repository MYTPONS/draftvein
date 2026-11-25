/**
 * 单章流水线（一次只写一章）：
 *   plan(单章) → scene×N(逐场景生成 + 局部返工) → 拼装 → 规则质检 → 模型审稿
 *   → 定点替换返工 → 事实/伏笔抽取（证据核验）→ 落库
 */
import type { Store } from '../db/index.ts';
import type { Llm } from '../llm/client.ts';
import type { Book, Chapter } from './book.ts';
import {
  addFacts,
  addTimeline,
  getChapter,
  getPlan,
  listChapters,
  saveChapter,
  setPlanStatus,
  touchCharacters,
  upsertCharacter,
  suspectNames,
  ensureSuspectCharacters,
  volumeIdForIndex,
} from './book.ts';
import { buildContext, parseBeats } from './context.ts';
import { extractPrompt, repairPrompt, reviewPrompt, scenePrompt, WRITER_SYSTEM } from './prompts.ts';
import { inspect, countWords, missingMusts, shouldKeepRepair, type Issue, type QualityReport } from './quality.ts';
import { applyThreadEvents, quoteExistsInText, type ThreadEvent } from './ledger.ts';
import { castIssues, timelineIssues } from './consistency.ts';
import { applyHighlights, pacingReport, withPlannedSetups } from './pacing.ts';
import { applyExpectationEvents } from './expectations.ts';
import { stageAt } from './structure.ts';
import { addRelation } from './book.ts';
import { ensurePlan } from './outline.ts';
import { ensureVoiceProfile } from './voice.ts';

export interface ChapterResult {
  idx: number;
  title: string;
  words: number;
  report: QualityReport;
  review?: { verdict?: string; scores?: Record<string, number>; issues?: Issue[] };
  threadEvents: { applied: ThreadEvent[]; rejected: { event: ThreadEvent; reason: string }[] };
  cost: { calls: number; promptChars: number; outputChars: number };
}

export interface WriteOptions {
  signal?: AbortSignal;
  onEvent?: (stage: string, message: string, data?: any) => void;
  sceneRetries?: number;
  repairRounds?: number;
  /** 只返工，不重新生成：使用已落库正文 */
  reviseOnly?: boolean;
  /** 独立的审稿模型（不给就用主模型） */
  reviewLlm?: Llm;
}

export async function writeChapter(
  store: Store,
  llm: Llm,
  book: Book,
  chapterIdx: number,
  opts: WriteOptions = {},
): Promise<ChapterResult> {
  const emit = opts.onEvent ?? (() => {});
  const signal = opts.signal;
  book = await ensureVoiceProfile(store, llm, book, {
    signal,
    onEvent: (message) => emit('voice', message),
  });
  const existing = getChapter(store, book.id, chapterIdx);
  let plan = getPlan(store, book.id, chapterIdx);

  if (!existing || !plan) {
    const p = await ensurePlan(store, llm, book, chapterIdx, { signal, onEvent: (m, d) => emit('plan', m, d) });
    plan = getPlan(store, book.id, chapterIdx)!;
    emit('plan', `计划：${p.title}`, { beats: p.beats.length });
  }

  const beats = parseBeats(plan.beats);
  const planCast: string[] = (() => {
    try {
      const v = JSON.parse(plan.cast || '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  })();
  const targetWords = plan.word_target || book.target_words;
  const perScene = Math.max(400, Math.round(targetWords / Math.max(beats.length, 1)));

  const ctx = buildContext(store, book, chapterIdx, plan, { tailChars: 900 });

  let scenes: string[] = [];
  if (opts.reviseOnly && existing) {
    scenes = [existing.content];
    emit('draft', `复用已有正文（${existing.word_count} 字），进入返工`);
  } else {
    for (let i = 0; i < beats.length; i++) {
      const beat = beats[i];
      let issues: string[] = [];
      let text = '';
      let finalHard: Issue[] = [];
      const retries = opts.sceneRetries ?? Number(process.env.NOVEL_FORGE_SCENE_RETRIES ?? 2);
      for (let attempt = 0; attempt <= retries; attempt++) {
        const writtenSoFar = scenes.join('\n\n');
        const previousPlace = i > 0 ? beats[i - 1]?.place : undefined;
        text = await llm.text(
          scenePrompt({
            ctx,
            chapterIdx,
            planTitle: plan.title,
            planGoal: plan.goal,
            beatIndex: i,
            beatTotal: beats.length,
            beat,
            writtenSoFar,
            targetWords: perScene,
            synopsis: plan.synopsis,
            issues,
            previousPlace,
            pov: plan.pov || planCast[0] || '',
          }),
          {
            purpose: `draft.chapter.${chapterIdx}.scene.${i + 1}`,
            system: WRITER_SYSTEM,
            mockKind: 'draft',
            mockSeed: `${book.slug}:${chapterIdx}:${i}`,
            signal,
          },
        );
        const local = inspect(
          text,
          llm.cfg.provider === 'mock'
            ? { targetWords: perScene, skipNarrativeChecks: true }
            : { targetWords: perScene, requiredPlace: beat.place, previousPlace, sceneIndex: i + 1, pov: plan.pov || planCast[0] || '', cast: planCast },
        );
        const hard = local.issues.filter((x) => x.severity === 'block');
        finalHard = hard;
        if (!hard.length) break;
        issues = hard.map((x) => x.message + (x.fix ? `（改法：${x.fix}）` : ''));
        emit('draft', `场景 ${i + 1} 局部不达标，返工第 ${attempt + 1} 次：${issues.join('；')}`);
      }
      if (finalHard.length) {
        throw new Error(`第 ${chapterIdx} 章场景 ${i + 1} 重试后仍未通过：${finalHard.map((x) => x.message).join('；')}`);
      }
      scenes.push(text.trim());
      emit('draft', `场景 ${i + 1}/${beats.length} 完成（${countWords(text)} 字）`);
    }
  }

  let content = scenes.join('\n\n');
  // 碎句文兜底：超过一半段落只有一句，就两两合并
  {
    const mergeOnes = (text: string) => {
      let paras = text.split(/\n+/).map((x) => x.trim()).filter(Boolean);
      const ratio = () => paras.filter((p) => (p.match(/[。！？]/g) || []).length <= 1).length / Math.max(1, paras.length);
      let guard = 0;
      while (ratio() > 0.4 && guard < 6) {
        guard++;
        const next: string[] = [];
        for (let i = 0; i < paras.length; i++) {
          const cur = paras[i];
          const nxt = paras[i + 1];
          if (nxt && (cur.match(/[。！？]/g) || []).length <= 1 && (nxt.match(/[。！？]/g) || []).length <= 1) {
            next.push(cur + nxt);
            i++;
          } else next.push(cur);
        }
        if (next.length === paras.length) break;
        paras = next;
      }
      return paras.join('\n\n');
    };
    content = mergeOnes(content);
  }
  // musts 契约：本章必须出现的具体东西，缺了先尝试自然织进去，再核对
  let planMusts: string[] = [];
  try {
    planMusts = JSON.parse(plan.musts || '[]');
  } catch {
    planMusts = [];
  }
  if (planMusts.length) {
    let missing = missingMusts(planMusts, content);
    if (missing.length) {
      emit('check', `本章缺 must：${missing.join('、')}，尝试补写`);
      try {
        const paras = content.split(/\n+/).filter((x) => x.trim());
        let target = 0;
        for (let i = 0; i < paras.length - 1; i++) if (paras[i].length > paras[target].length) target = i;
        const fixed = await llm.text(
          `把下面这些必须出现的元素，自然地写进这段小说正文（可以改成动作、对话或物件），不要改变原有情节，不要解释。只输出改写后的这一段。\n必须出现：${missing.join('；')}\n原文段落：\n${paras[target]}`,
          { purpose: `must.insert.${chapterIdx}`, system: '你是小说编辑，只输出改写后的段落。', mockKind: 'plain', signal },
        );
        const clean = fixed.trim().replace(/^["“]|["”]$/g, '');
        const stillMissing = missingMusts(missing, clean);
        const bad = /仿佛|似乎|不由得|一丝|一抹|缓缓/.test(clean);
        if (clean && stillMissing.length === 0 && !bad) {
          paras[target] = clean;
          content = paras.join('\n\n');
          missing = missingMusts(planMusts, content);
          emit('check', `must 已补写：${planMusts.length - missing.length}/${planMusts.length}`);
        }
      } catch (err) {
        emit('check', `must 补写失败：${(err as Error).message}`);
      }
    }
    if (missing.length) {
      emit('check', `must 仍缺：${missing.join('、')}`);
    }
  }

  const plannedPlaces = [...new Set(beats.map((b) => b.place).filter((x): x is string => Boolean(x)))];
  const qualityOpts = () => ({
    targetWords,
    previous: previousContents(store, book.id, chapterIdx),
    pov: plan.pov || planCast[0] || '',
    cast: planCast,
    ...(llm.cfg.provider === 'mock' ? { skipNarrativeChecks: true } : { plannedPlaces }),
  });
  let report = inspect(content, qualityOpts());
  if (planMusts.length) {
    const missing = missingMusts(planMusts, content);
    if (missing.length) {
      report.issues.push({ severity: 'warn', type: 'must', message: `本章缺 ${missing.length} 项必须出现的东西：${missing.join('、')}`, fix: '把缺的元素写进具体动作或台词' });
      report.score = Math.max(0, report.score - 5 * Math.min(missing.length, 4));
    }
  }
  const previous = previousContents(store, book.id, chapterIdx);

  // 字数不足：补一个收尾场景，而不是拉长已有段落
  if (report.words < targetWords * 0.75) {
    emit('draft', `字数 ${report.words}/${targetWords} 不足，补一个收尾场景`);
    const extra = await llm.text(
      scenePrompt({
        ctx,
        chapterIdx,
        planTitle: plan.title,
        planGoal: plan.goal,
        beatIndex: beats.length,
        beatTotal: beats.length + 1,
        beat: { place: beats.at(-1)?.place, present: beats.at(-1)?.present, action: '收尾：把本章的信息变化落地，留一个具体的不安', shift: '读者获得一个新的具体疑问' },
        writtenSoFar: content,
        targetWords: Math.max(400, Math.round(targetWords - report.words)),
        synopsis: plan.synopsis,
        issues: ['上一稿字数不足，这一段需要把场面写实，不要总结'],
      }),
      {
        purpose: `draft.chapter.${chapterIdx}.tailfix`,
        system: WRITER_SYSTEM,
        mockKind: 'draft',
        mockSeed: `${book.slug}:${chapterIdx}:tail`,
        signal,
      },
    );
    content = `${content}\n\n${extra.trim()}`;
    report = inspect(content, qualityOpts());
  }

  // 字数超标：超过目标 135% 就压一遍，压完不能变差
  if (report.words > Math.round(targetWords * 1.35)) {
    emit('revise', `字数 ${report.words} 超过目标 ${targetWords} 的 135%，尝试压缩`);
    try {
      const before = report;
      const compressed = await llm.text(
        `把下面这章小说压缩到 ${Math.round(targetWords * 1.1)} 字以内。保留所有事件、关键对白和章末钩子，删掉重复的描写、解释和过渡句。不要改情节。只输出正文。\n\n${content}`,
        { purpose: `compress.${chapterIdx}`, system: '你是小说编辑，只输出压缩后的正文。', mockKind: 'plain', signal },
      );
      const next = compressed.trim();
      if (next && countWords(next) < before.words) {
        const r2 = inspect(next, qualityOpts());
        if (r2.score >= before.score - 5) {
          content = next;
          report = r2;
          emit('revise', `压缩：${before.words} → ${r2.words} 字（质检 ${before.score} → ${r2.score}）`);
        } else {
          emit('revise', `压缩后质检掉太多（${before.score} → ${r2.score}），放弃`);
        }
      }
    } catch (err) {
      emit('revise', `压缩失败：${(err as Error).message}`);
    }
  }

  // 章末兜底：最后一段像总结/抒情就重写成钩子
  if (!/(——“|”|。)$/.test('') && false) {
    /* noop */
  }
  const tailIssues = report.issues.filter((i) => i.type === 'ending');
  if (tailIssues.length) {
    emit('revise', '章末像总结，重写最后一段为钩子');
    try {
      const parts = content.split(/\n+/).filter((x) => x.trim());
      const last = parts[parts.length - 1];
      const fixed = await llm.text(
        `把下面这段小说结尾改写成钩子。只输出改写后的这一两句话，不要解释。\n要求：三种写法任选其一——① 一个没做完的动作；② 一句没说完的话；③ 一个刚出现的东西。不要总结、不要抒情、不要比喻。\n原文：\n${last}`,
        { purpose: `hook.fix.${chapterIdx}`, system: '你是小说编辑，只输出改写后的结尾。', mockKind: 'plain', signal },
      );
      const clean = fixed.trim().split(/\n+/).filter(Boolean).slice(0, 2).join('\n');
      const badPhrase = /仿佛|似乎|不由得|不禁|一丝|一抹|缓缓|眼中闪过|心中一凛|空气中弥漫/.test(clean);
      if (clean && countWords(clean) <= 80 && !badPhrase) {
        parts[parts.length - 1] = clean;
        content = parts.join('\n\n');
        report = inspect(content, qualityOpts());
        emit('revise', `结尾已替换：${clean.slice(0, 30)}`);
      }
    } catch (err) {
      emit('revise', `结尾重写失败：${(err as Error).message}`);
    }
  }

  // 模型审稿
  let review: any = undefined;
  try {
    const reviewer = opts.reviewLlm ?? llm;
    review = await reviewer.json<any>(reviewPrompt({ ctx, chapterIdx, title: plan.title, content }), {
      purpose: `review.chapter.${chapterIdx}`,
      system: '你是网文编辑，只输出 JSON。',
      mockKind: 'review',
      mockSeed: `${book.slug}:${chapterIdx}`,
      signal,
    });
  } catch (err) {
    emit('review', `审稿失败（跳过，仅用规则质检）：${(err as Error).message}`);
  }

  // 审稿结果归一化：模型经常把枚举抄进 type、把分数填 0
  if (review) {
    const allowed = new Set(['continuity', 'voice', 'pacing', 'info', 'slop', 'dialogue', 'character', 'poison']);
    review.issues = (Array.isArray(review.issues) ? review.issues : []).slice(0, 6).map((i: any) => ({
      ...i,
      severity: String(i.severity || 'warn').split('|')[0].trim() === 'block' ? 'block' : 'warn',
      type: String(i.type || 'voice').split('|').map((x: string) => x.trim()).find((x: string) => allowed.has(x)) || 'voice',
    }));
    const rawScores = review.scores && typeof review.scores === 'object' ? review.scores : {};
    const keys = ['continuity', 'voice', 'pacing', 'information', 'anti_slop', 'characters'];
    const fixed: Record<string, number> = {};
    for (const k of keys) {
      let v = Number(rawScores[k]);
      if (!Number.isFinite(v) || v <= 0 || v > 10) v = 7;
      fixed[k] = Math.round(Math.min(10, Math.max(1, v)));
    }
    review.scores = fixed;
    const avg = keys.reduce((a, k) => a + fixed[k], 0) / keys.length;
    const hasBlock = review.issues.some((i: any) => i.severity === 'block');
    review.verdict = hasBlock || avg < 7 ? 'revise' : 'pass';
  }

  // 只有 warn、没有 block 的 revise：挑两条带原句的问题做一次润色，再复审
  if (review?.verdict === 'revise') {
    const blocks = (review.issues || []).filter((i: any) => i.severity === 'block');
    const fixables = (review.issues || []).filter((i: any) => i.severity === 'warn' && i.quote && content.includes(i.quote)).slice(0, 2);
    if (!blocks.length && fixables.length) {
      emit('revise', `按审稿意见润色 ${fixables.length} 处（无 block）`);
      try {
        const out = await llm.json<{ replacements: { old: string; new: string }[] }>(
          repairPrompt({ issues: fixables.map((i: any) => ({ quote: i.quote, why: i.why || i.message, fix: i.fix })), content }),
          { purpose: `polish.chapter.${chapterIdx}`, system: '只输出 JSON，不要解释。', mockKind: 'plain', signal },
        );
        const before = content;
        for (const rep of out.replacements || []) {
          if (rep.old && rep.new && content.includes(rep.old)) content = content.replace(rep.old, rep.new);
        }
        if (content !== before && review) {
          const re = await (opts.reviewLlm ?? llm).json<any>(reviewPrompt({ ctx, chapterIdx, title: plan.title, content }), {
            purpose: `review.chapter.${chapterIdx}.re`,
            system: '你是网文编辑，只输出 JSON。',
            mockKind: 'review',
            mockSeed: `${book.slug}:${chapterIdx}:re`,
            signal,
          });
          if (re?.scores) {
            const keys = ['continuity', 'voice', 'pacing', 'information', 'anti_slop', 'characters'];
            const fixed: Record<string, number> = {};
            for (const k of keys) {
              let v = Number(re.scores[k]);
              if (!Number.isFinite(v) || v <= 0 || v > 10) v = 7;
              fixed[k] = Math.round(Math.min(10, Math.max(1, v)));
            }
            re.scores = fixed;
            re.issues = (Array.isArray(re.issues) ? re.issues : []).slice(0, 6).map((i: any) => ({
              ...i,
              severity: String(i.severity || 'warn').split('|')[0].trim() === 'block' ? 'block' : 'warn',
              type: String(i.type || 'voice').split('|').map((x: string) => x.trim()).find((x: string) => ['continuity','voice','pacing','info','slop','dialogue','character','poison'].includes(x)) || 'voice',
            }));
            const avg2 = keys.reduce((a, k) => a + fixed[k], 0) / keys.length;
            re.verdict = re.issues.some((i: any) => i.severity === 'block') || avg2 < 7 ? 'revise' : 'pass';
            review = re;
            report = inspect(content, qualityOpts());
            emit('revise', `润色后复审：${re.verdict}（均分 ${avg2.toFixed(1)}）`);
          }
        }
      } catch (err) {
        emit('revise', `润色失败：${(err as Error).message}`);
      }
    }
  }

  const reviewIssues: Issue[] = Array.isArray(review?.issues) ? review.issues : [];
  const hardIssues = [
    ...report.issues.filter((i) => i.severity === 'block' && i.type !== 'length'),
    ...reviewIssues.filter((i) => i.severity === 'block'),
  ];

  // 定点替换返工
  const rounds = opts.repairRounds ?? Number(process.env.NOVEL_FORGE_REPAIR_ROUNDS ?? 2);
  for (let r = 0; r < rounds && hardIssues.length; r++) {
    const fixable = hardIssues
      .filter((i) => i.quote && content.includes(i.quote))
      .slice(0, 6)
      .map((i) => ({ quote: i.quote, why: i.message, fix: i.fix }));
    if (!fixable.length) break;
    emit('revise', `定点返工第 ${r + 1} 轮（${fixable.length} 处）`);
    try {
      const out = await llm.json<{ replacements: { old: string; new: string }[] }>(repairPrompt({ issues: fixable, content }), {
        purpose: `revise.chapter.${chapterIdx}.${r + 1}`,
        system: '只输出 JSON，不要解释。',
        mockKind: 'plain',
        signal,
      });
      const before = content;
      const beforeSlop = inspect(before, qualityOpts()).stats.bannedHits;
      let changed = 0;
      for (const rep of out.replacements || []) {
        if (rep.old && rep.new && content.includes(rep.old)) {
          content = content.replace(rep.old, rep.new);
          changed++;
        }
      }
      const afterSlop = inspect(content, qualityOpts()).stats.bannedHits;
      const targetedQuotes = fixable.map((i) => i.quote || '');
      if (!shouldKeepRepair(before, content, qualityOpts(), targetedQuotes)) {
        content = before;
        emit('revise', `替换 ${changed} 处但没有变好（套话 ${beforeSlop}→${afterSlop}），已回滚`);
        break;
      }
      emit('revise', `替换 ${changed} 处并保留（套话 ${beforeSlop}→${afterSlop}）`);
    } catch (err) {
      emit('revise', `返工失败：${(err as Error).message}`);
      break;
    }
    report = inspect(content, qualityOpts());
  }

  // 抽取事实与线索（证据核验）
  let extracted: any = {};
  try {
    extracted = await llm.json<any>(extractPrompt({ ctx, chapterIdx, title: plan.title, content }), {
      purpose: `extract.chapter.${chapterIdx}`,
      system: '只输出 JSON，quote 必须逐字来自正文。',
      mockKind: 'extract',
      mockSeed: `${book.slug}:${chapterIdx}`,
      signal,
    });
  } catch (err) {
    emit('extract', `抽取失败：${(err as Error).message}`);
  }

  const threadEvents = applyThreadEvents(store, book.id, chapterIdx, (extracted.thread_events || []) as ThreadEvent[], content);
  if (threadEvents.rejected.length) {
    emit(
      'extract',
      `拒绝 ${threadEvents.rejected.length} 条无证据的线索事件：${threadEvents.rejected.map((r) => `${r.event?.code}(${r.reason})`).join('；')}`,
    );
  }
  addFacts(store, book.id, chapterIdx, extracted.facts || []);
  addTimeline(store, book.id, chapterIdx, extracted.timeline || []);

  // 人物：回写出场、应用状态变化、抓未登记人名
  touchCharacters(store, book.id, chapterIdx, planCast);
  for (const cu of extracted.character_updates || []) {
    if (!cu?.name) continue;
    upsertCharacter(store, book.id, {
      name: String(cu.name),
      status: cu.status ? String(cu.status) : undefined,
      goal: cu.goal ? String(cu.goal) : undefined,
      notes: cu.note ? String(cu.note) : undefined,
    });
  }
  const suspects = suspectNames(store, book.id, content);
  const autoCast = ensureSuspectCharacters(store, book.id, suspects);
  if (autoCast.length) emit('cast', `已自动补人物卡：${autoCast.join('、')}（请在人物页完善）`);

  // 关系变更（有历史可回溯）
  for (const ru of extracted.relation_updates || []) {
    if (!ru?.from || !ru?.to || !ru?.relation) continue;
    addRelation(store, book.id, {
      from_name: String(ru.from),
      to_name: String(ru.to),
      relation: String(ru.relation),
      chapter_idx: chapterIdx,
      note: String(ru.note || ''),
    });
  }

  // 爆点/钩子：同样要证据
  let plannedHighlights: any[] = [];
  try {
    plannedHighlights = JSON.parse(plan.highlights || '[]');
  } catch {
    plannedHighlights = [];
  }
  const highlightEvents = withPlannedSetups((extracted.highlights || []) as any[], plannedHighlights);
  const hl = applyHighlights(store, book.id, chapterIdx, highlightEvents, content);
  if (hl.rejected.length) emit('pacing', `拒绝 ${hl.rejected.length} 条无证据的爆点：${hl.rejected.map((r) => r.event?.title || r.reason).join('；')}`);
  // 模型没标钩子但结尾确实是钩子（短句、动作/未说完的话）时，补记一条
  let hookApplied = hl.applied.some((h) => h.kind === 'hook');
  if (!hookApplied) {
    const paras = content.split(/\n+/).map((x) => x.trim()).filter(Boolean);
    const last = paras[paras.length - 1] || '';
    const looksHook = last.length >= 8 && countWords(last) <= 90 && !/(知道|明白|意味着|从此|注定|一切都|这一刻)/.test(last);
    if (looksHook) {
      const r = applyHighlights(store, book.id, chapterIdx, [{ kind: 'hook', type: '危机', intensity: 3, title: '章末动作', quote: last }], content);
      if (r.applied.length) {
        hookApplied = true;
        hl.applied.push(r.applied[0]);
        emit('pacing', `结尾未标注钩子，按正文补记：${last.slice(0, 24)}`);
      }
    }
  }
  if (hl.applied.length) emit('pacing', `本章爆点：${hl.applied.map((h) => `${h.kind}/${h.type}·${h.intensity}`).join('、')}`);

  // 期待-兑现：立/兑都要证据；高强爆点要挂在期待上
  const exps = applyExpectationEvents(store, book.id, chapterIdx, (extracted.expectation_events || []) as any[], content);
  if (exps.rejected.length) emit('expect', `拒绝 ${exps.rejected.length} 条无证据的期待事件：${exps.rejected.map((r) => r.event?.code).join('、')}`);
  for (const h of hl.applied) {
    const paysCode = (h as any).pays_code;
    if (!paysCode) continue;
    const open = store.get<{ id: number }>("SELECT id FROM expectations WHERE book_id=? AND code=? AND status='open'", book.id, paysCode);
    if (!open) continue;
    const r = applyExpectationEvents(store, book.id, chapterIdx, [{ code: paysCode, action: 'fulfill', quote: h.quote, note: '由爆点兑现' }], content);
    if (r.applied.length) emit('expect', `期待已兑现：${paysCode}`);
  }
  // 同一章里既立期待又给高强爆点，不算"凭空高潮"
  const plantedThisChapter = exps.applied.some((e) => e.action === 'plant');
  const strongNoSetup = plantedThisChapter ? [] : hl.applied.filter((h) => Number(h.intensity) >= 4 && !(h as any).pays_code);
  if (strongNoSetup.length) emit('expect', `有 ${strongNoSetup.length} 个强度≥4 的爆点没挂期待（读者不知道在为哪口气憋着）`);

  // 一致性：人名/死人说话/时间线
  const consistency = [...castIssues(store, book.id, chapterIdx, content), ...timelineIssues(store, book.id)];
  const blocking = consistency.filter((i) => i.severity === 'block');
  if (suspects.length) {
    emit('cast', `正文里出现未登记人名：${suspects.join('、')}。请到「人物」页补卡，否则后续容易写崩`);
  }
  for (const i of blocking) emit('check', `[${i.type}] 第${i.chapter}章 ${i.message}`);
  setPlanStatus(store, book.id, chapterIdx, 'drafted');

  const summary = String(extracted.summary || '').trim() || content.replace(/\s+/g, '').slice(0, 100);
  // 注意：此时本章还没落库，pacingReport 里看不到它，直接用本章实际记录判断
  const hasHook = hookApplied;
  const maxIntensity = hl.applied.reduce((a, h) => Math.max(a, Number(h.intensity) || 0), 0);
  if (!hasHook) emit('pacing', `第 ${chapterIdx} 章没有章末钩子——按规则这一章不能算过审`);

  const passedReview = (review?.verdict === 'pass' || !review) && hasHook;
  const status = passedReview && report.score >= 70 ? 'reviewed' : 'draft';

  const saved = saveChapter(store, book.id, chapterIdx, {
    title: plan.title,
    content,
    summary,
    status,
    revision: (existing?.revision ?? 0) + (opts.reviseOnly ? 1 : 0),
    volume_id: volumeIdForIndex(store, book.id, chapterIdx),
    checks: {
      report,
      review,
      suspects,
      consistency,
      pacing: { hook: hasHook, maxIntensity, highlights: hl.applied, rejected: hl.rejected },
      expectations: { applied: exps.applied, rejected: exps.rejected, strongNoSetup: strongNoSetup.length },
      structure: (() => {
        const at = stageAt(store, book.id, chapterIdx);
        return at ? { stage: at.stage.name, pct: at.pct } : null;
      })(),
    },
    cost: {
      calls: llm.calls.length,
      promptChars: llm.calls.reduce((a, c) => a + c.promptChars, 0),
      outputChars: llm.calls.reduce((a, c) => a + c.outputChars, 0),
    },
  });

  emit('commit', `第 ${chapterIdx} 章落库：${saved.word_count} 字，状态 ${status}`, {
    idx: chapterIdx,
    words: saved.word_count,
    score: report.score,
  });

  return {
    idx: chapterIdx,
    title: plan.title,
    words: saved.word_count,
    report,
    review,
    threadEvents: { applied: threadEvents.applied, rejected: threadEvents.rejected },
    cost: { calls: llm.calls.length, promptChars: llm.calls.reduce((a, c) => a + c.promptChars, 0), outputChars: llm.calls.reduce((a, c) => a + c.outputChars, 0) },
  };
}



function previousContents(store: Store, bookId: number, idx: number, n = 3): string[] {
  return listChapters(store, bookId)
    .filter((c) => c.idx < idx)
    .slice(-n)
    .map((c) => c.content);
}

export function chapterDetail(store: Store, bookId: number, idx: number) {
  const ch = getChapter(store, bookId, idx);
  const plan = getPlan(store, bookId, idx);
  const facts = store.all('SELECT * FROM facts WHERE book_id=? AND idx=? ORDER BY id', bookId, idx);
  const timeline = store.all('SELECT * FROM timeline WHERE book_id=? AND idx=? ORDER BY id', bookId, idx);
  const threads = store.all<{ code: string; title: string; status: string; planted_idx: number; resolved_idx: number }>(
    'SELECT code,title,status,planted_idx,resolved_idx FROM threads WHERE book_id=? AND (planted_idx=? OR resolved_idx=?)',
    bookId,
    idx,
    idx,
  );
  return { chapter: ch, plan, facts, timeline, threads };
}

export function assertQuote(quote: string, text: string) {
  return quoteExistsInText(quote, text);
}

export type { Chapter, Book };
