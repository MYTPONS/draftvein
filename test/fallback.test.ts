import test from 'node:test';
import assert from 'node:assert/strict';
import { Llm } from '../src/llm/client.ts';

test('多端点：第一个失败会自动切到下一个', async () => {
  const calls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    calls.push(String(url));
    if (String(url).includes('bad.example')) {
      return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '好' } }] }), { status: 200 });
  }) as any;
  try {
    const llm = new Llm({
      provider: 'openai', baseUrl: 'https://bad.example/v1', baseUrls: ['https://ok.example/v1'],
      apiKey: 'k', model: 'm', temperature: 0.7, jsonTemperature: 0.3, maxTokens: 64, timeoutMs: 5000,
      frequencyPenalty: 0, presencePenalty: 0, topP: 1, chatPath: '/chat/completions',
    });
    const out = await llm.text('hi', { purpose: 't' });
    assert.equal(out, '好');
    assert.ok(calls[0].includes('bad.example'), calls.join(','));
    assert.ok(calls.some((u) => u.includes('ok.example')), calls.join(','));
  } finally {
    globalThis.fetch = orig;
  }
});

test('402 限流会等一会再重试（读 retry after）', async () => {
  const orig = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    if (n === 1) return new Response(JSON.stringify({ error: 'FREE_LIMIT', message: 'Retry after 1s' }), { status: 402 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  }) as any;
  try {
    const llm = new Llm({
      provider: 'openai', baseUrl: 'https://x.example', baseUrls: [], apiKey: 'k', model: 'm',
      temperature: 0.7, jsonTemperature: 0.3, maxTokens: 64, timeoutMs: 5000,
      frequencyPenalty: 0, presencePenalty: 0, topP: 1, chatPath: '',
    });
    const t0 = Date.now();
    const out = await llm.text('hi', { purpose: 't' });
    assert.equal(out, 'ok');
    assert.ok(Date.now() - t0 >= 800, '应当等待 retry-after');
    assert.equal(n, 2);
  } finally {
    globalThis.fetch = orig;
  }
});
