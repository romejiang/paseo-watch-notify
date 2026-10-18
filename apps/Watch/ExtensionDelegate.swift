import WatchKit
import UserNotifications
import WatchConnectivity
import OSLog

/// Universal notification receiver.
///
/// Registers this Apple Watch **directly** with APNs so the gateway can push straight to the wrist,
/// independent of the iPhone. Sound and haptic come from the delivered alert notification; the
/// delegate also plays an explicit haptic when the app is in the foreground.
final class WatchAppDelegate: NSObject, WKApplicationDelegate, UNUserNotificationCenterDelegate {
  private let logger = Logger(subsystem: "com.romejiang.paseonotify.watchkitapp", category: "watch")
  private let bridge = WatchBridge.shared

  func applicationDidFinishLaunching() {
    UNUserNotificationCenter.current().delegate = self
    bridge.activate()
    requestAuthorization()
  }

  private func requestAuthorization() {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, error in
      if let error {
        Logger(subsystem: "com.romejiang.paseonotify.watchkitapp", category: "watch")
          .error("authorization failed: \(error.localizedDescription)")
      }
      guard granted else {
        WatchBridge.shared.setStatus(L10n.t("Notification permission is off.", "通知权限未开启。"))
        return
      }
      DispatchQueue.main.async {
        WKApplication.shared().registerForRemoteNotifications()
      }
    }
  }

  // MARK: - Direct APNs registration for this watch

  func didRegisterForRemoteNotifications(withDeviceToken deviceToken: Data) {
    let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
    logger.info("watch APNs device token received")
    bridge.registerWatch(deviceToken: hex)
  }

  func didFailToRegisterForRemoteNotificationsWithError(_ error: Error) {
    logger.error("watch APNs registration failed: \(error.localizedDescription)")
    bridge.setStatus(
      L10n.t("APNs registration failed: ", "APNs 注册失败：") + error.localizedDescription
    )
  }

  // MARK: - Presentation

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    WKInterfaceDevice.current().play(.notification)
    return [.banner, .sound]
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse
  ) async {
    WKInterfaceDevice.current().play(.click)
  }
}

/// Receives gateway configuration from the paired iPhone and registers this watch's APNs token.
final class WatchBridge: NSObject, WCSessionDelegate {
  static let shared = WatchBridge()

  /// The watch app's own APNs topic (its Bundle ID).
  private static let watchTopic = "com.romejiang.paseonotify.watchkitapp"

  private enum Keys {
    static let gatewayURL = "gatewayURL"
    static let deviceToken = "deviceToken"
    static let apnsToken = "apnsToken"
    static let status = "statusMessage"
  }

  private let logger = Logger(subsystem: "com.romejiang.paseonotify.watchkitapp", category: "bridge")
  private var pendingDeviceToken: String?

  private static let session: URLSession = {
    let configuration = URLSessionConfiguration.default
    configuration.timeoutIntervalForRequest = 20
    configuration.timeoutIntervalForResource = 30
    configuration.waitsForConnectivity = false
    return URLSession(configuration: configuration)
  }()

  func activate() {
    guard WCSession.isSupported() else {
      return
    }
    let session = WCSession.default
    session.delegate = self
    session.activate()
  }

  /// Persist the status so the SwiftUI view can show it via @AppStorage.
  func setStatus(_ message: String) {
    UserDefaults.standard.set(message, forKey: Keys.status)
  }

  // MARK: - WCSessionDelegate

  func session(
    _ session: WCSession,
    activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) {
    apply(session.receivedApplicationContext)
  }

  func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
    apply(applicationContext)
  }

  private func apply(_ context: [String: Any]) {
    if let url = context["gatewayURL"] as? String {
      UserDefaults.standard.set(url, forKey: Keys.gatewayURL)
    }
    if let token = context["deviceToken"] as? String {
      UserDefaults.standard.set(token, forKey: Keys.deviceToken)
    }
    // Config changed (e.g. a new channel secret): re-register under the new channel.
    if let apns = UserDefaults.standard.string(forKey: Keys.apnsToken) {
      post(token: apns)
    } else if let pending = pendingDeviceToken {
      pendingDeviceToken = nil
      post(token: pending)
    }
  }

  // MARK: - Registration

  func registerWatch(deviceToken: String) {
    UserDefaults.standard.set(deviceToken, forKey: Keys.apnsToken)
    guard UserDefaults.standard.string(forKey: Keys.gatewayURL)?.isEmpty == false else {
      // Config has not synced from the iPhone yet; retry once it arrives.
      pendingDeviceToken = deviceToken
      setStatus(L10n.t("Waiting for the iPhone to sync settings…", "等待 iPhone 同步网关配置…"))
      return
    }
    post(token: deviceToken)
  }

  private func post(token: String) {
    guard let url = devicesURL() else {
      setStatus(L10n.t("Invalid gateway URL.", "网关地址无效。"))
      return
    }
    setStatus(L10n.t("Registering…", "正在注册…"))
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    let bearer = UserDefaults.standard.string(forKey: Keys.deviceToken)?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !bearer.isEmpty {
      request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
    }
    request.httpBody = try? JSONSerialization.data(withJSONObject: [
      "token": token,
      "platform": "watch",
      "topic": Self.watchTopic,
      "environment": environment,
    ])

    Self.session.dataTask(with: request) { [weak self] data, response, error in
      guard let self else { return }
      if let error {
        self.setStatus(L10n.t("Registration failed: ", "注册失败：") + error.localizedDescription)
        return
      }
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      if (200..<300).contains(status) {
        self.setStatus(L10n.t("Registered ✓ ", "已注册 ✓ ") + "(\(token.prefix(8))…)")
      } else {
        let detail = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        self.setStatus(L10n.t("Registration failed: HTTP ", "注册失败：HTTP ") + "\(status) \(detail)")
      }
    }.resume()
  }

  private var environment: String {
    #if DEBUG
    return "development"
    #else
    return "production"
    #endif
  }

  private func devicesURL() -> URL? {
    guard var base = UserDefaults.standard.string(forKey: Keys.gatewayURL)?
      .trimmingCharacters(in: .whitespacesAndNewlines), !base.isEmpty else {
      return nil
    }
    while base.hasSuffix("/") {
      base.removeLast()
    }
    if base.hasSuffix("/api/notify") {
      base.removeLast("/api/notify".count)
    }
    let urlString = base.hasSuffix("/api/devices") ? base : base + "/api/devices"
    return URL(string: urlString)
  }
}
