# paseo-notify 设计说明

状态：**决策已定** — 传输方案 A（自建最小 APNs 中继 + 自研接收 App）；手表 App 形态 Form 2（iPhone 伴侣 + watchOS 接收 App）。插件已实现并自测通过。

本仓库把「Paseo → 通知」和「通知 → Apple Watch」解耦：

```
Paseo daemon 子进程                可配置网关                 Apple Watch
┌────────────────────┐   POST JSON  ┌──────────────┐  APNs/…  ┌──────────────┐
│ paseo-notify 插件   │ ───────────► │ gateway (可选)│ ───────► │ 通用接收 App  │
│ (server hooks)     │              │              │          │ 声音 + 震动   │
└────────────────────┘              └──────────────┘          └──────────────┘
```

插件只依赖「POST 到可配置 URL」，因此传输层选型不影响插件先开工。

## 一、目录结构（monorepo）

```
paseo-notify/
  package.json                 # workspace 根（npm workspaces）
  README.md
  docs/
    design.md                  # 本文件
  packages/
    plugin/                    # Paseo 插件（其根目录即 paseo-plugin.json 所在处）
      paseo-plugin.json        # id: "paseo-notify", requirements.paseo
      package.json
      tsconfig.json
      index.server.ts          # default export contribute(server) → cleanup
      server/                  # Node/网络/去抖/处理器
        contribute.ts
        debouncer.ts
        notify.ts              # POST 网关
        summary.ts             # 从 timeline 提取末条助手消息
      shared/                  # zod 合约与两端共用纯数据
        settings.ts            # defineSettings + 事件 payload 类型
      server/**/*.test.ts      # 确定性测试（注入时钟）
  apps/
    watch/                     # watchOS 通用接收 App（形态待确认）
    ios/                       # （若选 Form 2 才需要）iPhone 伴侣
  services/
    gateway/                   # （若选自建 APNs）最小中继
```

说明：Paseo 只把 `packages/plugin/` 当作插件根，其上层 monorepo 目录不会被编译。插件内部严格遵守
`server/`、`client/`、`shared/` 运行时边界，根目录不放其他代码文件。本需求不需要 `client/`。

## 二、插件：去抖 / 合并设计（核心）

### 为什么不能直接监听 `agent.turn_ended`

`agent.turn_ended` 在**每一轮**结束时都会触发：用户每发一条消息、agent 每完成一轮都会有一次。
它 **不等于**「整个任务真正跑完」。

Paseo 内置的「任务完成」语义在 `checkAndSetAttention()`（`agent-manager.ts:4993`）：agent 状态从
`running → idle` 时才记 `attentionReason: "finished"`。插件侧的 `turn_ended` 比它更频繁。

因此插件必须自己做**按 agent 隔离的静默窗口去抖**：

### 状态机（每 agentId 一份）

```
turn_ended(completed) ──► 重置静默窗口定时器(t=0)
                             │
        ┌────────────────────┴────────────────────┐
        │ 窗口内收到 turn_started                   │ 窗口到期(静默 D 秒)
        ▼                                          ▼
   取消待发通知，回到 idle                    判定「真正完成」→ 发通知
```

- `turn_ended` 且 `outcome.kind === "completed"`：**不立即发**，重置该 agent 的定时器（窗口 `quietWindowMs`，默认 15000，可配）。
- 窗口内再收到同一 agent 的 `turn_started`：说明任务还在继续，**取消**本次待发通知。
- 窗口安静结束（期间无新活动）：判定真正完成 → 发 `agent.finished`。
- 再收到新的 `turn_ended(completed)`：再次进入窗口（合并连续轮次）。
- `outcome.kind === "canceled"`：默认忽略。
- `outcome.kind === "failed"`：默认通知（属需人介入），可用 `notifyOnFailure` 关闭。
- `parentAgentId !== null`（子 agent）：默认忽略，可用 `notifySubagents` 打开，避免 subagent 乱发。

### 审批（立即、幂等）

- `agent.permission_requested`：**立即**发 `agent.permission_requested`。
- 用 `event.request.id` 去重，同一请求只发一次。
- 收到 `agent.permission_resolved` **不发**任何通知（按需求）。

### 并发 / 幂等 / 失败

- 去抖状态以 `Map<agentId, {timer, ...}>` 隔离，多 agent 并行互不影响。
- 通知发送失败（网络）只 `console.error`，不让插件崩溃；可选一次轻量重试。
- 所有定时器在 contribution cleanup 中清除。

### 可测试性

去抖器接受注入的 `schedule`/`cancelSchedule`（或 `clock`），测试里用假时钟手动推进，
**不依赖 sleep/真实计时**，覆盖：`turn_ended→turn_started 取消`、窗口到期才发、连续轮次合并、
审批幂等、子 agent 忽略。

## 三、配置项（settings）

用 `shared/settings.ts` 的 `defineSettings` + `server.registerSettings`，server 端 `read()`/`subscribe()`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `gatewayUrl` | `""`（空则不发送并告警） | 网关 POST 目标 |
| `authToken` | `""` | 鉴权 token；也可用环境变量 `PASEO_NOTIFY_AUTH_TOKEN` 覆盖 |
| `quietWindowMs` | `15000` | 静默窗口时长 |
| `notifyOnFailure` | `true` | failed 是否通知 |
| `notifySubagents` | `false` | 子 agent 是否通知 |
| `notifyOnPermission` | `true` | 审批是否通知 |

