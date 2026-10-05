import { classifyRenew, classifyUiText, formatTgMessage, fmtDuration } from './renew.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// --- classifyRenew: 续期接口返回判定 ---
const skip = classifyRenew({ status: 400, data: { error: 'renewal_not_available', days_remaining: 1 } });
assert(skip.ok && skip.skip, 'window-closed is ok skip');

const cap = classifyRenew({ status: 403, data: { error: 'captcha_required' } });
assert(!cap.ok && cap.captcha, '403 captcha_required retries');

const ok = classifyRenew({ status: 200, data: { ok: true } });
assert(ok.ok && !ok.skip, '200 is success');

// 真实改版后的成功响应（取自 HAR）
const real = classifyRenew({
  status: 200,
  data: {
    success: true,
    message: 'Serveur renouvelé avec succès.',
    expires_at: '2026-10-08T21:51:26+02:00',
    balance: 0,
  },
});
assert(real.ok && !real.skip, 'real 200 payload is success');

// 真实改版后的 403 响应（取自 HAR）——必须触发验证码路径
const real403 = classifyRenew({
  status: 403,
  data: {
    error: 'captcha_required',
    code: 'captcha_required',
    message: "Confirmez que vous n'êtes pas un robot pour renouveler ce service gratuit.",
  },
});
assert(!real403.ok && real403.captcha, 'real 403 payload triggers captcha path');

// --- classifyUiText: 页面文案判定（兼容法/英） ---
const frRenewed = classifyUiText('Expire dans 4j 12h');
assert(frRenewed.confirmed && frRenewed.remaining === '4j12h', 'FR renewed text with countdown');

const enRenewed = classifyUiText('Expires in 3 days');
assert(enRenewed.confirmed, 'EN renewed text');

// 剩余 1 天属于「未到窗口」，不能被当成续期成功
const tooEarly = classifyUiText('Expire dans 1j');
assert(!tooEarly.confirmed, '1 day left must NOT count as renewed');

const nothing = classifyUiText('Bienvenue sur le dashboard');
assert(!nothing.confirmed && nothing.remaining === null, 'neutral page text');

// --- formatTgMessage: 通知排版（用 HAR 里的真实字段） ---
const SRV = {
  name: 'Mon VPS 8817',
  plan: 'Free',
  spec: '315MB / 0.5 cores / 715MB 磁盘',
  expiresAt: '2026-10-08T21:51:26+02:00', // = 2026-10-09 03:51 (UTC+8)
};

const skipMsg = formatTgMessage({
  failed: false,
  results: [{ ...SRV, ok: true, skip: true, reason: '未到续期窗口' }],
});
assert(skipMsg.includes('📊 状态: ⏭️ 本轮无需续期'), 'skip status line');
assert(/🕒 执行时间: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(UTC\+8\)/.test(skipMsg), 'exec time format');
assert(skipMsg.includes('📦 <b>Mon VPS 8817 · Free</b>'), 'service + plan header');
assert(skipMsg.includes('🧠 规格: 315MB / 0.5 cores / 715MB 磁盘'), 'spec line');
assert(skipMsg.includes('📅 到期时间: 2026-10-09 03:51 (UTC+8)'), 'expiry rendered in UTC+8');
assert(/⏳ 剩余: \d+小时\d+分/.test(skipMsg), 'remaining duration');
assert(/⏳ 下次可续期: \d+小时\d+分后/.test(skipMsg), 'next-renew countdown');
assert(skipMsg.includes('📌 站点限制到期前 24 小时开放续期'), 'skip footer');
assert(!skipMsg.includes('━━'), 'old divider must be gone');

const okMsg = formatTgMessage({
  failed: false,
  results: [{ ...SRV, ok: true, skip: false, reason: '续期成功' }],
});
assert(okMsg.includes('📊 状态: ✅ 续期成功'), 'success status');
assert(okMsg.includes('✅ 已成功延期'), 'success detail line');

const failMsg = formatTgMessage({
  failed: true,
  results: [{ ...SRV, ok: false, skip: false, reason: 'HTTP 403 captcha_required' }],
});
assert(failMsg.includes('📊 状态: ❌ 续期失败'), 'fail status');
assert(failMsg.includes('❌ 失败原因: HTTP 403 captcha_required'), 'fail reason carries no name prefix');

// 多台服务：每台一块
const twoMsg = formatTgMessage({
  failed: false,
  results: [
    { ...SRV, ok: true, skip: true, reason: '未到续期窗口' },
    { ...SRV, name: 'Mon VPS 2', ok: true, skip: true, reason: '未到续期窗口' },
  ],
});
assert(twoMsg.includes('📦 <b>Mon VPS 2'), 'multi-server renders a block per server');

// --- fmtDuration 边界 ---
assert(fmtDuration(0) === '已到期', 'zero -> expired');
assert(fmtDuration(-1000) === '已到期', 'negative -> expired');
assert(fmtDuration(53 * 60000) === '53分', 'sub-hour -> minutes only');
assert(fmtDuration((75 * 60 + 44) * 60000) === '75小时44分', 'hours + minutes');

console.log('ok');
