import UIKit

/// The iPhone app is now only a **configuration panel**: it never registers for remote
/// notifications. It simply hands the gateway URL and channel secret to the paired Apple Watch,
/// which receives the notifications directly.
final class AppDelegate: NSObject, UIApplicationDelegate {
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    PhoneSessionManager.shared.activate()
    return true
  }
}
