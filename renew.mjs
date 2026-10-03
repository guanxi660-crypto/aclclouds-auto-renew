#!/usr/bin/env node
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { solveCap } from './cap-solver.mjs';

const BASE = (process.env.ACL_BASE_URL || 'https://aclclouds.com').replace(/\/+$/, '');
const USER = process.env.ACL_USERNAME || process.env.ACL_EMAIL || '';
const PASS = process.env.ACL_PASSWORD || '';
const SERVER_ID = process.env.ACL_SERVER_ID || '';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const AUTH = path.resolve(process.env.ACL_AUTH_STATE || 'auth.json');
const SHOT = path.resolve('shots');

// 全局超时：默认 30s 太长，UI 交互最多等 8s 就够，避免无谓空等。
const DEFAULT_TIMEOUT = Number(process.env.ACL_TIMEOUT_MS || 15000);
const UI_TIMEOUT = Number(process.env.ACL_UI_TIMEOUT_MS || 8000);

// UI 续期按钮候选（按钮命中优先，避免误伤导航链接）
const RENEW_BTN_SEL = [
  'button:has-text("Renouveler")',
  'button:has-text("Renew")',
].join(', ');

fs.mkdirSync(SHOT, { recursive: true });

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function shot(page, name) {
  const p = path.join(SHOT, name);
  await page.screenshot({ path: p, fullPage: true });
  log(`截图 ${name}`);
  return p;
}

/**
 * 返回 locator 中第一个「可见」的元素，找不到返回 null。
 * 原实现用 count()>0 判断存在性，会把隐藏元素算进去，
 * 导致 click() 等可见性 30s 后超时。
 */
async function firstVisible(locator, limit = 12) {
  let n = 0;
  try {
    n = Math.min(await locator.count(), limit);
  } catch {
    return null;
  }
  for (let i = 0; i < n; i++) {
    const el = locator.nth(i);
    const visible = await el.isVisible().catch(() => false);
    if (visible) return el;
  }
  return null;
}

async function sendTgPhoto(chat, token, photoPath, caption) {
  if (!photoPath || !fs.existsSync(photoPath) || fs.statSync(photoPath).size < 100) return;
  try {
    const form = new FormData();
    form.append('chat_id', chat);
    form.append('photo', new Blob([fs.readFileSync(photoPath)], { type: 'image/png' }), path.basename(photoPath));
    if (caption) form.append('caption', caption);
    const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
    if (!r.ok) log(`TG 图片发送失败 ${path.basename(photoPath)}: ${await r.text()}`);
    else log(`TG 图片已发送: ${path.basename(photoPath)}`);
  } catch (e) {
    log(`TG 图片发送异常: ${e.message}`);
  }
}

async function tg(text, { photo = null } = {}) {
  const token = process.env.TG_BOT_TOKEN;
  const chat = process.env.TG_CHAT_ID;
  if (!token || !chat) {
    log('未配置 TG_BOT_TOKEN/TG_CHAT_ID,跳过通知');
    return;
  }
  try {
    const msg = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!msg.ok) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      });
    }
    log('TG 文本已发送');
  } catch (e) {
    log(`TG 发送异常 (非致命): ${e.message}`);
  }

  if (photo) {
    await sendTgPhoto(chat, token, photo);
  }
}

