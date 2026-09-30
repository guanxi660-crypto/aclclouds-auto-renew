import { score, ocrScore, classifyRenew, classifyUiText } from './renew.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(score('ACLCiouds', 'ACLClouds') >= 75, '1-letter OCR miss should still score');
assert(ocrScore('ACLCiouds', 'ACLClouds', 'ACLClouds') >= 80, 'vocab-corrected ACLCiouds must pass threshold');
assert(ocrScore('Serveur', 'Serveur', 'Serveur') === 100, 'exact Serveur');
assert(ocrScore('Semeur', 'Serveur', 'ACLClouds') < 80, 'wrong tile must not match prompt');

const skip = classifyRenew({ status: 400, data: { error: 'renewal_not_available', days_remaining: 1 } });
assert(skip.ok && skip.skip, 'window-closed is ok skip');

const cap = classifyRenew({ status: 403, data: { error: 'captcha_required' } });
assert(!cap.ok && cap.captcha, '403 captcha_required retries');

const ok = classifyRenew({ status: 200, data: { ok: true } });
assert(ok.ok && !ok.skip, '200 is success');

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
