/**
 * cap.js PoW 求解器测试（不联网）。
 *
 * 用 HAR 里 4 个真实挑战做回归：求解器必须算出**满足判据**的 nonce。
 * 注意求解器会返回它自己找到的第一个合法解，不保证等于 HAR 里那个
 * （浏览器和我们的搜索顺序不同），所以断言的是「解合法」而不是「解相同」。
 */
import { hashwxReady, hashwxTarget, hashwxSeed, hashwxHash } from './vendor/cap/hashwx.js';

const FIXTURE = [
  {
    c: 'c67a18dc9499783795c1d4e21513608c38efcf51615db2e053d62299b9de013f',
    d: 250000,
    n: 65536,
    harNonce: '93493',
  },
  {
    c: '2434a8cf0482633ec2219d1d0294b3468b16d687ecf68b659d9a90c526fb6c0e',
    d: 250000,
    n: 65536,
    harNonce: '21236',
  },
];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** 串行求解（测试求确定性，不用分片） */
async function solveSerial(payload, state) {
  const challenge = new Uint8Array(Buffer.from(payload.c, 'hex'));
  const n = BigInt(payload.n);
  const target = hashwxTarget(payload.d);
  let block = 0n;
  for (;;) {
    const seed = hashwxSeed(challenge, block);
    const base = block * n;
    for (let k = 0n; k < n; k++) {
      const nonce = base + k;
      if (hashwxHash(state, seed, nonce) <= target) return nonce;
    }
    block++;
  }
}

const state = await hashwxReady();

// --- 1) 先验证 HAR 记录的解本身合法（证明我们对算法的理解正确） ---
console.log('=== 验证 HAR 记录的解 ===');
for (const f of FIXTURE) {
  const challenge = new Uint8Array(Buffer.from(f.c, 'hex'));
  const nonce = BigInt(f.harNonce);
  const block = nonce / BigInt(f.n);
  const seed = hashwxSeed(challenge, block);
  const h = hashwxHash(state, seed, nonce);
  const target = hashwxTarget(f.d);
  assert(h <= target, `HAR nonce ${f.harNonce} 不满足判据 (hash=${h} target=${target})`);
  console.log(`  HAR nonce ${f.harNonce}: hash=${h} <= target=${target} ✓`);
}

// --- 2) 再验证求解器能独立求出合法解 ---
console.log('\n=== 求解器独立求解 ===');
for (const f of FIXTURE) {
  const t0 = Date.now();
  const nonce = await solveSerial(f, state);
  const ms = Date.now() - t0;
  const block = nonce / BigInt(f.n);
  const seed = hashwxSeed(new Uint8Array(Buffer.from(f.c, 'hex')), block);
  const h = hashwxHash(state, seed, nonce);
  const target = hashwxTarget(f.d);
  assert(h <= target, `求解器给出的 nonce ${nonce} 不合法`);
  console.log(`  解出 nonce=${nonce} (hash=${h} <= ${target}) 耗时 ${ms}ms ✓`);
}

console.log('\nok');