function formatTgMessage({ failed, results = [], errorMsg = '' }) {
  const beijingTime = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const hasRenewed = results.some((r) => r.ok && !r.skip);
  const allSkipped = results.length > 0 && results.every((r) => r.ok && r.skip);

  let title = '✅ <b>【ACLClouds 自动续期成功】</b>';
  let badge = '🎉 服务续期成功';
  if (failed) {
    title = '❌ <b>【ACLClouds 自动续期失败】</b>';
    badge = '⚠️ 续期任务异常';
  } else if (allSkipped) {
    title = '⏳ <b>【ACLClouds 续期检查 - 未到窗口】</b>';
    badge = 'ℹ️ 暂未到可续期时间';
  }

  const lines = [
    title,
    '━━━━━━━━━━━━━━━━━━━━',
    `🕒 <b>执行时间</b>: ${beijingTime} (北京时间)`,
    `👤 <b>当前账号</b>: <code>${escapeHtml(USER || '未设置')}</code>`,
    `📊 <b>任务状态</b>: ${badge}`,
    '━━━━━━━━━━━━━━━━━━━━',
    '<b>服务详情</b>:',
  ];

  if (failed && errorMsg) {
    lines.push(`• 异常原因: ${escapeHtml(errorMsg)}`);
  }

  for (const r of results) {
    const icon = r.ok ? (r.skip ? '⏳' : '✅') : '❌';
    lines.push(`• ${icon} ${escapeHtml(r.text)}`);
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━');
  if (failed) {
    lines.push('⚠️ 请及时查看 GitHub Actions 运行日志与失败截图排查。');
  } else if (hasRenewed) {
    lines.push('✨ 服务已成功延期，将在下次预定周期继续自动守护。');
  } else {
    lines.push('📌 站点限制到期前 1 天才开放续期，下次执行将自动处理。');
  }

  return lines.join('\n');
}

async function api(page, p, method = 'GET', body) {
  return page.evaluate(async ({ p, method, body }) => {
    const token = document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))?.split('=')[1];
    const res = await fetch(p, {
      method,
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        ...(token ? { 'X-XSRF-TOKEN': decodeURIComponent(token) } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text.slice(0, 400); }
    return { status: res.status, data };
  }, { p, method, body });
}

async function loggedIn(page) {
  if (/\/dashboard/i.test(page.url())) return true;
  const r = await api(page, '/api/client/account');
  return r.status === 200 && r.data?.object === 'user';
}

/**
 * 从页面的 bootstrap 数据里读 cap.js 配置。
 * 站点把它注入在 <script id="client-bootstrap-data"> 里：
 *   siteConfiguration.recaptcha = { enabled, siteKey, apiEndpoint }
 * 这是服务端渲染的，无需扒打包后的 JS。
 */
async function readCapConfig(page) {
  const cfg = await page.evaluate(() => {
    const el = document.getElementById('client-bootstrap-data');
    if (!el) return null;
    try {
      const j = JSON.parse(el.textContent);
      const r = j?.siteConfiguration?.recaptcha;
      if (!r || !r.enabled) return null;
      return { siteKey: r.siteKey || '', apiEndpoint: r.apiEndpoint || '' };
    } catch {
      return null;
    }
  });
  if (!cfg || !cfg.apiEndpoint) return null;
  // 兜底：老版本可能只给 siteKey
  if (!cfg.apiEndpoint && cfg.siteKey) {
    cfg.apiEndpoint = `https://cap.aclclouds.com/${cfg.siteKey}/`;
  }
  return cfg;
}

/**
 * 登录时若遇到验证码，尝试用 cap.js 求解。
 * 改版后登录页也挂了 Cap；旧的「点图选词」已从代码中移除，
 * 若站点回退到旧方案，这里会明确报错而不是静默失败。
 */
async function passLoginCaptcha(page) {
  const cfg = await readCapConfig(page);
  if (!cfg) {
    log('登录页未发现 cap.js 配置（可能不需要验证码，或站点已换方案）');
    return false;
  }
  const token = await solveCap(page, cfg.apiEndpoint, { log });
  // 把 token 塞进页面，供登录表单提交时使用
  await page.evaluate((t) => {
    window.__aclCapToken = t;
    const input = document.querySelector(
      'input[name="captcha_token"], input[name="recaptcha_token"], input[name="cap_token"]'
    );
    if (input) input.value = t;
    window.dispatchEvent(new CustomEvent('acl:cap-solved', { detail: { token: t } }));
  }, token);
  log('登录验证码已求解并注入页面');
  return true;
}

async function login(page) {
  log(`登录 ${BASE} as ${USER}`);
  await page.goto(`${BASE}/auth/login`, { waitUntil: 'domcontentloaded' });
  if (await loggedIn(page)) {
    log('已有会话,跳过验证码');
    return;
  }
  if (fs.existsSync(AUTH)) {
    log('会话失效,重新登录');
    fs.unlinkSync(AUTH);
  }
  await page.fill('#username', USER);
  await page.fill('#password', PASS);
  await shot(page, '01-login.png');
  let lastErr = '';
  try {
    await passLoginCaptcha(page);
  } catch (e) {
    lastErr = e.message;
    log(`登录验证码求解失败: ${e.message}`);
  }
  await page.click("button[type='submit']");
  try {
    await page.waitForURL(/\/dashboard/, { timeout: DEFAULT_TIMEOUT + 20000 });
  } catch (e) {
    throw new Error(`提交登录后未进入 dashboard${lastErr ? `（验证码: ${lastErr}）` : ''}`);
  }
  await page.context().storageState({ path: AUTH });
  log(`登录成功,会话写入 ${AUTH}`);
}

function formatRemaining(expiresAt) {
  if (!expiresAt) return null;
  const target = new Date(expiresAt).getTime();
  const diff = target - Date.now();
  if (isNaN(diff)) return null;
  if (diff <= 0) return '已到期';
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const expStr = new Date(target).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${d}天${h}小时 (到期: ${expStr})`;
}

async function discover(page) {
  const servers = [];
  const r = await api(page, '/api/client');
  if (r.status === 200 && Array.isArray(r.data?.data)) {
    for (const item of r.data.data) {
      if (item.object === 'server' && item.attributes) {
        servers.push({
          id: item.attributes.identifier,
          uuid: item.attributes.uuid,
          name: item.attributes.name || item.attributes.identifier,
          expiresAt: item.attributes.expires_at || null,
          canRenew: !!item.attributes.can_renew,
        });
      }
    }
  }

  if (SERVER_ID && !servers.some((s) => s.id === SERVER_ID || s.uuid === SERVER_ID)) {
    servers.push({ id: SERVER_ID, uuid: SERVER_ID, name: SERVER_ID, expiresAt: null, canRenew: false });
  }

  log(`发现服务: ${servers.map((s) => `${s.name}(${s.id}) 到期:${s.expiresAt || '未知'}`).join(', ') || '(无)'}`);
  return servers;
}

function classifyRenew(r) {
  if (r.status === 200) {
    const exp = r.data?.expires_at ? ` (到期: ${r.data.expires_at})` : '';
    return { ok: true, skip: false, captcha: false, text: `续期成功${exp} ${r.data?.message || JSON.stringify(r.data).slice(0, 120)}` };
  }
  if (r.status === 400 && (r.data?.error === 'renewal_not_available' || r.data?.code === 'renewal_not_available')) {
    return { ok: true, skip: true, captcha: false, text: `未到续期窗口 剩余 ${r.data.days_remaining ?? r.data.hours_remaining ?? '?'} 天/小时` };
  }
  const blob = JSON.stringify(r.data);
  if (r.status === 403 && /captcha_required/i.test(blob)) {
    return { ok: false, skip: false, captcha: true, text: 'HTTP 403 captcha_required' };
  }
  return { ok: false, skip: false, captcha: false, text: `HTTP ${r.status} ${blob.slice(0, 180)}` };
}

/**
 * 纯函数：从页面文本判断续期是否成功。抽出来便于单测。
 * 兼容法/英/中三种界面文案。
 */
function classifyUiText(text) {
  const t = String(text || '');
  const m = t.match(/(?:Expire dans|Expires in|到期)\s*([0-9]+\s*(?:j|jours?|d|days?|天)(?:\s*[0-9]+\s*(?:h|heures?|hours?|小时))?)/i);
  const remaining = m ? m[1].replace(/\s+/g, '') : null;
  const confirmed =
    /(?:Expire dans|Expires in)\s*(?:[2-9]|[1-9][0-9]+)\s*(?:j|jours?|d|days?|天)/i.test(t) ||
    /(?:renouvellement|renewal)\s*(?:effectué|réussi|successful|complete|completed)/i.test(t) ||
    /(?:renewed successfully|renewal successful|renewal complete)/i.test(t);
  return { confirmed, remaining };
}

/**
 * UI 续期路径 —— 仅作为 API 失败后的兜底。
 * 关键点：全程 try/catch，任何异常都只返回 null，绝不向上抛，
 * 否则会像旧版那样把整条续期链路带崩。
 */
async function renewViaUi(page, id, name) {
  log('UI 兜底: 打开 /dashboard/projects');
  await page.goto(`${BASE}/dashboard/projects`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  const btn = await firstVisible(page.locator(RENEW_BTN_SEL));
  if (!btn) {
    log('UI 兜底: 页面上没有「可见」的续期按钮,放弃 UI 路径');
    return null;
  }

  log('UI 兜底: 找到可见续期按钮,执行点击...');
  await btn.click({ timeout: UI_TIMEOUT });
  await page.waitForTimeout(1500);

  const dialog = await firstVisible(page.locator("[role='dialog']"));
  if (dialog) {
    log('UI 兜底: 检测到人机验证弹窗,尝试过盾...');
    try {
      const cfg = await readCapConfig(page);
      if (cfg) await solveCap(page, cfg.apiEndpoint, { log });
      await page.waitForTimeout(3000);
    } catch (e) {
      log(`UI 兜底: 弹窗验证码处理异常(忽略): ${e.message}`);
    }
  }

  const bodyText = await page.evaluate(() => document.body.innerText);
  const { confirmed, remaining } = classifyUiText(bodyText);
  if (confirmed) {
    const exp = remaining ? `剩余 ${remaining}` : '成功延期';
    log(`UI 兜底: 续期验证成功: ${exp}`);
    return { id, ok: true, skip: false, captcha: false, text: `${name} (${id}): 续期成功 (${exp})` };
  }
  log('UI 兜底: 未检测到明确的续期成功标识');
  return null;
}

/** API 续期（主路径）：确定性、无 UI 依赖。 */
async function renewViaApi(page, id) {
  const renewPath = `/api/client/servers/${id}/upgrade/renew`;
  let r = await api(page, renewPath, 'POST', {});
  let c = classifyRenew(r);

  if (c.captcha) {
    log('检测到 captcha_required，走 cap.js（PoW）验证码流程...');
    try {
      const cfg = await readCapConfig(page);
      if (!cfg) throw new Error('页面里没找到 recaptcha/cap 配置');
      const token = await solveCap(page, cfg.apiEndpoint, { log });
      log('带 captcha_token 重发续期请求...');
      r = await api(page, renewPath, 'POST', { captcha_token: token });
      c = classifyRenew(r);
    } catch (e) {
      c = { ok: false, skip: false, captcha: false, text: `验证码求解失败: ${e.message}` };
    }
  }
  return c;
}

async function tryRenew(page, server) {
  const id = server.id;
  const name = server.name || id;
  log(`开始检查续期: ${name} (${id})`);

  if (DRY_RUN) return { id, ok: true, skip: true, text: `[DRY_RUN] ${name} (${id}) 跳过实际提交` };

  // 1) API 优先：快、稳、不依赖页面结构
  log('尝试 API 续期接口...');
  let c = await renewViaApi(page, id);

  // 2) API 明确失败时才走 UI 兜底（旧版顺序相反，且 UI 抛错会中断全局）
  if (!c.ok) {
    log(`API 结果不乐观(${c.text}),启用 UI 兜底...`);
    const ui = await renewViaUi(page, id, name).catch((e) => {
      log(`UI 兜底异常(已忽略,不影响判定): ${e.message}`);
      return null;
    });
    if (ui) c = ui;
  }

  let resultText = `${name} (${id}): ${c.text}`;
  const exactRemaining = formatRemaining(server.expiresAt);
  if (c.skip && exactRemaining) {
    resultText = `${name} (${id}): 未到续期窗口，剩余 ${exactRemaining}`;
  }

  log(`续期结果: ${resultText}`);
  return { id, ok: c.ok, skip: c.skip, text: resultText };
}

/** 允许用 CHROME_PATH 指定本地 Chrome；CI 上不设则用 Playwright 自带浏览器。 */
function resolveExecutablePath() {
  const p = process.env.CHROME_PATH;
  return p && fs.existsSync(p) ? p : undefined;
}

async function main() {
  if (!USER || !PASS) throw new Error('缺少 ACL_USERNAME / ACL_PASSWORD');
  const execPath = resolveExecutablePath();
  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    ...(execPath ? { executablePath: execPath } : {}),
  };
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: fs.existsSync(AUTH) ? AUTH : undefined,
  });
  context.setDefaultTimeout(DEFAULT_TIMEOUT);
  context.setDefaultNavigationTimeout(DEFAULT_TIMEOUT + 15000);
  const page = await context.newPage();
  let summary = '';
  let failed = false;
  const results = [];
  try {
    await login(page);
    await shot(page, '03-dashboard.png');

    const servers = await discover(page);
    await shot(page, '04-projects.png');

    for (const server of servers) {
      const res = await tryRenew(page, server);
      results.push(res);
    }

    if (!results.length) {
      failed = true;
      summary = '未找到可续期服务';
    } else {
      summary = results.map((r) => r.text).join('\n');
      failed = results.some((r) => !r.ok);
    }

    if (results.some((r) => r.ok && !r.skip)) {
      await shot(page, '06-result.png');
    }
  } catch (e) {
    failed = true;
    summary = `执行失败: ${e.message}`;
    log(summary);
    try { await shot(page, '99-error.png'); } catch {}
  } finally {
    await browser.close().catch(() => {});
  }

  // 截图仅限续期完成和执行失败
  let photoToSend = null;
  if (failed) {
    const errPic = path.join(SHOT, '99-error.png');
    if (fs.existsSync(errPic)) photoToSend = errPic;
  } else if (results.some((r) => r.ok && !r.skip)) {
    const donePic = path.join(SHOT, '06-result.png');
    if (fs.existsSync(donePic)) photoToSend = donePic;
  }

  const tgMessage = formatTgMessage({
    failed,
    results,
    errorMsg: failed && !results.length ? summary : '',
  });

  await tg(tgMessage, { photo: photoToSend });
  if (failed) process.exit(1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(async (e) => {
    log(e.stack || e.message);
    const failPic = path.join(SHOT, '99-error.png');
    const tgMessage = formatTgMessage({
      failed: true,
      results: [],
      errorMsg: e.message,
    });
    await tg(tgMessage, { photo: fs.existsSync(failPic) ? failPic : null });
    process.exit(1);
  });
}

export { classifyRenew, classifyUiText };
