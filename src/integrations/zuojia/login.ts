/**
 * 作家助手原生登录：不安装客户端，用浏览器扫码登录阅文作家专区，
 * 抓 cookie（pubtoken/ywkey）写进项目配置，之后直接调 pcwrite 接口。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOGIN_URL = 'https://write.qq.com/portal/login';
function resolveFirefox(playwrightFirefox?: { executablePath?: () => string }): string {
  const candidates: string[] = [];
  for (const p of [process.env.ZUOJIA_FIREFOX, process.env.BROWSER_PATH]) if (p) candidates.push(p);
  try {
    const managed = playwrightFirefox?.executablePath?.();
    if (managed) candidates.push(managed);
  } catch {
    /* playwright 未安装浏览器时继续找系统候选 */
  }
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    for (const name of fs.readdirSync(cache).filter((x) => /^firefox-/.test(x)).sort().reverse()) {
      candidates.push(path.join(cache, name, 'firefox', 'firefox'));
    }
  } catch {}
  candidates.push('/usr/lib/firefox/firefox');
  const found = candidates.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
  if (!found) throw new Error('找不到可用于扫码登录的 Firefox；先运行 node node_modules/playwright-core/cli.js install firefox，或设置 ZUOJIA_FIREFOX');
  return found;
}

export interface LoginResult {
  ok: boolean;
  qrPath: string;
  token: string;
  cookie: string;
  cookies: { name: string; value: string; domain: string }[];
}

export function loginSessionFromCookies(cookies: { name: string; value: string; domain: string }[]) {
  const token = cookies.find((c) => c.name === 'pubtoken')?.value || '';
  const byName = new Map<string, string>();
  for (const c of cookies) byName.set(c.name, c.value);
  return {
    ok: Boolean(token),
    token,
    cookie: [...byName].map(([name, value]) => `${name}=${value}`).join('; '),
  };
}

