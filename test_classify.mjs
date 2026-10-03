import { classifyRenew, classifyUiText } from './renew.mjs';

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

console.log('ok');
