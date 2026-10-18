# Apple 后台与 Xcode 配置教程

目标：拿到网关需要的 4 个值 —— **Team ID、Key ID、`.p8` 文件、Bundle ID（APNs topic）**。

前置：你已具备 **Apple Developer Program** 账号（$99/年）。只有付费账号才能使用 Push Notifications 能力与 APNs Key。

---

## 一、在 Apple Developer 后台操作

打开 <https://developer.apple.com/account> 登录，进入 **Certificates, Identifiers & Profiles**。

### 1. 注册 App ID（Bundle ID）

左侧 **Identifiers** → **App IDs** → 右上 **＋**。

- 选 **App IDs** → **App** → Continue。
- **Description**：随便填，如 `Paseo Watch Notify`。
- **Bundle ID**：选 **Explicit**，填你自己的反写域名，例如 `com.yourname.paseonotify`。
  （`com.example.*` 只是我给的占位符，必须换成你自己的。）
- 往下 **Capabilities**：勾选 **Push Notifications**。
- **Continue** → **Register**。

再重复一次，注册 watchOS 的 App ID：

- Bundle ID 填 `com.yourname.paseonotify.watchkitapp`（在 iOS 的后面加 `.watchkitapp`）。
- 同样勾 **Push Notifications**。

> 说明：Form 2（iPhone 承载推送 + 镜像到手表）下，**实际只需 iOS 那个 App ID 具备 Push**；
> watch 的 App ID 现在勾上也无害，将来改 Form 1（手表自己收推送）时正好用得上。

### 2. 生成 APNs Key（.p8）与 Key ID

左侧 **Keys** → 右上 **＋**。

- **Key Name**：如 `Paseo Watch Notify APNs`。
- 勾选 **Apple Push Notifications service (APNs)**。
- **Continue** → **Register**。
- **Download** 下载 `.p8` 文件（**只能下载一次**，务必妥善保存，并记得 **不要提交进 Git**）。
- 记下页面上的 **Key ID**（10 位，形如 `ABC123DEF4`）。

> 一个 APNs Key 对你团队下**所有** App 都有效，用 `apns-topic`（Bundle ID）区分具体应用，不需要每个 App 建一把。

### 3. 记下 Team ID

右上角你的名字 → **Membership details** → **Team ID**（10 位，形如 `ABCDE12345`）。

### 小结：你要交给网关的值

| 网关环境变量 | 从哪里来 |
| --- | --- |
| `APNS_TEAM_ID` | Membership details 的 Team ID |
| `APNS_KEY_ID` | 生成 Key 时的 Key ID |
| `APNS_KEY_PATH` | 下载下来的 `.p8` 文件路径 |
| `APNS_TOPIC` | iOS App 的 Bundle ID（`com.yourname.paseonotify`） |

---

## 二、在 Xcode 里操作（签名基本全自动）

1. 打开工程：
   ```bash
   cd apps && xcodegen generate && open PaseoNotify.xcodeproj
   ```
2. 左侧选项目 → **TARGETS → PaseoNotify → Signing & Capabilities**：
   - **Team** 选你的账号（这就是 `DEVELOPMENT_TEAM`）。
   - **Bundle Identifier** 改成你注册的 `com.yourname.paseonotify`。
   - 确认/添加 **Push Notifications** 能力（`+ Capability` → Push Notifications）。
     本项目已在 `apps/iOS/PaseoNotify.entitlements` 里声明 `aps-environment`。
3. 对 **PaseoNotify Watch App** target 做同样的事：
   - Team 同上；Bundle Identifier 改成 `com.yourname.paseonotify.watchkitapp`。
4. **证书不用手动创建**：Xcode 的自动签名会替你创建 `Apple Development` 证书与 provisioning profile，
   并把它写进你的钥匙串。你只需登录 Xcode（Xcode → Settings → Accounts 添加 Apple ID）。
5. 跑真机：连接 iPhone，iPhone 上打开 **设置 → 隐私与安全性 → 开发者模式**，然后 Xcode 选你的设备 ⌘R。
   （Push 只能在真机验证，模拟器收不到真实 APNs。）

改完 Bundle ID 之后，记得把网关的 `APNS_TOPIC` 也改成同一个 iOS Bundle ID。

---

## 三、常见坑

- **收不到推送**：`APNS_TOPIC` 与 App 的 Bundle ID 不一致；或用了生产密钥却发给 sandbox（`APNS_ENV`）。
  Xcode Debug 真机安装的 App 拿到的是 **sandbox** token，故网关先设 `APNS_ENV=development`。
- **手机收到但手表没响**：iPhone **Watch App → 通知**里确认镜像开着；手表别处于静音/专注模式；
  手表“设置 → 声音与触感”里音量与触觉要开。
- **想穿透静音**：需要 critical alert，这要 Apple 单独审批该 entitlement，默认不启用。
- **`.p8` 只提示一次下载**：丢了只能重新生成一把 Key。
