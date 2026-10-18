# paseo-notify

当 Paseo 里的 AI agent **真正完成任务**、或**需要你审批/做选择**时，给你的 **Apple Watch** 推一条通知，手表出声 + 震动。

本仓库是一个 monorepo，包含三部分：

```
paseo-notify/
  packages/plugin/     # Paseo 插件（server 钩子 → POST 网关）  ← 已完成并自测
  services/gateway/    # 最小 APNs 中继                         ← 已完成并自测
  apps/ios/            # iPhone 伴侣 App（Swift）               ← 已完成，构建通过
  apps/watch/          # watchOS 通用接收 App（Swift）           ← 已完成，构建通过
  docs/design.md       # 设计说明（目录结构 / 去抖方案 / 传输选型）
```

数据流：

```
Paseo daemon 子进程           可配置网关(APNs 中继)              Apple Watch
┌───────────────────┐  POST   ┌──────────────────┐  APNs   ┌───────────────┐
│ paseo-notify 插件  │ ──────► │ services/gateway │ ──────► │ watchOS App   │
│ (server hooks)    │  JSON   │  (自建, 最小)     │         │ 声音 + 震动    │
└───────────────────┘         └──────────────────┘         └───────────────┘
                                       ▲                          ▲
                                       │ APNs                     │ 镜像/WatchConnectivity
                                       └──────────── apps/ios ────┘
```

- **已确认的传输方案：A. 自建最小 APNs 中继 + 自研接收 App。**
- **已确认的手表 App 形态：Form 2（iPhone 伴侣 App + watchOS 接收 App）。**

插件只负责「POST 结构化 JSON 到可配置 URL」，与传输层完全解耦。

> 当前进度：`packages/plugin` 与 `services/gateway` 已完成，各自通过 `typecheck` + 单元测试（插件 33 个、网关 15 个）；`apps`（iOS + watchOS）源码与工程定义已就绪，模拟器构建通过。iOS/watchOS 需用你的 Apple 账号签名后跑真机。

---

## 一、Paseo 插件（packages/plugin）

### 触发时机（与去抖设计）

| 事件 | 行为 |
| --- | --- |
| `agent.permission_requested` | **立即**通知；按 `request.id` 去重，同一请求只发一次 |
| `agent.permission_resolved` | **不**通知 |
| `agent.turn_ended`（`completed`） | 进入**静默窗口**去抖，窗口安静结束才判定「真正完成」并发通知 |
| `agent.turn_ended`（`failed`） | 同上（可配置关闭） |
| `agent.turn_ended`（`canceled`） | 忽略 |

**为什么不能直接监听 `agent.turn_ended`：** 它**每一轮**结束都会触发（用户每发一条消息导致的每一轮结束都触发），
**不等于**「整个任务真正跑完」。Paseo 内置的「任务完成」语义是 agent 状态从 `running → idle`
（见 Paseo 源码 `packages/server/src/server/agent/agent-manager.ts` 的 `checkAndSetAttention`）。

因此插件按 `agentId` 隔离维护一个静默窗口定时器：

```
turn_ended(completed) ─► 重置窗口(D 秒)
     │
     ├─ 窗口内收到同一 agent 的 turn_started ─► 取消待发通知（任务仍在继续）
     └─ 窗口安静到期                        ─► 判定真正完成 ─► 发通知
```

- 连续多轮 `turn_ended` 会合并成**一条**通知（取最后一次的摘要）。
- 子 agent（`parentAgentId != null`）默认忽略，避免 subagent 乱发。
- 通知发送失败只记录日志，不会让插件崩溃。

### 配置项

在 Paseo 里打开 **Settings → Plugins → Paseo Watch Notify**，或用 **⌘K**（macOS）/ **Ctrl+K** 执行
**Configure Paseo Watch Notify**：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| Gateway URL | 空（空则不发送） | 网关 POST 目标，必须是 http(s) |
| Auth token | 空 | 作为 `Authorization: Bearer <token>` 发送 |
| Quiet window (ms) | `15000` | 静默窗口时长（0 表示不做去抖，每轮都发） |
| Permission requests | 开 | 审批是否立即通知 |
| Failed turns | 开 | `failed` 是否通知 |
| Subagents | 关 | 子 agent 是否通知 |

> **安全**：settings 是 daemon 主机上的**明文 JSON**，不是凭据保险库。真实密钥建议改用
> daemon 进程的环境变量 `PASEO_NOTIFY_AUTH_TOKEN`（会覆盖 settings 里的 token）。任何密钥都不要写进代码或提交进仓库。

### 安装 / 调试

```bash
cd packages/plugin
npm install                # 仅本地 typecheck / 测试用；Paseo 运行时自带 SDK
npm run typecheck
npm run test

paseo plugin install "$PWD"   # 安装到本机 daemon
paseo plugin ls               # 期望 paseo-notify 状态 running

# 改代码后：
npm run typecheck && paseo plugin reload paseo-notify
paseo plugin logs paseo-notify
```

> **不要重启主 daemon（6767 端口）**——它会杀掉正在跑的 agent。用 `paseo plugin reload`。

