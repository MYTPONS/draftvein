import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createZuojiaSession } from '../src/integrations/zuojia/session.ts';
import type { ForgeConfig } from '../src/config.ts';

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-zuojia-session-'));
  const cfg: ForgeConfig = {
    dataDir: path.join(home, 'data'),
    lookahead: 2,
    port: 0,
    host: '127.0.0.1',
    llm: {
      provider: 'mock',
      baseUrl: '',
      baseUrls: [],
      chatPath: '/chat/completions',
      apiKey: '',
      model: 'mock',
      temperature: 0,
      maxTokens: 1000,
      timeoutMs: 1000,
      jsonTemperature: 0,
      jsonMaxTokens: 1000,
      disableThinking: false,
      frequencyPenalty: 0,
      presencePenalty: 0,
      topP: 1,
    },
    zuojia: {
      token: '',
      cookie: '',
      serial: '',
      books: {},
      allowPublish: false,
      baseUrl: 'https://pcwrite.example.test',
    },
  };
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const configPath = path.join(home, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ llm: { model: 'keep-me' }, zuojia: { books: { old: 'CB-OLD' } } }, null, 2));
  return { home, cfg, configPath };
}

test('项目内扫码登录成功后更新运行中配置并写回配置文件', async () => {
  const { cfg, configPath } = setup();
  let qrSeen = '';
  const session = createZuojiaSession(cfg, configPath, {
    loginImpl: async (opts) => {
      opts.onQr?.(path.join(cfg.dataDir, 'zuojia-qr.jpg'));
      qrSeen = opts.onQr ? 'yes' : 'no';
      return {
        ok: true,
        qrPath: path.join(cfg.dataDir, 'zuojia-qr.jpg'),
        token: 'pubtoken-new',
        cookie: 'pubtoken=pubtoken-new; ywkey=k',
        cookies: [{ name: 'pubtoken', value: 'pubtoken-new', domain: '.yuewen.com' }],
      };
    },
    validateImpl: async () => ({ nickname: '测试作者' }),
  });

  session.start();
  await session.wait();
  const state = session.status();
  assert.equal(qrSeen, 'yes');
  assert.equal(state.status, 'connected');
  assert.equal(state.me?.nickname, '测试作者');
  assert.equal(cfg.zuojia.token, 'pubtoken-new');
  assert.match(cfg.zuojia.cookie, /ywkey=k/);

  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(saved.llm.model, 'keep-me');
  assert.equal(saved.zuojia.token, 'pubtoken-new');
  assert.equal(saved.zuojia.cookie, 'pubtoken=pubtoken-new; ywkey=k');
  assert.equal(saved.zuojia.books.old, 'CB-OLD');
});

test('绑定远端作品写入项目配置且不改其它字段', () => {
  const { cfg, configPath } = setup();
  const session = createZuojiaSession(cfg, configPath);
  session.bindBook('book-wp0l', 'CB-123');
  assert.equal(cfg.zuojia.books['book-wp0l'], 'CB-123');
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(saved.zuojia.books['book-wp0l'], 'CB-123');
  assert.equal(saved.zuojia.books.old, 'CB-OLD');
  assert.equal(saved.llm.model, 'keep-me');
});

test('登录失败保留可读状态，不把旧 token 清空', async () => {
  const { cfg, configPath } = setup();
  cfg.zuojia.token = 'old-token';
  cfg.zuojia.cookie = 'old-cookie';
  const session = createZuojiaSession(cfg, configPath, {
    loginImpl: async () => ({ ok: false, qrPath: path.join(cfg.dataDir, 'zuojia-qr.jpg'), token: '', cookie: '', cookies: [] }),
  });
  session.start();
  await session.wait();
  assert.equal(session.status().status, 'failed');
  assert.match(session.status().error || '', /扫码|登录/);
  assert.equal(cfg.zuojia.token, 'old-token');
});

test('扫码拿到新 token 但远端校验失败时，不能覆盖旧配置', async () => {
  const { cfg, configPath } = setup();
  cfg.zuojia.token = 'old-token';
  cfg.zuojia.cookie = 'old-cookie';
  fs.writeFileSync(configPath, JSON.stringify({ zuojia: { token: 'old-token', cookie: 'old-cookie' } }, null, 2));
  const session = createZuojiaSession(cfg, configPath, {
    loginImpl: async () => ({ ok: true, qrPath: path.join(cfg.dataDir, 'zuojia-qr.jpg'), token: 'new-token', cookie: 'new-cookie', cookies: [] }),
    validateImpl: async () => {
      throw new Error('登录校验异常，请重新登录');
    },
  });
  session.start();
  await session.wait();
  assert.equal(session.status().status, 'failed');
  assert.match(session.status().error || '', /校验异常|重新登录/);
  assert.equal(cfg.zuojia.token, 'old-token');
  assert.equal(cfg.zuojia.cookie, 'old-cookie');
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(saved.zuojia.token, 'old-token');
  assert.equal(saved.zuojia.cookie, 'old-cookie');
});
