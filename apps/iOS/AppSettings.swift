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
///
/// Two gateways exist: a global one (Cloudflare) and a China-mainland one (a self-hosted relay on a
/// filed domain). The app prefers the region default and then probes reachability, because an
/// Apple ID's region does not tell you where the network actually is.
@MainActor
final class AppSettings: ObservableObject {
  static let shared = AppSettings()

  static let globalGatewayURL = "https://notify.romejiang.top"
  static let chinaGatewayURL = "https://notify.everythingisnumber.cn"

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

  @Published var isProbing = false

  private init() {
    if let stored = UserDefaults.standard.string(forKey: Keys.gatewayURL) {
      gatewayURL = stored
    } else {
      gatewayURL = Self.regionDefaultGateway()
    }
    deviceToken = UserDefaults.standard.string(forKey: Keys.deviceToken) ?? ""
  }

  // MARK: - Gateway selection

  private static func regionDefaultGateway() -> String {
    if let region = Locale.current.region?.identifier, region.uppercased() == "CN" {
      return chinaGatewayURL
    }
    return globalGatewayURL
  }

  /// Probe the candidates and keep the first one that answers `/healthz`.
  func selectReachableGateway() async {
    var candidates: [String] = []
    for candidate in [gatewayURL, Self.regionDefaultGateway(), Self.chinaGatewayURL, Self.globalGatewayURL] {
      let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmed.isEmpty && !candidates.contains(trimmed) {
        candidates.append(trimmed)
      }
    }

    isProbing = true
    defer { isProbing = false }

    for candidate in candidates {
      if await Self.isReachable(candidate) {
        if gatewayURL != candidate {
          gatewayURL = candidate
        }
        statusMessage = L10n.t("Gateway reachable: \(candidate)", "网关可用：\(candidate)")
        return
      }
    }
    statusMessage = L10n.t(
      "Neither gateway is reachable. Check your network.",
      "两个网关都连不上，请检查网络。"
    )
  }

  private static let probeSession: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 4
    configuration.timeoutIntervalForResource = 6
    configuration.waitsForConnectivity = false
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    return URLSession(configuration: configuration)
  }()

  private static func isReachable(_ base: String) async -> Bool {
    guard let url = healthURL(from: base) else {
      return false
    }
    var request = URLRequest(url: url)
    request.timeoutInterval = 4
    request.cachePolicy = .reloadIgnoringLocalCacheData
    do {
      let (_, response) = try await probeSession.data(for: request)
      return (response as? HTTPURLResponse)?.statusCode == 200
    } catch {
      return false
    }
  }

  /// Normalize any accepted form (base, `/api/notify`, `/api/devices`) into the health endpoint.
  static func healthURL(from base: String) -> URL? {
    guard var trimmed = Optional(base.trimmingCharacters(in: .whitespacesAndNewlines)), !trimmed.isEmpty else {
      return nil
    }
    while trimmed.hasSuffix("/") {
      trimmed.removeLast()
    }
    if trimmed.hasSuffix("/api/notify") {
      trimmed.removeLast("/api/notify".count)
    }
    if trimmed.hasSuffix("/api/devices") {
      trimmed.removeLast("/api/devices".count)
    }
    return URL(string: trimmed + "/healthz")
  }

  // MARK: - Secret

  /// A fresh random channel secret shared by the plugin, phone, and watch.
  static func generateChannelSecret() -> String {
    var bytes = [UInt8](repeating: 0, count: 24)
    if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess {
      return "pn_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }
    return "pn_" + bytes.map { String(format: "%02x", $0) }.joined()
  }

  func generateToken() {
    deviceToken = Self.generateChannelSecret()
    statusMessage = L10n.t(
      "New secret generated. Copy the configuration into the Paseo plugin.",
      "已生成新密钥。请把配置复制到 Paseo 插件里。"
    )
  }

  /// The gateway URL and secret in one labeled block, ready to paste into the Paseo plugin.
  var configText: String {
    L10n.t(
      "Gateway URL: \(gatewayURL)\nChannel secret: \(deviceToken)",
      "网关地址：\(gatewayURL)\n渠道密钥：\(deviceToken)"
    )
  }

  // MARK: - Watch sync

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
