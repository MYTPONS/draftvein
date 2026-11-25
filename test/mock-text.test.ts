import test from 'node:test';
import assert from 'node:assert/strict';
import { Llm } from '../src/llm/client.ts';
import { inspect } from '../src/engine/quality.ts';

function splitSentences(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (const ch of text) {
    cur += ch;
    if (ch === '“') inQuote = true;
    else if (ch === '”') inQuote = false;
    else if (!inQuote && '。！？'.includes(ch)) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const cfg = { provider: 'mock' as const, baseUrl: '', apiKey: '', model: 'mock', temperature: 0, jsonTemperature: 0, maxTokens: 8000, timeoutMs: 2000 };

test('mock 正文：不重复、引号配对、对白够、套话为 0', async () => {
  const llm = new Llm(cfg);
  const scenes: string[] = [];
  for (let ch = 1; ch <= 4; ch++) {
    for (let sc = 1; sc <= 3; sc++) {
      scenes.push(await llm.text(`写第${ch}章第${sc}个场景`, { purpose: 'd', mockKind: 'draft', mockSeed: `mkbook:${ch}:${sc}` }));
    }
  }
  const allSentences: string[] = [];
  for (const t of scenes) {
    assert.equal((t.match(/“/g) || []).length, (t.match(/”/g) || []).length, '引号必须配对');
    for (const s of splitSentences(t).filter((x) => x.length >= 8)) {
      assert.ok(!s.startsWith('”'), `不该有以右引号开头的碎句：${s}`);
      allSentences.push(s.replace(/\s+/g, ''));
    }
  }
  const dupRate = 1 - new Set(allSentences).size / allSentences.length;
  assert.ok(dupRate < 0.05, `跨场景重复率过高：${(dupRate * 100).toFixed(1)}%`);

  const sample = scenes[0];
  const r = inspect(sample, { targetWords: 800 });
  assert.equal(r.stats.bannedHits, 0, '套话应为 0');
  assert.ok(r.stats.dialogueRatio >= 0.08, `对白占比过低：${r.stats.dialogueRatio}`);
  assert.ok(r.words > 500, `单场字数太少：${r.words}`);
});
