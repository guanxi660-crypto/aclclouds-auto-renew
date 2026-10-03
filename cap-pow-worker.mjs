/**
 * cap.js PoW 求解 worker。
 * 按 block 同余类分片：block = workerIndex, workerIndex+workerCount, ...
 * 每个 block 内 nonce 从 block*n 到 block*n+n-1，共用同一个 seed。
 *
 * 注意：hashwx 求解是纯 CPU 密集且会阻塞事件循环，所以这里不做
 * 定期 yield —— 一个 block 通常很快跑完，卡住太久反而拖慢整体。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { hashwxReady, hashwxTarget, hashwxSeed, hashwxHash } from './vendor/cap/hashwx.js';

const { payload, workerIndex, workerCount } = workerData;

const challenge = new Uint8Array(Buffer.from(payload.c, 'hex'));
const noncesPerHash = BigInt(payload.n);
const target = hashwxTarget(payload.d);

const state = await hashwxReady();

let hashCount = 0;
let lastReport = Date.now();

for (let block = BigInt(workerIndex); ; block += BigInt(workerCount)) {
  const seed = hashwxSeed(challenge, block);
  const base = block * noncesPerHash;
  for (let k = 0n; k < noncesPerHash; k++) {
    const nonce = base + k;
    hashCount++;
    if (hashwxHash(state, seed, nonce) <= target) {
      parentPort.postMessage({ type: 'found', nonce: nonce.toString() });
      process.exit(0);
    }
    if (Date.now() - lastReport > 2000) {
      lastReport = Date.now();
      parentPort.postMessage({ type: 'progress', attempts: hashCount });
      hashCount = 0;
    }
  }
}
