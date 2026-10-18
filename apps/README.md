# Paseo Watch Notify 接收 App（iOS + watchOS）

两个 target，由 XcodeGen 从 `project.yml` 生成：

| Target | 平台 | Bundle ID（占位） | 作用 |
| --- | --- | --- | --- |
| `PaseoNotify` | iOS | `com.example.paseonotify` | iPhone 伴侣 App：申请通知权限、拿 APNs device token、注册到网关。iOS 自动把通知镜像到配对的 Apple Watch |
| `PaseoNotify Watch App` | watchOS | `com.example.paseonotify.watchkitapp` | 通用接收 App：收到通知即出声 + 震动（App 在前台时额外触发 `WKInterfaceDevice` 触觉） |

形态为 **Form 2**（iPhone 伴侣 + watchOS 接收 App），Apple 推荐，镜像送达最可靠。

> 下面所有 `com.example.*` 都是**占位符**，请替换成你自己的域名反写（例如 `com.yourname.paseonotify`）。
> 替换后要保持一致的地方：`project.yml` 的两个 Bundle ID，以及网关的 `APNS_TOPIC`。

---

## 一、用户需在 Apple 后台完成的操作

登录 Apple Developer → Certificates, Identifiers & Profiles。（你已具备 Apple Developer Program 账号，无需再注册。）

1. 注册两个 App ID（Identifiers → App IDs → 加号）
   - iOS App：Bundle ID `com.example.paseonotify`
   - watchOS App：Bundle ID `com.example.paseonotify.watchkitapp`
   - 两者都勾选 Push Notifications 能力。
2. 生成 APNs Key 与 Key ID（Keys → 加号）
   - 勾选 Apple Push Notifications service (APNs) → Continue → Register。
   - 下载 `.p8`（只能下载一次，务必保存），记下 Key ID。
3. 记下 Team ID（Membership details → Team ID）。

这些值只填入网关的运行时环境变量（见 `services/gateway/.env.example`），绝不写进代码或提交仓库。

---

## 二、生成并打开工程

```bash
cd apps
xcodegen generate            # 由 project.yml 生成 PaseoNotify.xcodeproj
open PaseoNotify.xcodeproj
```

（未安装 XcodeGen 时：`brew install xcodegen`。也可不用它，手工在 Xcode 里新建 iOS App + watchOS App。）

在 Xcode 中：

1. 项目 → 每个 target 的 Signing & Capabilities：设置你的 Team；确认 iOS target 具备 Push Notifications 能力。
2. 把两个 target 的 Bundle Identifier 从 `com.example.*` 改成你自己的，并同步更新网关的 `APNS_TOPIC`。
3. 选择真机运行（Push 只能在真机上验证，模拟器收不到 APNs 推送）。

---

## 三、配置与验证

1. 启动网关（见 `services/gateway/README.md`），拿到 Gateway URL 与 token。
2. 在 iPhone App 里填入 **Gateway URL** 与 **Device registration token**（网关的 `PASEO_NOTIFY_DEVICE_TOKEN`）。
3. iPhone App 启动后会自动注册 device token（首次需允许通知权限）。
4. 端到端验证：
   - 在 Paseo 侧设置页点 **Send test**（或让 agent 完成/请求审批）。
   - 网关收到 POST 后经 APNs 推到 iPhone，iOS 镜像到 Apple Watch → 手表出声 + 震动。

## 四、模拟器自测（不需要 Apple 账号 / 真机）

模拟器收不到**真实** APNs，但可以本地喂一条，验证 App 的通知呈现。全流程可 headless 完成：

```bash
cd apps && xcodegen generate

# 1) 用 UI 测试自动点掉权限弹窗（首次需要，UI 测试会替你点「允许」）
xcodebuild test -project PaseoNotify.xcodeproj -scheme PaseoNotify \
  -destination "id=<iPhone 模拟器 UDID>" CODE_SIGNING_ALLOWED=NO

# 2) 推一条模拟通知
xcrun simctl push <UDID> com.example.paseonotify apps/Payload.sample.apns
# 也可以在模拟器窗口里直接把这个 .apns 文件拖进去
```

