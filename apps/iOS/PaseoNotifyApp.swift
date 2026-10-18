import SwiftUI

@main
struct PaseoNotifyApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @StateObject private var settings = AppSettings.shared

  var body: some Scene {
    WindowGroup {
      ContentView()
        .environmentObject(settings)
    }
  }
}
