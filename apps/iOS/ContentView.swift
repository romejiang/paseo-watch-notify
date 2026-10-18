import SwiftUI
import UIKit

struct ContentView: View {
  @EnvironmentObject private var settings: AppSettings

  var body: some View {
    NavigationStack {
      Form {
        Section(L10n.t("Gateway", "网关")) {
          // Plain TextField (no .keyboardType(.URL)) so the system lets you use your own
          // input method (e.g. 微信输入法) and paste a long URL comfortably.
          TextField("https://gateway.example", text: $settings.gatewayURL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()

          TextField(L10n.t("Channel secret", "渠道密钥"), text: $settings.deviceToken)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()

          Button {
            settings.generateToken()
          } label: {
            Label(L10n.t("Generate secret", "生成密钥"), systemImage: "wand.and.stars")
          }

          Button {
            UIPasteboard.general.string = settings.configText
            settings.statusMessage = L10n.t(
              "Copied the gateway URL and secret. Paste both into the Paseo plugin.",
              "已复制网关地址和密钥。请把它们粘贴到 Paseo 插件设置里。"
            )
          } label: {
            Label(L10n.t("Copy config (URL + secret)", "复制配置（地址 + 密钥）"), systemImage: "doc.on.doc")
          }
          .disabled(settings.deviceToken.isEmpty)

          Button {
            Task { await settings.selectReachableGateway() }
          } label: {
            Label(
              settings.isProbing
                ? L10n.t("Checking gateways…", "正在检测网关…")
                : L10n.t("Re-check gateway", "重新检测网关"),
              systemImage: "antenna.radiowaves.left.and.right"
            )
          }
          .disabled(settings.isProbing)
        }

        Section(L10n.t("Apple Watch", "Apple Watch")) {
          Button {
            settings.pushToWatch()
          } label: {
            Label(L10n.t("Sync to Apple Watch", "同步到 Apple Watch"), systemImage: "arrow.up.circle")
          }

          Text(settings.statusMessage)
            .font(.footnote)
            .foregroundStyle(.secondary)
        }

        Section {
          VStack(alignment: .leading, spacing: 6) {
            Text(L10n.t("How to set up", "设置步骤"))
              .font(.footnote)
              .fontWeight(.semibold)
            Text(
              L10n.t(
                "1. Tap “Copy config”, then paste the gateway URL and secret into the Paseo plugin settings.",
                "① 点「复制配置」，把网关地址和密钥粘贴到 Paseo 插件的设置里。"
              )
            )
            Text(
              L10n.t(
                "2. Tap Sync to Apple Watch to send the gateway address and secret to your watch.",
                "② 点「同步到 Apple Watch」，把网关地址和密钥同步到手表。"
              )
            )
          }
          .font(.footnote)
          .foregroundStyle(.secondary)
        }

        Section {
          Text(
            L10n.t(
              "This iPhone does not receive notifications. The Apple Watch gets them directly. The app picks a reachable gateway automatically; paste the same URL into the plugin.",
              "这台 iPhone 不接收通知，提醒由 Apple Watch 直接接收。App 会自动选择可用的网关；请把同一个地址粘贴到插件里。"
            )
          )
          .font(.footnote)
          .foregroundStyle(.secondary)
        }
      }
      .navigationTitle("Paseo Watch Notify")
      .task {
        await settings.selectReachableGateway()
      }
    }
  }
}
