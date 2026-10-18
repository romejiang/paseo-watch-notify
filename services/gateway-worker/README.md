# paseo-notify gateway (Cloudflare Worker)

生产网关。接收 `paseo-notify` 插件的通知，按**渠道**隔离设备，再通过 APNs 推送到 Apple 设备。

> 这是**两个等价实现**中的一个（另一个是 `services/gateway` 的 Node 版）。两者契约完全一致，
> 客户端可指向任意一个；仓库里有对照脚本验证这一点：`npm --prefix services/gateway run parity`。

```
插件(任意用户) ──POST /api/notify (Bearer 渠道密钥)──► Worker ──APNs──► iPhone ──镜像──► Watch
iOS App(该用户) ──POST /api/devices (同一渠道密钥)──► Worker
```

## 为什么是多租户

插件要发布到插件市场，所有人都会连**同一个**网关。所以：

- 每个用户有一个**渠道密钥**（channel secret）：插件的 `authToken` 与 iOS App 里的 token 填**同一个值**。
- 设备注册在 `dev:<sha256(渠道密钥)>:<deviceToken>` 下，`/api/notify` **只推给该渠道自己的设备**。
- 原始密钥**不落库**，只存哈希。
- APNs 的 `.p8` 是网关运营方（你）的密钥，对所有用户共用；`apns-topic` = App 的 Bundle ID（也是共用的）。

> ⚠️ **隐私**：网关运营方能读到通知内容（agent 标题/摘要）。公开服务必须把这点写进插件说明。可选的后续增强是端到端加密（网关只见密文）。

## 已部署实例

| 项 | 值 |
| --- | --- |
| 自定义域名 | `https://notify.romejiang.top`（推荐） |
| workers.dev | `https://paseo-notify-gateway.romejiang.workers.dev` |
| 插件地址 | `https://notify.romejiang.top/api/notify` |
| App 地址 | `https://notify.romejiang.top` |
| KV 绑定 | `DEVICES` |
| DO 绑定 | `RATE_LIMIT_SHARDS`（限流计数器） |
| `APNS_TOPIC` | `com.romejiang.paseonotify` |

自定义域名在 `wrangler.toml` 的 `routes` 里声明（`{ pattern = "notify.romejiang.top", custom_domain = true }`），
部署时 Cloudflare 自动建 DNS 记录与证书。

## 本地开发

```bash
cd services/gateway-worker
npm install --legacy-peer-deps
npm run typecheck
npm test              # 纯逻辑 + handler 单测（伪造 KV / 伪造 APNs）
npm run dev           # 本地 workerd，自动 local KV（wrangler.toml 里的 id 用占位即可）
```

`[vars] DRY_RUN = "1"` 时只打日志、不连 APNs，方便本地和刚部署时验证。

> 注意：本地 `wrangler dev` 在 macOS 的 workerd 上**不会用 HTTP/2**，而 APNs 强制 HTTP/2，
> 所以**本地 dry-run=0 时发真推送会失败**（已知问题）。真正的 APNs 发送要在**部署后的边缘**验证。

## 部署步骤

1. **登录**（需要你的 Cloudflare 账号）：
   ```bash
   wrangler login
   ```
   或在 CI 里用 `CLOUDFLARE_API_TOKEN`。
2. **创建 KV 命名空间**并填进 `wrangler.toml`：
   ```bash
   wrangler kv namespace create DEVICES
   ```
   把返回的 `id` 贴到 `[[kv_namespaces]] id`（替换 `REPLACE_WITH_KV_NAMESPACE_ID`）。
3. **设置 APNs 密钥**（不写进代码，存为 Worker secret）：
   ```bash
   wrangler secret put APNS_KEY_P8     # 粘贴 .p8 文件内容（含 BEGIN/END 行）
   wrangler secret put APNS_KEY_ID
   wrangler secret put APNS_TEAM_ID
   ```
