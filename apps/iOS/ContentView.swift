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

          HStack {
            Button {
              settings.generateToken()
            } label: {
              Label(L10n.t("Generate", "生成"), systemImage: "wand.and.stars")
            }
            Spacer()
            Button {
              UIPasteboard.general.string = settings.deviceToken
              settings.statusMessage = L10n.t("Copied to clipboard.", "已复制到剪贴板。")
            } label: {
              Label(L10n.t("Copy", "复制"), systemImage: "doc.on.doc")
            }
            .disabled(settings.deviceToken.isEmpty)
          }
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
                "1. Tap Generate, then Copy, and paste the secret into the Paseo plugin settings.",
                "① 点「生成」，再点「复制」，把密钥粘贴到 Paseo 插件的设置里。"
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
      }
      .navigationTitle("Paseo Watch Notify")
    }
  }
}
