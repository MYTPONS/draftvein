import fs from 'node:fs';
import path from 'node:path';
import type { ForgeConfig } from '../../config.ts';
import { browserLogin, type LoginResult } from './login.ts';
import { makeClient } from './push.ts';

export type ZuojiaLoginStatus = 'idle' | 'starting' | 'waiting_scan' | 'connected' | 'failed';

export interface ZuojiaLoginState {
  status: ZuojiaLoginStatus;
  qrPath: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  me?: any;
}

type LoginOptions = Parameters<typeof browserLogin>[0];
type LoginImpl = (opts: LoginOptions) => Promise<LoginResult>;
type ValidateImpl = () => Promise<any>;

export interface ZuojiaSession {
  start: () => ZuojiaLoginState;
  wait: () => Promise<void>;
  status: () => ZuojiaLoginState;
  bindBook: (bookSlug: string, cbid: string) => void;
  logout: () => void;
}

export function createZuojiaSession(
  cfg: ForgeConfig,
  configPath: string,
  deps: { loginImpl?: LoginImpl; validateImpl?: ValidateImpl } = {},
): ZuojiaSession {
  const qrPath = path.join(cfg.dataDir, 'zuojia-qr.jpg');
  let state: ZuojiaLoginState = { status: 'idle', qrPath };
  let job: Promise<void> | null = null;

  const persist = () => {
    let file: any = {};
    try {
      file = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      file = {};
    }
    file.zuojia = {
      ...(file.zuojia || {}),
      token: cfg.zuojia.token,
      cookie: cfg.zuojia.cookie,
      books: { ...(file.zuojia?.books || {}), ...cfg.zuojia.books },
      allowPublish: cfg.zuojia.allowPublish,
    };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(file, null, 2));
    fs.chmodSync(configPath, 0o600);
  };

  const start = () => {
    if (job) return state;
    state = { status: 'starting', qrPath, startedAt: new Date().toISOString() };
    job = (async () => {
      try {
        const loginImpl = deps.loginImpl ?? browserLogin;
        const result = await loginImpl({
          timeoutSec: 300,
          qrPath,
          onQr: (file) => {
            state = { ...state, status: 'waiting_scan', qrPath: file };
          },
        });
        if (!result.ok) throw new Error('扫码登录超时或未拿到登录态，请重新生成二维码');
        const previousToken = cfg.zuojia.token;
        const previousCookie = cfg.zuojia.cookie;
        cfg.zuojia.token = result.token;
        cfg.zuojia.cookie = result.cookie;
        let me: any;
        try {
          const validate = deps.validateImpl ?? (() => makeClient(cfg).me());
          me = await validate();
        } catch (err) {
          cfg.zuojia.token = previousToken;
          cfg.zuojia.cookie = previousCookie;
          throw err;
        }
        persist();
        state = { ...state, status: 'connected', qrPath: result.qrPath, me, finishedAt: new Date().toISOString() };
      } catch (err) {
        state = { ...state, status: 'failed', error: (err as Error).message, finishedAt: new Date().toISOString() };
      } finally {
        job = null;
      }
    })();
    return state;
  };

  return {
    start,
    wait: () => job ?? Promise.resolve(),
    status: () => ({ ...state }),
    bindBook: (bookSlug, cbid) => {
      const slug = String(bookSlug || '').trim();
      const id = String(cbid || '').trim();
      if (!slug || !id) throw new Error('缺少本地书 slug 或远端 CBID');
      cfg.zuojia.books[slug] = id;
      persist();
    },
    logout: () => {
      cfg.zuojia.token = '';
      cfg.zuojia.cookie = '';
      persist();
      state = { status: 'idle', qrPath };
    },
  };
}

export function resolveConfigPath(cfg: ForgeConfig): string {
  return process.env.DRAFTVEIN_CONFIG || path.join(process.env.DRAFTVEIN_HOME || path.dirname(cfg.dataDir), 'config.json');
}
