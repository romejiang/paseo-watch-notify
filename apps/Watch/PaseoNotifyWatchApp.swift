import SwiftUI

@main
struct PaseoNotifyWatchApp: App {
  @WKApplicationDelegateAdaptor(WatchAppDelegate.self) private var appDelegate

  var body: some Scene {
    WindowGroup {
      WatchContentView()
    }
  }
}