> 注意：settings 文档是 daemon 主机上的明文 JSON，**不是凭据保险库**。token 也支持环境变量覆盖；
> 任何密钥都不写进代码。

## 四、通知 payload（插件 → 网关）

```jsonc
{
  "source": "paseo-notify",
  "type": "agent.finished" | "agent.permission_requested",
  "agentId": "…",
  "agentTitle": "…",
  "workspaceId": "…",
  "provider": "…",
  "cwd": "/abs/path",
  "reason": "finished" | "failed" | "permission",
  "preview": "末条助手消息纯文本摘要（≤220 字）",
  "timestamp": "2026-10-16T…Z"
}
```

## 五、传输选型对比（待你确认）

约束：手表要**出声 + 震动**；要一个**通用接收 App**（带 `source` 字段，未来可复用）。

| 维度 | A. 自建最小 APNs 中继 + 自研 App | B. Bark（自建或官方） | C. ntfy.sh | D. 自建长连接 |
| --- | --- | --- | --- | --- |
| 架构 | 插件 → 网关(APNs key) → APNs → 设备 → 接收 App | 插件 → Bark 服务 → APNs → Bark iOS App →(镜像)→ Watch | 插件 → ntfy → (iOS 需上游 ntfy.sh) → App →(镜像)→ Watch | 插件 → 长连接 → Watch App |
| 需自建服务器 | 需要（小，可 Serverless/Worker） | 可选（官方可不建；自建 Docker/Worker） | 可选（但 iOS 自建仍需转发上游） | 需要（含常驻连接） |
| Apple 开发者账号/证书 | **需要**（$99/年 + APNs Key + push 能力） | **不需要**（用 Bark 已签名 App；自建服务也不需要） | 不需要 | 需要 |
| 手表震动可靠性 | 高（系统通知即出声+震动；critical alert 可穿透静音但需 Apple 审批） | 高（iOS 通知默认镜像到 Watch，出声+震动） | 中/低（iOS App 可靠性问题多，且依赖镜像） | **低**：watchOS 后台不允许稳定长连接，无法唤醒手表告警 |
| 实现复杂度 | 高（服务 + iOS + watchOS + 签名） | 低 | 低 | 高且效果差 |
| 是否你的自有 App | **是**（通用接收器） | 否（用 Bark 的 App） | 否 | 是 |
| 隐私（是否过第三方） | 最佳，仅经 Apple | 官方服务可见内容（可开 E2E 加密/自建消除） | iOS 路径上仍需第三方上游 | 最佳 |
| 成本 | $99/年 + 托管 | 0（自建仅托管） | 0 | $99/年 + 托管 |

### 决策（已定）

**选定方案 A（自建最小 APNs 中继 + 自研接收 App），手表 App 形态 Form 2（iPhone 伴侣 App + watchOS 接收 App）。**

- 唯一能同时满足「自有 App + 高可靠出声/震动 + 不经第三方」的路。
- 用户**已具备** Apple Developer Program 账号（$99/年），故账号门槛不构成限制。
- 需自建一个小网关（`services/gateway`，可 Serverless/Worker），持有 APNs Key。
- 设备端：iPhone 伴侣 App 注册 APNs、接收推送，经镜像 / WatchConnectivity 送达 Watch。Apple 推荐且最可靠。

**用户需在 Apple 后台完成的操作**（`Certificates, Identifiers & Profiles`）：

1. Identifiers → App IDs：为 iPhone App 与 watchOS App 各注册一个 Bundle ID，均勾选 Push Notifications。
2. Keys → **+** → 勾选 **Apple Push Notifications service (APNs)** → 生成并下载 `.p8`（仅能下载一次），记下 **Key ID**。
3. Membership details → 记下 **Team ID**。

运行时向网关注入：`.p8` 路径、Key ID、Team ID、各 App 的 Bundle ID（`apns-topic`）。全部走环境变量/运行时配置，不写进代码、不提交仓库。

其余方案（B Bark / C ntfy / D 自建长连接）对比见下方表格，保留作背景参考。

### 手表 App 形态（待你确认）

- **Form 1：独立 watchOS App**。Watch 自己注册 APNs token（需 Wi-Fi/蜂窝联网）。设备端最简，但 Watch-only 推送有可靠性注意点。
- **Form 2：iPhone 伴侣 App + watchOS 接收 App**（Apple 推荐）。伴侣收推送，经 WatchConnectivity/镜像送达 Watch，最可靠。

## 六、执行状态

1. ✅ **Paseo 插件**已实现并自测：`packages/plugin` typecheck 通过、33 个单测全绿；已 `paseo plugin install` 并 `running`。
2. ✅ **网关**`services/gateway` 已实现并自测：typecheck 通过、15 个单测全绿、`tsc` 构建通过。
3. ✅ **iOS + watchOS App**`apps/` 源码与 XcodeGen 工程定义已就绪，模拟器 `xcodebuild` 构建成功；真机运行需用户 Apple 账号签名。
4. 全程使用 `paseo plugin reload paseo-notify`，未重启主 daemon。