预期：出现横幅，标题形如 `Fix the bug finished`，正文为 payload 的 `preview`。

说明：

- 未签名的模拟器构建里，`registerForRemoteNotifications` 会报「找不到 aps-environment 授权字符串」。
  这是**正常的**：模拟器不需要 device token 也能用 `simctl push`。真机签名后该调用会正常拿到 token。
- 想测手表（watchOS 模拟器），手表 App 设为可独立运行，可直接推送：
  ```bash
  WATCH=<Apple Watch 模拟器 UDID>
  xcrun simctl boot "$WATCH"
  xcrun simctl install "$WATCH" ~/Library/Developer/Xcode/DerivedData/PaseoNotify-*/Build/Products/Debug-watchsimulator/PaseoNotify.app
  # 首次用 UI 测试自动点掉权限弹窗
  xcodebuild test -project PaseoNotify.xcodeproj -scheme "PaseoNotify Watch App" \
    -destination "id=$WATCH" CODE_SIGNING_ALLOWED=NO
  # 直接推给手表 App
  xcrun simctl push "$WATCH" com.example.paseonotify.watchkitapp apps/Payload.sample.apns
  ```

  说明：模拟器里**直接推给手表 App**（`watchkitapp` bundle id）最可靠；模拟器不模拟 iOS→Watch 的通知镜像。
  真机上则是推给 **iPhone**（`apns-topic` = iOS Bundle ID），由 iOS 镜像到手表。
  模拟器无法验证声音/触觉（没有物理马达与音频设备语义），这两项需真机确认；代码里已在
  `ExtensionDelegate.willPresent` 显式触发 `WKInterfaceDevice.play(.notification)`。

## 五、当前最终形态（方案 A：只推手表）

- **手表直接接收推送**：watch App 自己调 `WKApplication.registerForRemoteNotifications()` 拿到手表专属
  APNs token，注册到网关（`topic = com.romejiang.paseonotify.watchkitapp`）。网关直推手表，
  **不依赖 iPhone 是否锁屏**，也不需要 iPhone 在场。
- **iPhone App 只是配置面板**：它**不申请通知、不注册 token**，只负责输入网关地址/渠道密钥，
  并通过 WatchConnectivity 同步给手表。云端因此只有手表一条设备记录，**手机永远不会响**。
- **中英文界面**：手机与手表界面都跟随**系统语言**（系统中文→中文，否则英文）。
- 网关地址 + 渠道密钥在 iPhone App 里填，手表自动同步；手表界面会显示注册状态。

### 硬限制（Apple 层面，无法绕过）

- Apple Watch 必须和一台 iPhone 配对才能使用（但**通知路径不经过手机**）。
- 手表必须有网络（Wi-Fi 或蜂窝）才能收到推送；纯 Wi-Fi 手表不在已知 Wi-Fi、又离手机很远时收不到。
- 出声/震动按手表设置生效（静音模式/触觉设置会影响）；需要穿透静音得用 critical alert（需 Apple 审批）。
- **通知音可以区分**：watch App 包里放了 `paseo-permission.wav`（审批，三声上行）和 `paseo-finished.wav`（完成，两声下行），
  网关按事件类型写 `aps.sound`。实测 watchOS 会播放自定义通知音（音频文件必须在手表 App 包内）。
- **震动无法自定义**：后台远程通知的触觉由系统决定，没有 API。
- **醒目程度可以区分**：审批用 `interruption-level: time-sensitive`（可穿透专注模式），完成用 `active`。

### 没有采用的做法

- **自建长连接让手表 App 监听**：不可行。watchOS 不允许 App 在后台维持长连接/被 socket 唤醒，
  后台能可靠唤醒手表的只有系统级推送（APNs）。所以「自建推送服务」这件事本身就是网关 + APNs 这套。
- **镜像（iPhone→Watch）**：只有在 iPhone 锁屏时才触发，不满足「任何时候手表都要响」，已弃用为主路径。