### 验证

1. 配好 Gateway URL（一个能接收 POST 的地址，例如临时用 `nc -l` 或 webhook 站点）。
2. 在设置页点 **Send test**：网关应收到一条 `source: "paseo-notify"` 的 POST。这是**手动触发一次通知**的方式。
3. 跑一个真实 agent，让它完成一轮 → 等过静默窗口后应收到 `agent.finished`。
4. 让 agent 触发一次权限请求 → 应立即收到 `agent.permission_requested`。

### 通知 payload

```jsonc
{
  "source": "paseo-notify",
  "type": "agent.finished" | "agent.permission_requested",
  "reason": "finished" | "failed" | "permission",
  "agentId": "…",
  "agentTitle": "…",
  "workspaceId": "…",
  "provider": "…",
  "cwd": "/abs/path",
  "preview": "末条助手消息纯文本摘要（≤220 字）/ 权限详情",
  "timestamp": "2026-10-16T…Z"
}
```

---

## 二、网关与 App

已选定 **方案 A：自建最小 APNs 中继 + 自研接收 App（Form 2）**。详见 `docs/design.md` 的对比表。

- 网关：`services/gateway/`（含运行与 API 说明，见其 README）。
- App：`apps/`（iOS 伴侣 + watchOS 接收，含 Apple 后台操作与运行步骤，见 `apps/README.md`）。

端到端链路：

```
插件 ──POST /api/notify──► gateway ──APNs──► iPhone(iOS App) ──镜像──► Apple Watch
iOS App ──POST /api/devices──► gateway（注册 APNs device token）
```

### 用户需准备

**已具备：** Apple Developer Program 账号（$99/年）。

**需在 Apple 后台（Certificates, Identifiers & Profiles）完成：**

1. **注册 App ID / Bundle ID**（Identifiers → App IDs）
   - iPhone 伴侣 App：例如 `com.yourname.paseonotify`
   - watchOS App：例如 `com.yourname.paseonotify.watchkitapp`
   - 两个都要勾选 **Push Notifications** 能力。
2. **生成 APNs Key 与 Key ID**（Keys → **+** → 勾选 Apple Push Notifications service (APNs)）
   - 下载 `.p8` 文件（**只能下载一次**，妥善保管，勿提交进仓库）。
   - 记下 **Key ID**。
3. **记下 Team ID**（Membership details → Team ID）。

网关运行时需要：`.p8` 文件路径、Key ID、Team ID、Bundle ID（APNs 的 `apns-topic`）。
这些**全部通过运行时配置/环境变量注入，绝不写进代码或提交进仓库**（`.gitignore` 已忽略 `*.p8`）。

---

## 三、如何测试（由浅入深）

### 级别 1：不需要 Apple 账号，验证「插件 → 网关」

用网关的 dry-run 模式（只打印、不发 APNs）：

```bash
cd services/gateway && npm install --legacy-peer-deps && npm run build
DRY_RUN=1 PASEO_NOTIFY_GATEWAY_TOKEN=dev-token DEVICES_FILE=/tmp/pn-devices.json \
  APNS_TOPIC=com.example.paseonotify node dist/index.js
```

然后把 Paseo 插件设置页的 **Gateway URL** 设为 `http://127.0.0.1:8787/api/notify`、token 填 `dev-token`，
点 **Send test** → 网关日志会打印映射后的 APNs 载荷。详见 `services/gateway/README.md`。

### 级别 2：模拟器，验证「手机通知的样子」

模拟器收不到真实 APNs，但可以本地喂一条：

```bash
# 先构建并安装 App 到已启动的模拟器
cd apps && xcodebuild -project PaseoNotify.xcodeproj -scheme PaseoNotify \
  -sdk iphonesimulator -configuration Debug build
xcrun simctl install booted \
  ~/Library/Developer/Xcode/DerivedData/PaseoNotify-*/Build/Products/Debug-iphonesimulator/PaseoNotify.app
xcrun simctl launch booted com.example.paseonotify

# 首次需在模拟器里点一次「允许」（系统权限弹窗，必须人工点）
xcrun simctl push booted com.example.paseonotify apps/Payload.sample.apns
```

- `apps/Payload.sample.apns` 已备好，就是通知的真实形状。也可在模拟器窗口里直接把这个文件拖进去。
- 想测手表：需要先在 **Xcode → Settings → Components** 安装 watchOS 模拟器运行时，再与 iPhone 模拟器配对后同样推送。

### 级别 3：真机，验证完整链路（插件 → 网关 → APNs → 手机 → 手表）

需要你的 `.p8`/Team ID/Bundle ID 与真机。步骤见 `docs/apple-setup.md` 与 `apps/README.md`。

## 四、安全与边界

- 插件是**受信任、无沙箱**代码，运行在 daemon 的独立子进程里，拥有该用户的完整 Node 权限。
- 插件遵守 Paseo 运行时边界：`server/` 不放 React/客户端代码，`shared/` 只放 zod 合约与纯数据，插件根目录不放其他代码文件。
- 不在代码中硬编码任何密钥；APNs 密钥仅通过环境变量/运行时配置提供。
