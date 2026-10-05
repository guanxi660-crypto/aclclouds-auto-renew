# ACLClouds Auto-Renew

ACLClouds Free Bot 托管自动续期。Free 套餐约 4 天到期，到期前 1 天才开放续期。脚本用账号密码登录（过站点的 cap.js 工作量证明验证码），发现真实 server id，调用续期 API。GitHub Actions 每天跑一次，结果发 Telegram。

## 做什么

1. Playwright 打开 `/auth/login`，填 `ACL_USERNAME` / `ACL_PASSWORD`
2. 过登录验证码（cap.js PoW，见下），提交登录
3. 登录进 dashboard，调 `/api/client` 拿服务列表（含真实 server id 与 `expires_at`）
4. `POST /api/client/servers/{id}/upgrade/renew`
   - `200` 续期成功
   - `400 renewal_not_available` 未到窗口（按成功处理）
   - `403 captcha_required` 过 cap.js PoW 后带 `captcha_token` 重试
   - 其它状态当失败
5. API 失败时才启用 UI 兜底（点 dashboard 的「Renouveler」按钮，弹窗里同样过 cap.js）
6. Telegram 通知（见下）

## 验证码：cap.js 工作量证明

2026-10 平台改版，验证码从「点图选词」换成了 [Cap](https://github.com/tiagozip/cap)：
不是识别图像，而是算一道 SHA-256 的 proof-of-work。

流程：

```
POST /api/client/servers/{id}/upgrade/renew        -> 403 {"error":"captcha_required"}
POST {apiEndpoint}challenge                        -> { token, challenges:[{protocol:"hashwx",payload}] }
   对每个 hashwx 挑战求 nonce，使 hashwx(seed, nonce) <= U64_MAX / d
POST {apiEndpoint}redeem { token, solutions }      -> { success:true, token }
POST /api/client/servers/{id}/upgrade/renew { captcha_token }   -> 200
```

- `apiEndpoint` 由服务端注入在页面 `<script id="client-bootstrap-data">` 里
  （`siteConfiguration.recaptcha`，本站为 `https://cap.aclclouds.com/235a82a3e3/`）。
- 求解核心是官方 `core/src/hashwx.js`（**vendored** 到 `vendor/cap/`，wasm 以 base64 内嵌），
  **不拉 jsDelivr**，离线可跑、CI 不受 CDN 可达性影响。
- **并行**：用 `node:worker_threads` 真正多核并行（`cap-solver.mjs` + `cap-pow-worker.mjs`），
  worker 之间按 block 同余类分片，谁先解出就终止全部。并发度由 `CAP_POW_WORKERS` 控制。
  单线程里塞多个分片只是串行，拿不到加速 —— wasm 求解是同步的，会阻塞事件循环。

实测（4 个挑战，`d=250000, n=65536`）：串行约 44s → 4 worker 并行约 **7.2s**。算法已用 HAR 里
的真实挑战做过回归（见 `test_cap_pow.mjs`）。

实测：账号 `aclbot_638370` 的真实 server id 是 `da9333c4`（不是面板 URL 里的 `5c0ab2ab`）。

## Telegram

| 结果 | 发什么 |
|---|---|
| 续期成功 | 一条最终状态，不带图 |
| 未到续期窗口 | 一条最终状态（剩余天数），不带图 |
| 续期失败 / 崩溃 | 最终状态 + 续期相关截图 |

登录、验证码过程不发 TG。本地仍会把全过程截图写到 `shots/`。

通知样式（每台服务一个块）：

```
🇫🇷 ACLClouds 续期通知
📊 状态: ⏭️ 本轮无需续期
🕒 执行时间: 2026-10-06 00:07:14 (UTC+8)

📦 Mon VPS 8817 · Free
🧠 规格: 315MB / 0.5 cores / 715MB 磁盘
📅 到期时间: 2026-10-09 03:51 (UTC+8)
⏳ 剩余: 75小时44分
⏳ 下次可续期: 51小时44分后

📌 站点限制到期前 24 小时开放续期，下次自动处理
```

- 套餐名取自 `/api/client/credits/subscriptions` 的 `plan_name`，取不到就不显示该行。
- 规格取自 `/api/client` 的 `limits`（`memory` MB / `cpu`% ÷ 100 转 cores / `disk` MB）。
- 「下次可续期」= 到期时间 − 24 小时；已进入窗口则显示「已开放」。
- 时间统一按 UTC+8 输出，用固定 +8 偏移计算，不依赖运行时 tz 数据库。

## GitHub Actions

`.github/workflows/renew.yml`：每天 UTC `23:28`（北京时间次日 `07:28`），也可手动 Run workflow。

Secrets：

| 名 | 用途 |
|---|---|
| `ACL_USERNAME` | 登录用户名 |
| `ACL_PASSWORD` | 密码 |
| `ACL_SERVER_ID` | 可选，已知 server id（如 `da9333c4`）；留空则自动发现 |
| `TG_BOT_TOKEN` | Telegram bot token |
| `TG_CHAT_ID` | Telegram chat id |

Variable（可选）：`ACL_BASE_URL`，默认 `https://aclclouds.com`

## 本地跑

```bash
cp .env.example .env   # 填账号、TG
npm install
npx playwright install chromium
node with-env.cjs
```

`DRY_RUN=1` 只登录和发现服务，不 POST renew。

`npm test` 跑全部离线回归（响应分类 + PoW 算法 + 隐藏按钮场景），不联网、不改数据。

## 已完成 / 待做

**已完成**

- 账号密码登录，不再依赖手动导出 session cookie
- 适配 2026-10 改版：验证码换成 cap.js（hashwx PoW），登录与续期两条路径都走 `solveCap`
- 官方 hashwx wasm vendored 进仓库 + worker_threads 并行，4 挑战约 7.2s 出 token
- 自动发现真实 Pterodactyl server id（`da9333c4`），并跳过面板短 id `5c0ab2ab` 的 404
- 续期接口打通；窗口外返回 `renewal_not_available` 视为正常
- Actions 定时 + Secrets / Variable
- TG：成功或未到窗口只发最终续期状态；失败才发续期/报错截图。登录和验证码不通知
- 通知改成对齐的键值卡片（状态/执行时间 + 每台一块：套餐/规格/到期/剩余/下次可续期），
  时间统一 UTC+8；已加排版回归测试
- 登录成功写入 `auth.json`，Actions cache 下次跳过验证码；失效则删掉重登
- `403 captcha_required` 过 PoW 后带 `captcha_token` 重试续期
- 未设 `ACL_SERVER_ID` 时对发现的每台都续；设了则只打这一台
- API 优先、UI 兜底：UI 逻辑全程 try/catch，页面异常不再中断整条续期链路
- 续期按钮只认「可见」元素（`firstVisible`），修掉隐藏按钮导致 `click` 30s 超时的问题
- 回归测试：`test_classify.mjs`（响应/文案分类）+ `test_cap_pow.mjs`（PoW 算法，含 HAR 真实挑战）
  + `repro-hidden-btn.mjs`（隐藏按钮场景），已接入 workflow。`npm test` 一把跑完

**待做**

- 等窗口打开再打一次，确认 `200` 后续期天数真的往后推
- 登录路径的 PoW 只在代码上接了，尚未拿真实登录 challenge 端到端验证
- UI 兜底路径（弹窗过盾）尚未端到端验证
