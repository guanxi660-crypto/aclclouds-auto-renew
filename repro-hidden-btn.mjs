/**
 * 复现 2026-09-30 线上失败场景：
 * DOM 里先出现一个「隐藏」的 Renew 按钮，后面才是「可见」的按钮。
 *
 * 旧逻辑 renewBtn.count() > 0 会命中隐藏按钮 → click() 等可见性 30s 超时 → 抛错中断全局。
 * 新逻辑 firstVisible() 会跳过隐藏的，拿到可见的那个。
 */
import { chromium } from 'playwright';

const HTML = `<!doctype html><html><body>
  <button class="client-btn client-btn--secondary client-btn--sm" style="display:none">Renouveler</button>
  <button id="real" class="client-btn client-btn--primary client-btn--sm">Renouveler</button>
</body></html>`;

const RENEW_BTN_SEL = 'button:has-text("Renouveler"), button:has-text("Renew")';

// —— 旧逻辑（复现）——
function oldPick(page) {
  return page.locator(RENEW_BTN_SEL).first();
}

// —— 新逻辑（待验证）——
async function firstVisible(locator, limit = 12) {
  const n = Math.min(await locator.count(), limit);
  for (let i = 0; i < n; i++) {
    const el = locator.nth(i);
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(HTML);

const total = await page.locator(RENEW_BTN_SEL).count();
console.log(`匹配到的按钮总数: ${total}`);

// 旧逻辑：first() 拿到的是隐藏按钮
const oldEl = oldPick(page);
console.log(`旧逻辑 first() 可见性: ${await oldEl.isVisible()}  ← 就是它导致 30s 超时`);

// 旧逻辑判断"有按钮"
const oldHasBtn = total > 0;
console.log(`旧逻辑 hasBtn(count>0) = ${oldHasBtn}  (误判为有可用按钮)`);

// 新逻辑
const newEl = await firstVisible(page.locator(RENEW_BTN_SEL));
console.log(`新逻辑 firstVisible() 命中: ${newEl ? await newEl.getAttribute('id') : 'null'}`);

// 验证：新逻辑拿到的确实是可见的那个，且能点
if (!newEl) throw new Error('FAIL: firstVisible 未找到可见按钮');
if ((await newEl.getAttribute('id')) !== 'real') throw new Error('FAIL: 命中了错误的按钮');
await newEl.click({ timeout: 3000 });
console.log('新逻辑 click() 成功，未超时 ✓');

// 边界：只有隐藏按钮时必须快速返回 null，而不是挂 30s
await page.setContent('<button style="display:none">Renouveler</button>');
const t0 = Date.now();
const none = await firstVisible(page.locator(RENEW_BTN_SEL));
const cost = Date.now() - t0;
if (none !== null) throw new Error('FAIL: 只有隐藏按钮时应返回 null');
console.log(`只有隐藏按钮时返回 null，耗时 ${cost}ms（旧逻辑会空等 30000ms）✓`);

await browser.close();
console.log('\nALL PASS');
