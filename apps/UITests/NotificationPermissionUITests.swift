import XCTest

/// Taps the system notification-permission alert so the simulator run is fully headless.
/// This is a test-only helper: it grants permission once, then the shell can send a simulated push.
final class NotificationPermissionUITests: XCTestCase {
  func testGrantNotificationPermission() {
    let app = XCUIApplication()
    app.launch()

    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let candidates = ["允许", "Allow", "好", "OK"]

    let deadline = Date().addingTimeInterval(15)
    while Date() < deadline {
      for label in candidates {
        let button = springboard.buttons[label]
        if button.exists && button.isHittable {
          button.tap()
          return
        }
      }
      // The alert may be nested under alerts/scrollViews.
      for label in candidates {
        let button = springboard.alerts.buttons[label]
        if button.exists {
          button.tap()
          return
        }
      }
      usleep(300_000)
    }

    XCTFail("Notification permission alert never appeared")
  }
}
