/**
 * cap.js PoW 求解器 —— 对真实站点做一次完整流程验证（不触发续期）。
 *
 * 用法: node test_cap_live.mjs [baseUrl]
 * 只做 challenge -> 解 -> redeem，拿到 token 就结束。不提交业务请求。
 */
import { chromium } from 'playwright';
import { solveCap } from './cap-solver.mjs';

const BASE = (process.argv[2] || process.env.ACL_BASE_URL || 'https://aclclouds.com').replace(/\/+$/, '');

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

try {
  console.log(`打开 ${BASE}/auth/login 以读取 cap 配置...`);
  await page.goto(`${BASE}/auth/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const cfg = await page.evaluate(() => {
    const el = document.getElementById('client-bootstrap-data');
    if (!el) return null;
    try {
      const r = JSON.parse(el.textContent)?.siteConfiguration?.recaptcha;
      return r && r.enabled ? { siteKey: r.siteKey, apiEndpoint: r.apiEndpoint } : null;
    } catch {
      return null;
    }
  });

  if (!cfg) {
    console.log('页面未发现 enabled 的 recaptcha 配置，跳过');
    process.exit(0);
  }
  console.log('发现 cap 配置:', JSON.stringify(cfg));

  const t0 = Date.now();
  const token = await solveCap(page, cfg.apiEndpoint, { log: (m) => console.log('  ' + m) });
  console.log(`\n成功拿到 captcha token: ${String(token).slice(0, 60)}...`);
  console.log(`总耗时: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} finally {
  await browser.close();
}
