/**
 * cap.js（PoW）验证码求解 —— 适配 ACLClouds 2026-10 改版。
 *
 * 站点把验证码从「点图选词」换成了 Cap（https://github.com/tiagozip/cap）：
 *  1) POST {apiEndpoint}challenge  -> { token, challenges:[{protocol,payload}] }
 *  2) 对每个 hashwx 挑战求 nonce，使 hashwx(seed, nonce) <= U64_MAX/d
 *  3) POST {apiEndpoint}redeem     -> { success, token }
 *  4) 带着该 token 重发业务请求（body: {captcha_token}）
 *
 * 求解核心来自官方 core/src/hashwx.js（vendored 到 vendor/cap/），
 * wasm 以 base64 内嵌，**不依赖 jsDelivr**，离线可跑。
 *
 * 并行策略：用 worker_threads 真正多核并行。
 * 单线程里写多个分片只是串行执行，拿不到加速 —— wasm 求解会阻塞事件循环。
 */
import { Worker } from 'node:worker_threads';
import os from 'node:os';

/** 默认并发 worker 数（求解是纯 CPU 密集，按核数开）。 */
export function defaultWorkers() {
  const n = Number(process.env.CAP_POW_WORKERS);
  if (Number.isInteger(n) && n >= 1) return n;
  try {
    return Math.max(1, Math.min(os.cpus().length, 4));
  } catch {
    return 2;
  }
}

/**
 * 用 worker_threads 并行求解单个 hashwx 挑战。
 * worker 之间按 block 同余类分片（block = workerIndex + k*workerCount），
 * 谁先找到解就终止全部 worker。
 */
function solveOneParallel(payload, { workers, log }) {
  return new Promise((resolve, reject) => {
    const workerUrl = new URL('./cap-pow-worker.mjs', import.meta.url);
    const spawned = [];
    let settled = false;
    let totalAttempts = 0;
    let lastReport = Date.now();

    const cleanup = () => {
      for (const w of spawned) w.terminate().catch(() => {});
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    let exited = 0;
    for (let i = 0; i < workers; i++) {
      const w = new Worker(workerUrl, {
        workerData: { payload, workerIndex: i, workerCount: workers },
      });
      spawned.push(w);

      w.on('message', (m) => {
        if (settled) return;
        if (m.type === 'progress') {
          totalAttempts += m.attempts;
          if (Date.now() - lastReport > 5000) {
            lastReport = Date.now();
            log(`     ...累计尝试 ${totalAttempts} 个 nonce`);
          }
          return;
        }
        if (m.type === 'found') {
          settled = true;
          cleanup();
          resolve(BigInt(m.nonce));
        }
      });

      w.on('error', fail);

      w.on('exit', () => {
        exited++;
        if (!settled && exited === workers) {
          fail(new Error('PoW worker 全部退出但未找到解'));
        }
      });
    }
  });
}

/**
 * 走完整 Cap 流程，返回可用的 captcha token。
 * @returns {Promise<string>} redeem 返回的 token
 */
export async function solveCap(page, apiEndpoint, { workers, log = () => {} } = {}) {
  const ep = apiEndpoint.endsWith('/') ? apiEndpoint : `${apiEndpoint}/`;
  const w = workers ?? defaultWorkers();

  log(`Cap 验证码: 请求 challenge (${ep})`);
  const cRes = await page.evaluate(async (url) => {
    const r = await fetch(url, { method: 'POST', credentials: 'include' });
    const text = await r.text();
    try {
      return { status: r.status, data: JSON.parse(text) };
    } catch {
      return { status: r.status, data: text.slice(0, 300) };
    }
  }, `${ep}challenge`);

  if (cRes.status !== 200 || !cRes.data?.token) {
    throw new Error(`Cap challenge 失败: HTTP ${cRes.status} ${JSON.stringify(cRes.data).slice(0, 200)}`);
  }

  const chal = cRes.data;
  const challenges = chal.challenges || [];
  log(
    `Cap 验证码: 收到 ${challenges.length} 个挑战 (format=${chal.format}, protocols=${challenges
      .map((c) => c.protocol)
      .join(',')})`
  );

  const solutions = [];
  const t0 = Date.now();
  for (let i = 0; i < challenges.length; i++) {
    const c = challenges[i];
    if (c.protocol !== 'hashwx') {
      throw new Error(`Cap 遇到未支持的协议 "${c.protocol}"（本实现只处理 hashwx）`);
    }
    const p = c.payload;
    log(`  [${i + 1}/${challenges.length}] hashwx d=${p.d} n=${p.n} 求解中 (${w} workers)...`);
    const nonce = await solveOneParallel(p, { workers: w, log });
    log(`  [${i + 1}/${challenges.length}] 解出 nonce=${nonce}`);
    solutions.push({ nonce: String(nonce) });
  }
  log(`Cap 验证码: 全部解出，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const rRes = await page.evaluate(
    async ({ url, body }) => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const text = await r.text();
      try {
        return { status: r.status, data: JSON.parse(text) };
      } catch {
        return { status: r.status, data: text.slice(0, 300) };
      }
    },
    { url: `${ep}redeem`, body: { token: chal.token, solutions } }
  );

  if (rRes.status !== 200 || !rRes.data?.success || !rRes.data?.token) {
    throw new Error(`Cap redeem 失败: HTTP ${rRes.status} ${JSON.stringify(rRes.data).slice(0, 200)}`);
  }
  log('Cap 验证码: redeem 成功，token 已获得');
  return rRes.data.token;
}
