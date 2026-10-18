import SwiftUI

/// Tiny runtime localization: zh-Hans when the user's preferred language is Chinese, else English.
enum L10n {
  static let isChinese: Bool = {
    let preferred = Locale.preferredLanguages.first ?? Locale.current.identifier
    return preferred.lowercased().hasPrefix("zh")
  }()

  static func t(_ english: String, _ chinese: String) -> String {
    isChinese ? chinese : english
  }
}

struct WatchContentView: View {
  @AppStorage("statusMessage") private var status: String = L10n.t("Starting…", "正在初始化…")

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        Image(systemName: "bell.badge")
          .font(.title2)
          .foregroundStyle(.tint)
        Text("Paseo Watch Notify")
          .font(.headline)
        Text(status)
          .font(.footnote)
          .foregroundStyle(.secondary)
        Text(
          L10n.t(
            "This watch receives notifications directly and plays sound + haptic. It does not depend on the iPhone being locked.",
            "这台手表直接接收通知并出声 + 震动，不依赖 iPhone 是否锁屏。"
          )
        )
        .font(.caption2)
        .foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 4)
    }
  }
}
