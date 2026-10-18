import SwiftUI
import WatchConnectivity
import Security
import OSLog

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

/// Gateway connection settings. The phone persists them and pushes them to the watch; it never
/// registers for notifications itself.
@MainActor
final class AppSettings: ObservableObject {
  static let shared = AppSettings()

  /// Default public gateway. Pre-filled so users normally do not have to type anything.
  static let defaultGatewayURL = "https://notify.romejiang.top"

  private enum Keys {
    static let gatewayURL = "gatewayURL"
    static let deviceToken = "deviceToken"
  }

  @Published var gatewayURL: String {
    didSet {
      UserDefaults.standard.set(gatewayURL, forKey: Keys.gatewayURL)
      pushToWatch(showStatus: false)
    }
  }

  @Published var deviceToken: String {
    didSet {
      UserDefaults.standard.set(deviceToken, forKey: Keys.deviceToken)
      pushToWatch(showStatus: false)
    }
  }

  @Published var statusMessage: String = L10n.t(
    "Tap “Sync to Apple Watch” to send these settings to your watch.",
    "点「同步到 Apple Watch」把配置发送到手表。"
  )

  private init() {
    if let stored = UserDefaults.standard.string(forKey: Keys.gatewayURL) {
      gatewayURL = stored
    } else {
      gatewayURL = Self.defaultGatewayURL
    }
    deviceToken = UserDefaults.standard.string(forKey: Keys.deviceToken) ?? ""
  }

  /// A fresh random channel secret shared by the plugin, phone, and watch.
  static func generateChannelSecret() -> String {
    var bytes = [UInt8](repeating: 0, count: 24)
    if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess {
      return "pn_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }
    return "pn_" + bytes.map { String(format: "%02x", $0) }.joined()
  }

  /// Generate a new secret, keep it, and push it to the watch.
  func generateToken() {
    deviceToken = Self.generateChannelSecret()
    statusMessage = L10n.t(
      "New secret generated and sent to the Apple Watch. Copy it into the Paseo plugin.",
      "已生成新密钥并发送到手表。请把它复制到 Paseo 插件里。"
    )
  }

  /// Share the gateway config with the paired watch so it can register its own APNs token.
  func pushToWatch(showStatus: Bool = true) {
    let sent = PhoneSessionManager.shared.push(gatewayURL: gatewayURL, deviceToken: deviceToken)
    guard showStatus else { return }
    statusMessage =
      sent
      ? L10n.t("Sent to your Apple Watch.", "已发送到 Apple Watch。")
      : L10n.t(
        "Open this app on the Apple Watch, then try again.",
        "请在 Apple Watch 上打开本 App，然后再试一次。"
      )
  }
}

/// Hands the gateway configuration to the paired Apple Watch over WatchConnectivity.
final class PhoneSessionManager: NSObject, WCSessionDelegate {
  static let shared = PhoneSessionManager()

  private let logger = Logger(subsystem: "com.romejiang.paseonotify", category: "watch-session")

  func activate() {
    guard WCSession.isSupported() else {
      return
    }
    let session = WCSession.default
    session.delegate = self
    session.activate()
  }

  @discardableResult
  func push(gatewayURL: String, deviceToken: String) -> Bool {
    guard WCSession.isSupported() else {
      return false
    }
    let session = WCSession.default
    guard session.activationState == .activated else {
      return false
    }
    do {
      try session.updateApplicationContext([
        "gatewayURL": gatewayURL,
        "deviceToken": deviceToken,
      ])
      return true
    } catch {
      logger.error("Failed to send config to watch: \(error.localizedDescription)")
      return false
    }
  }

  func session(
    _ session: WCSession,
    activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) {
    Task { @MainActor in
      AppSettings.shared.pushToWatch(showStatus: false)
    }
  }

  func sessionDidBecomeInactive(_ session: WCSession) {}

  func sessionDidDeactivate(_ session: WCSession) {
    session.activate()
  }
}
