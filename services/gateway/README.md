# paseo-notify gateway

最小 APNs 中继。接收 `paseo-notify` 插件的 POST，转发到已注册的 Apple 设备（iPhone，随后由 iOS 镜像到 Apple Watch）。

```
插件 ──POST /api/notify──► gateway ──APNs(HTTP/2 + ES256 JWT)──► iPhone ──镜像──► Watch
iOS App ──POST /api/devices──► gateway   （注册 APNs device token）
```

无重型依赖，只用 Node 内置模块（`node:http`、`node:http2`、`node:crypto`、`node:fs`）。

## 运行

```bash
cd services/gateway
npm install --legacy-peer-deps     # 本地类型检查/测试用
npm run typecheck
npm run test
npm run build
cp .env.example .env               # 填入密钥与配置
set -a; . ./.env; set +a
npm start                          # 默认 :8787
```

## 配置（环境变量）

| 变量 | 说明 |
| --- | --- |
| `PORT` | 监听端口，默认 8787 |
| `PASEO_NOTIFY_GATEWAY_TOKEN` | 插件 POST `/api/notify` 时必须带的 Bearer token；留空仅用于本地开发 |
| `PASEO_NOTIFY_DEVICE_TOKEN` | iOS App 注册设备时的 Bearer token，缺省回退到上面那个 |
| `DEVICES_FILE` | 设备注册表 JSON 路径，默认 `./devices.json` |
| `APNS_KEY_PATH` / `APNS_KEY_P8` | APNs 签名私钥 `.p8`（文件路径，或内联 PEM，`\n` 转义） |
| `APNS_KEY_ID` | Apple 后台 Keys 里的 Key ID |
| `APNS_TEAM_ID` | Team ID |
| `APNS_TOPIC` | 接收推送的 Bundle ID（iOS App 的 Bundle ID） |
| `APNS_ENV` | `development`（sandbox）或 `production` |
| `DRY_RUN` | 设为 `1` 时只把推送写日志、不真发 APNs，**无需任何 Apple 凭据** |

## HTTP API

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/healthz` | 无 | `{ ok, devices }` |
| POST | `/api/notify` | gateway token | 插件 payload → 向所有设备推送，返回 `{ delivered, failed, devices }` |
| POST | `/api/devices` | device token | body `{ token, platform?, environment?, topic? }`，按 token 幂等 upsert |
| DELETE | `/api/devices/:token` | device token | 注销设备 |

APNs 返回 `410 Unregistered` 的 token 会被自动删除。

## 无 Apple 账号验证（dry-run）

不需要 `.p8`、不需要账号，即可验证「插件 → 网关 → APNs 载荷」这一段：

```bash
cd services/gateway
npm install --legacy-peer-deps && npm run build

DRY_RUN=1 PASEO_NOTIFY_GATEWAY_TOKEN=dev-token DEVICES_FILE=/tmp/pn-devices.json \
  APNS_TOPIC=com.example.paseonotify node dist/index.js

# 另开一个终端：注册一个假设备，再发一条插件形状的负载
curl -s -X POST http://127.0.0.1:8787/api/devices \
  -H "Authorization: Bearer dev-token" -H "content-type: application/json" \
  -d '{"token":"fakedevice0123456789","platform":"ios"}'

curl -s -X POST http://127.0.0.1:8787/api/notify \
  -H "Authorization: Bearer dev-token" -H "content-type: application/json" \
  -d '{"source":"paseo-notify","reason":"finished","agentTitle":"Fix the bug","preview":"All done."}'
# → {"delivered":1,"failed":0,"devices":1}，网关日志会打印映射后的 APNs 载荷
```

再把 Paseo 插件的 Gateway URL 指向 `http://127.0.0.1:8787/api/notify`、token 填 `dev-token`，
在设置页点 **Send test**，即可看到网关收到真实插件请求。

## 安全

- 密钥只经环境变量/`.env` 注入；`.gitignore` 已忽略 `*.p8` 与 `services/gateway/.dev.vars`。
- 网关应部署在你自己的机器或私有网络里；`/api/notify` 必须设置 token（生产环境）。

## 用户需在 Apple 后台准备

见仓库根 `README.md` 与 `apps/README.md`：注册两个 App ID（iOS + watchOS，均带 Push 能力）、生成 APNs Key（`.p8`）与 Key ID、记录 Team ID。你已具备 Apple Developer Program 账号。
