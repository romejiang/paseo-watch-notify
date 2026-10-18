import XCTest

/// Taps the watchOS notification-permission alert so the watch simulator run is fully headless.
final class WatchNotificationPermissionUITests: XCTestCase {
  func testGrantNotificationPermission() {
    let app = XCUIApplication()
    app.launch()

    let candidates = ["允许", "Allow", "好", "OK"]
    let hosts = ["com.apple.springboard", "com.apple.Carousel"]

    let deadline = Date().addingTimeInterval(20)
    while Date() < deadline {
      for host in hosts {
        let system = XCUIApplication(bundleIdentifier: host)
        for label in candidates {
          let button = system.buttons[label]
          if button.exists && button.isHittable {
            button.tap()
            return
          }
        }
      }
      usleep(300_000)
    }

    XCTFail("watchOS notification permission alert never appeared")
  }
}