export async function browserLogin(opts: {
  timeoutSec?: number;
  qrPath?: string;
  headless?: boolean;
  user?: string;
  pass?: string;
  onQr?: (qrPath: string) => void;
} = {}): Promise<LoginResult> {
  const timeoutSec = opts.timeoutSec ?? 300;
  let currentQr = opts.qrPath || path.join(os.homedir(), '.novel-forge', 'zuojia-qr.png');
  const qrPath = currentQr;
  fs.mkdirSync(path.dirname(qrPath), { recursive: true });
  const { firefox } = await import('playwright-core');
  const executablePath = resolveFirefox(firefox);
  const env = { ...process.env };
  if (process.env.ZUOJIA_LD_LIBRARY_PATH) env.LD_LIBRARY_PATH = process.env.ZUOJIA_LD_LIBRARY_PATH;
  const browser = await firefox.launch({
    executablePath,
    headless: opts.headless ?? true,
    env,
    firefoxUserPrefs: { 'security.sandbox.content.level': 0 },
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3500);

  // 账号密码登录（可选）
  if (opts.user && opts.pass) {
    try {
      await page.fill('input[placeholder*="手机"], input[placeholder*="邮箱"], input[placeholder*="用户名"]', opts.user);
      await page.fill('input[type="password"]', opts.pass);
      await page.click('button:has-text("登录")');
      await page.waitForTimeout(4000);
    } catch {
      /* 走扫码 */
    }
  }

  // 切到微信登录 → 点「立即登录」→ 截二维码（多做几次，登录框加载有抖动）
  const passport = page.frames().find((f) => /passport\.yuewen\.com/.test(f.url()));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const pf = page.frames().find((f) => /passport\.yuewen\.com/.test(f.url())) || passport;
      if (pf) {
        const tab = pf.getByText('微信登录', { exact: true }).first();
        if ((await tab.count()) > 0) await tab.click({ timeout: 5000 });
        await page.waitForTimeout(1200);
        const go = pf.getByText('立即登录', { exact: true }).first();
        if ((await go.count()) > 0) await go.click({ timeout: 5000 });
        await page.waitForTimeout(3000);
      }
    } catch {
      /* 继续试 */
    }
    const hasQr = page.frames().some((f) => /open\.weixin\.qq\.com/.test(f.url()));
    if (hasQr) break;
  }

  // 微信二维码是 open.weixin.qq.com/connect/qrcode/<uuid> 的图，直接抓图比截 iframe 稳
  let shot = false;
  try {
    const wf = page.frames().find((f) => /open\.weixin\.qq\.com/.test(f.url()));
    if (wf) {
      const src = await wf.evaluate(() => {
        const img = document.querySelector('img[src*="/connect/qrcode/"]');
        return img ? (img as HTMLImageElement).getAttribute('src') : '';
      });
      if (src) {
        const url = src.startsWith('http') ? src : `https://open.weixin.qq.com${src}`;
        const res = await fetch(url);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          // 微信返回的是 JPEG，扩展名要对上，否则图片查看器不认
          const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50;
          const isJpg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
          let out = qrPath;
          if (isJpg && /\.png$/i.test(out)) out = out.replace(/\.png$/i, '.jpg');
          if (isPng && /\.jpe?g$/i.test(out)) out = out.replace(/\.jpe?g$/i, '.png');
          fs.writeFileSync(out, buf);
          currentQr = out;
          shot = true;
          opts.onQr?.(out);
        }
      }
    }
  } catch {
    /* fallback */
  }
  try {
    const frameEl = page.locator('iframe[src*="open.weixin.qq.com"]').first();
    if (!shot && (await frameEl.count()) > 0) {
      await frameEl.screenshot({ path: qrPath });
      shot = true;
      opts.onQr?.(qrPath);
    }
  } catch {
    /* fallback */
  }
  if (!shot) {
    for (const f of page.frames()) {
      if (!/open\.weixin\.qq\.com/.test(f.url())) continue;
      try {
        const img = f.locator('img').first();
        if (await img.count()) {
          await img.screenshot({ path: qrPath });
          shot = true;
          opts.onQr?.(qrPath);
          break;
        }
      } catch {
        /* ignore */
      }
    }
  }
  if (!shot) await page.screenshot({ path: qrPath });

  const deadline = Date.now() + timeoutSec * 1000;
  let cookies: { name: string; value: string; domain: string }[] = [];
  let exchangedPassport = false;
  while (Date.now() < deadline) {
    cookies = (await ctx.cookies()).map((c) => ({ name: c.name, value: c.value, domain: c.domain }));
    const hasPubtoken = cookies.some((c) => c.name === 'pubtoken');
    const hasYwkey = cookies.some((c) => c.name === 'ywkey');
    if (hasPubtoken) break;
    // 扫码成功后先拿到的是 passport 的 ywkey；作家专区登录页会再换取 pubtoken。
    // 不能把 ywkey 冒充 pubtoken，也不能因此提前关闭浏览器。
    if (hasYwkey && !exchangedPassport) {
      exchangedPassport = true;
      try {
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(5000);
      } catch {
        /* 继续等 cookie */
      }
      continue;
    }
    await page.waitForTimeout(2500);
  }
  await browser.close().catch(() => {});
  const session = loginSessionFromCookies(cookies);
  return { ok: session.ok, qrPath: currentQr, token: session.token, cookie: session.cookie, cookies };
}

/** 把登录结果写进项目 config.json（保留其它字段） */
export function saveLoginToConfig(cfgPath: string, result: LoginResult) {
  let file: any = {};
  try {
    file = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    file = {};
  }
  if (!result.ok || !result.token) throw new Error('登录结果没有 pubtoken，不能写入作家助手配置');
  file.zuojia = { ...(file.zuojia || {}), token: result.token, cookie: result.cookie, allowPublish: file.zuojia?.allowPublish ?? false };
  fs.writeFileSync(cfgPath, JSON.stringify(file, null, 2));
  fs.chmodSync(cfgPath, 0o600);
}
