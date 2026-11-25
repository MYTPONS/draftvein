import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server/index.ts';
import type { ForgeConfig } from '../src/config.ts';

function config(home: string): ForgeConfig {
  return {
    dataDir: path.join(home, 'data'),
    lookahead: 2,
    port: 0,
    host: '127.0.0.1',
    llm: {
      provider: 'mock', baseUrl: '', baseUrls: [], chatPath: '/chat/completions', apiKey: '', model: 'mock', temperature: 0,
      maxTokens: 1000, timeoutMs: 1000, jsonTemperature: 0, jsonMaxTokens: 1000, disableThinking: false,
      frequencyPenalty: 0, presencePenalty: 0, topP: 1,
    },
    zuojia: { token: '', cookie: '', serial: '', books: {}, allowPublish: false, baseUrl: 'https://pcwrite.example.test' },
  };
}

test('工作台 HTTP API 内可扫码登录、返回二维码并绑定远端作品', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-zuojia-http-'));
  const cfg = config(home);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const configPath = path.join(home, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ zuojia: {} }, null, 2));
  const qr = path.join(cfg.dataDir, 'zuojia-qr.jpg');
  fs.writeFileSync(qr, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  const h = createServer({
    cfg,
    configPath,
    zuojiaLoginImpl: async (opts) => {
      opts.onQr?.(qr);
      return { ok: true, qrPath: qr, token: 'pubtoken-http', cookie: 'pubtoken=pubtoken-http', cookies: [] };
    },
    zuojiaValidateImpl: async () => ({ nickname: 'HTTP 作者' }),
  });
  await new Promise<void>((resolve) => h.server.listen(0, '127.0.0.1', () => resolve()));
  const address = h.server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const created = await (
      await fetch(`${base}/api/books`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '测试书' }) })
    ).json();
    const started = await fetch(`${base}/api/zuojia/login`, { method: 'POST' });
    assert.equal(started.status, 202);

    let state: any = {};
    for (let i = 0; i < 30; i++) {
      state = await (await fetch(`${base}/api/zuojia/login`)).json();
      if (state.status === 'connected' || state.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(state.status, 'connected');
    assert.equal(state.me.nickname, 'HTTP 作者');

    const qrRes = await fetch(`${base}/api/zuojia/qr`);
    assert.equal(qrRes.status, 200);
    assert.match(qrRes.headers.get('content-type') || '', /image\/jpeg/);

    const bound = await (
      await fetch(`${base}/api/books/${created.id}/zuojia/bind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cbid: 'CB-HTTP' }),
      })
    ).json();
    assert.equal(bound.binding, 'CB-HTTP');

    const status = await (await fetch(`${base}/api/books/${created.id}/zuojia`)).json();
    assert.equal(status.connected, true);
    assert.equal(status.binding, 'CB-HTTP');
    assert.equal(status.canLogin, true);
  } finally {
    await h.close();
  }
});

test('工作台创建远端作品后自动绑定当前书，并返回可编辑站点与分类', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-zuojia-create-http-'));
  const cfg = config(home);
  cfg.zuojia.token = 'pubtoken-create';
  cfg.zuojia.cookie = 'pubtoken=pubtoken-create';
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const configPath = path.join(home, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ zuojia: { token: cfg.zuojia.token, cookie: cfg.zuojia.cookie, books: {} } }, null, 2));
  const createdInputs: any[] = [];
  const fakeClient = {
    me: async () => ({ nickname: '建书作者' }),
    books: async () => [],
    sites: async () => [
      { site: 1, name: 'QQ阅读-男生', platform: 'QQ阅读', sexSite: '男生', freeType: 1 },
      { site: 2, name: 'QQ阅读-女生', platform: 'QQ阅读', sexSite: '女生', freeType: 2 },
    ],
    newNovelInfo: async (site: number) => [
      {
        categoryid: '20019',
        categoryname: '悬疑',
        categorydesc: '悬疑分类',
        subcategories: [
          { subcategoryid: '20020', subcategoryname: '社会悬疑', subcategorydesc: '' },
          { subcategoryid: '20021', subcategoryname: '推理', subcategorydesc: '' },
        ],
        site,
      },
    ],
    novelGroups: async () => ({ lastNovelGroup: '8', groups: [{ novelgroup: '8', novelgroupname: '第六编辑组' }] }),
    createNovel: async (input: any) => {
      createdInputs.push(input);
      return { cbid: 'CB-CREATED', coverurl: 'cover.jpg', words: 0 };
    },
  };

  const h = createServer({ cfg, configPath, zuojiaClientFactory: () => fakeClient as any });
  await new Promise<void>((resolve) => h.server.listen(0, '127.0.0.1', () => resolve()));
  const address = h.server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const created = await (
      await fetch(`${base}/api/books`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '雾里来信' }) })
    ).json();

    const optionsRes = await fetch(`${base}/api/zuojia/create-options?site=1`);
    assert.equal(optionsRes.status, 200);
    const options = await optionsRes.json();
    assert.equal(options.sites.length, 2);
    assert.equal(options.selectedSite, 1);
    assert.equal(options.categories[0].categoryid, '20019');

    const response = await fetch(`${base}/api/books/${created.id}/zuojia/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '雾里来信', site: 1, intro: '一封没有寄件人的信。' }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.cbid, 'CB-CREATED');
    assert.equal(result.binding, 'CB-CREATED');
    assert.equal(createdInputs[0].categoryid, '20019');
    assert.equal(createdInputs[0].subcategoryid, '20020');
    assert.equal(createdInputs[0].novelgroup, '8');

    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(saved.zuojia.books[created.slug], 'CB-CREATED');
    assert.equal(saved.zuojia.token, 'pubtoken-create');

    const status = await (await fetch(`${base}/api/books/${created.id}/zuojia`)).json();
    assert.equal(status.binding, 'CB-CREATED');
  } finally {
    await h.close();
  }
});

test('远端创建失败时不写绑定', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-zuojia-create-fail-'));
  const cfg = config(home);
  cfg.zuojia.token = 'pubtoken-create';
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const configPath = path.join(home, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ zuojia: { token: cfg.zuojia.token, books: {} } }, null, 2));
  const fakeClient = {
    me: async () => ({ nickname: '建书作者' }),
    books: async () => [],
    sites: async () => [{ site: 1, name: 'QQ阅读-男生', platform: 'QQ阅读', sexSite: '男生', freeType: 1 }],
    newNovelInfo: async () => [
      { categoryid: '20019', categoryname: '悬疑', categorydesc: '', subcategories: [{ subcategoryid: '20020', subcategoryname: '社会悬疑', subcategorydesc: '' }] },
    ],
    novelGroups: async () => ({ lastNovelGroup: '8', groups: [{ novelgroup: '8', novelgroupname: '第六编辑组' }] }),
    createNovel: async () => {
      throw new Error('书名已存在');
    },
  };

  const h = createServer({ cfg, configPath, zuojiaClientFactory: () => fakeClient as any });
  await new Promise<void>((resolve) => h.server.listen(0, '127.0.0.1', () => resolve()));
  const address = h.server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const created = await (
      await fetch(`${base}/api/books`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '失败测试' }) })
    ).json();
    const response = await fetch(`${base}/api/books/${created.id}/zuojia/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '失败测试', site: 1, categoryid: '20019', subcategoryid: '20020' }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /书名已存在/);
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(saved.zuojia.books[created.slug], undefined);
  } finally {
    await h.close();
  }
});