4. **切换为正式发送**：把 `wrangler.toml` 的 `DRY_RUN` 改为 `"0"`、`APNS_ENV` 设为 `production`（真机 Debug 走 sandbox 时才用 `development`）。
5. **部署**：
   ```bash
   wrangler deploy
   ```
   得到形如 `https://paseo-notify-gateway.<account>.workers.dev` 的地址。
6. **验证**：
   ```bash
   curl https://<your-worker>/healthz
   curl -X POST https://<your-worker>/api/devices \
     -H "Authorization: Bearer <你的渠道密钥>" -H 'content-type: application/json' \
     -d '{"token":"<设备 token>","platform":"ios"}'
   curl -X POST https://<your-worker>/api/notify \
     -H "Authorization: Bearer <你的渠道密钥>" -H 'content-type: application/json' \
     -d '{"source":"paseo-notify","reason":"finished","preview":"hello"}'
   ```

## HTTP API

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/healthz` | 无 | `{ ok: true }`（不计入限流） |
| POST | `/api/devices` | `Bearer <渠道密钥>` | body `{ token, platform?, environment?, topic? }`，按 token 幂等，返回 `201` |
| DELETE | `/api/devices/:token` | `Bearer <渠道密钥>` | 注销设备，返回 `{ removed }` |
| POST | `/api/notify` | `Bearer <渠道密钥>` | 插件的 payload，返回 `{ delivered, failed, devices }` |

其它路径一律 `404 {"error":"not found"}`；缺少 Bearer → `401`；非法 JSON → `400`；
请求体超过 64 KB → `413`；超限 → `429`（带 `Retry-After`）。

APNs 返回 `410 Unregistered` 的 token 会被自动删除。

## 限流

固定窗口，按**渠道**和**IP**两个维度，默认值与 Node 版完全一致（同一个算法、同样的
`429` + `Retry-After` + `x-ratelimit-limit` / `x-ratelimit-remaining`）：

| 变量（`wrangler.toml` 的 `[vars]`） | 默认 | 说明 |
| --- | --- | --- |
| `RATE_LIMIT_ENABLED` | `1` | 是否开启 |
| `RATE_LIMIT_PER_CHANNEL` | `60` | 每个渠道密钥每窗口的请求数（真正的用户级保护） |
| `RATE_LIMIT_PER_IP` | `120` | 每个 IP 每窗口的请求数（挡未鉴权洪水，用 `CF-Connecting-IP`） |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 窗口长度 |

计数存在 **Durable Object**（`src/ratelimit-object.ts`）里，按 key 散列到 8 个分片，
所以额度是**全局**的：所有 isolate、所有 Cloudflare 节点共用一个计数器。

> 为什么不用 Cloudflare 的 `[[ratelimits]]` 声明式绑定？实测它在生产上**按 isolate 生效**：
> 60/窗口 的额度下，120 个并发请求全部被放行（已用 `/__debug` 探针确认绑定本身会拒绝，
> 但并发连接分散到了不同 isolate）。DO 是单实例 actor，因此没有这个问题。

计数只在内存里。分片被回收会提前重置窗口（偏宽松而非误杀）；持续有流量的分片不会在窗口内被回收。

## 与插件/App 的对接

- 插件设置里：`Gateway URL` = `https://<your-worker>/api/notify`，`Auth token` = 该用户的渠道密钥。
- iOS App 里：`Gateway URL` = `https://<your-worker>`，`Device registration token` = **同一个**渠道密钥。

## 用户需在 Apple 后台准备

见仓库根 `README.md` 与 `docs/apple-setup.md`。（你已具备 Apple Developer Program 账号。）

## 部署前的开放问题（发布前需要定）

- **App 分发**：公共插件要让所有人用，iOS/watchOS App 得能装到别人手机上——要么上 TestFlight/App Store，要么让每人自己用 Xcode 签名自己的 Bundle ID。这会影响 `APNS_TOPIC` 是「共用」还是「每人不同」。
- **密钥吊销**：渠道密钥泄露后目前没有吊销机制（设备会随 410 自动清理）。
- **端到端加密**：避免运营方看到通知内容。
