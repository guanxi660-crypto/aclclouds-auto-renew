const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

// renew.mjs 用 import.meta.url 判断是否直接运行（isMain），
// 被 import 时 main() 不会执行——旧版直接 import('./renew.mjs') 会导致
// `node with-env.cjs` 静默什么都不做。改为子进程启动，退出码原样透传。
const r = spawnSync(process.execPath, [path.join(__dirname, 'renew.mjs')], { stdio: 'inherit' });
process.exit(r.status ?? 1);
