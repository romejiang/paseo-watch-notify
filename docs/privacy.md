# Privacy Policy — Paseo Watch Notify

Last updated: 2026-10-18

Paseo Watch Notify delivers notifications to an Apple Watch when a Paseo agent finishes a task or
needs a decision. This policy describes what the apps and the plugin handle.

## What is collected

- **Channel secret.** You generate a secret in the iOS app and paste the same value into the Paseo
  plugin. It is stored on your own devices (the iPhone app's local storage, and the Paseo daemon's
  settings file) and is sent to the gateway as a bearer token so the gateway can tell users apart.
- **APNs device token.** The Apple Watch app registers with Apple Push Notification service and
  sends the resulting device token to the gateway, together with the watch app's bundle identifier
  and the APNs environment. The gateway stores that token so it can deliver notifications to your
  watch.
- **Notification content.** When a Paseo agent finishes or asks for a permission, the plugin sends
  a small JSON payload to the gateway. It contains the agent id, agent title, workspace id,
  provider, working directory, a short plain-text preview of the agent's last message (or the
  permission request details), and a timestamp. The gateway forwards this content to Apple Push
  Notification service for delivery.

## What is not collected

- No analytics, advertising, tracking, or profiling.
- No account, email address, name, or contact information.
- No access to your photos, contacts, location, microphone, or health data.
- The gateway does not read your source code or files. Only the fields listed above are sent.

## Who receives it

- **The gateway operator** (the developer who runs the configured gateway) receives the payloads
  and stores the device tokens. If you point the plugin at your own gateway, that operator is you.
- **Apple** receives the notification content in order to deliver it through Apple Push
  Notification service.

## Storage and retention

- Device tokens stay in the gateway's registry until they are removed. The gateway deletes tokens
  that Apple reports as no longer valid.
- The secret and the gateway address stay on your devices and in the Paseo daemon's settings file.
- Removing the apps or the plugin removes the local copies. Gateway records for a secret remain
  until they are deleted by the operator.

## Your choices

- You can generate a new secret at any time; the watch re-registers under the new secret.
- You can remove the watch app, the iPhone app, or the plugin to stop notifications.
- You can point the plugin and the apps at your own gateway instead of the default one.

## Security

Traffic to the gateway uses HTTPS. The secret is sent as a bearer token. The secret is stored as
plaintext in the Paseo daemon's settings file, so treat the daemon host as trusted.

## Children

The apps are not directed at children and do not knowingly collect information from them.

## Changes

Material changes to this policy will be published in this repository.

## Contact

Open an issue at https://github.com/romejiang/paseo-watch-notify/issues.

---

# 隐私政策 — Paseo Watch Notify（中文）

本应用在 Paseo 的 agent 完成任务或需要你做决定时，向你的 Apple Watch 发送通知。以下说明各端会处理哪些数据。

**会处理的数据**
- **渠道密钥**：你在 iPhone App 生成、并粘贴到 Paseo 插件。它保存在你自己的设备（App 本地）与 Paseo daemon 的设置文件里，并作为 Bearer token 发给网关，用于区分不同用户。
- **APNs 设备令牌**：手表 App 向 Apple 推送服务注册后，把设备令牌、手表 App 的包名和 APNs 环境发给网关，网关保存它以便向你的手表推送。
- **通知内容**：agent 完成或请求审批时，插件把一小段 JSON 发给网关，包含 agent id、标题、工作区 id、provider、工作目录、末条消息的纯文本摘要（或权限请求详情）和时间戳。网关会把这段内容交给 Apple 推送服务以完成投递。

**不会收集**：不做分析/广告/追踪；不需要账号、邮箱、姓名；不访问照片、通讯录、定位、麦克风、健康数据；不读取你的源码或文件。

**接收方**：网关运营方（运行该网关的开发者）会收到上述内容并保存设备令牌；若你把插件指向自己的网关，运营方就是你本人。Apple 为完成投递会收到通知内容。

**保留与删除**：设备令牌保存在网关注册表中，直到被移除；Apple 报告失效的令牌会被删除。密钥与网关地址保存在你的设备与 daemon 设置里。移除 App 或插件会删除本地副本。

**你的选择**：可随时重新生成密钥（手表会重新注册）；可移除 App 或插件以停止通知；可把插件与 App 指向你自己的网关。

**安全**：到网关的流量使用 HTTPS；密钥以 Bearer token 发送；密钥以明文存于 daemon 设置文件，请将 daemon 主机视为可信。

**联系方式**：https://github.com/romejiang/paseo-watch-notify/issues
