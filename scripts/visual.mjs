#!/usr/bin/env node
/** Dual-viewport screenshots + console collection: node scripts/visual.mjs <url> <prefix> */
import fs from 'node:fs';
import path from 'node:path';
import { firefox } from 'playwright-core';

const url = process.argv[2] || 'http://127.0.0.1:4260';
const prefix = process.argv[3] || 'shot';
const outDir = path.resolve('shots');
fs.mkdirSync(outDir, { recursive: true });

const cacheRoot = path.join(process.env.HOME || '', '.cache', 'ms-playwright');
const cachedBrowsers = fs.existsSync(cacheRoot)
  ? fs.readdirSync(cacheRoot).filter((x) => /^firefox-/.test(x)).sort().reverse().map((x) => path.join(cacheRoot, x, 'firefox', 'firefox'))
  : [];
let managedBrowser = '';
try {
  managedBrowser = firefox.executablePath();
} catch {}
const candidates = [
  process.env.BROWSER_PATH,
  managedBrowser,
  ...cachedBrowsers,
  '/usr/lib/firefox/firefox',
].filter(Boolean);
const executablePath = candidates.find((p) => fs.existsSync(p));
if (!executablePath) throw new Error('找不到 Firefox：请设置 BROWSER_PATH，或先安装 Playwright Firefox');

const browser = await firefox.launch({
  executablePath,
  env: { ...process.env },
  firefoxUserPrefs: { 'security.sandbox.content.level': 0 },
});

async function shot(name, viewport, actions) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(url, { waitUntil: 'networkidle' });
  if (actions) await actions(page);
  await page.waitForTimeout(400);
  const file = path.join(outDir, `${prefix}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  console.log(JSON.stringify({ name, file, viewport, errors, horizontalOverflow: overflow }));
  await ctx.close();
  return { errors, overflow };
}

const desktop = await shot('desktop', { width: 1440, height: 900 });
const mobile = await shot('mobile', { width: 390, height: 844 });

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'networkidle' });
for (const view of ['outline', 'structure', 'cast', 'pacing', 'check', 'threads', 'bible', 'push']) {
  await page.click(`.tab[data-view="${view}"]`);
  await page.waitForTimeout(350);
  const file = path.join(outDir, `${prefix}-${view}.png`);
  await page.screenshot({ path: file });
  console.log(JSON.stringify({ name: view, file }));
}
await ctx.close();
await browser.close();

if (desktop.errors.length || mobile.errors.length) {
  console.error('CONSOLE ERRORS:', [...desktop.errors, ...mobile.errors]);
  process.exit(1);
}
console.log('visual OK');
