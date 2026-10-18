import Foundation
import OSLog

/// Posts this device's APNs token to the gateway so the relay knows where to deliver.
struct DeviceRegistrar {
  static let shared = DeviceRegistrar()

  private let logger = Logger(subsystem: "com.romejiang.paseonotify", category: "registrar")

  /// Short timeouts so a bad URL or unreachable host fails visibly instead of hanging.
  private static let session: URLSession = {
    let configuration = URLSessionConfiguration.default
    configuration.timeoutIntervalForRequest = 15
    configuration.timeoutIntervalForResource = 30
    configuration.waitsForConnectivity = false
    return URLSession(configuration: configuration)
  }()

  enum RegistrationError: LocalizedError {
    case missingConfiguration
    case invalidURL
    case http(Int, String)

    var errorDescription: String? {
      switch self {
      case .missingConfiguration:
        return "Set the gateway URL in the app first."
      case .invalidURL:
        return "The gateway URL is not a valid URL."
      case let .http(status, detail):
        return "Gateway returned HTTP \(status)\(detail.isEmpty ? "" : ": \(detail)")"
      }
    }
  }

  /// APNs environment this build's token belongs to.
  private var environment: String {
    #if DEBUG
    return "development"
    #else
    return "production"
    #endif
  }

  /// Accepts the base URL, the plugin URL (`…/api/notify`), or the device URL (`…/api/devices`)
  /// and always returns the device-registration endpoint.
  private func devicesURL(from raw: String) throws -> URL {
    var base = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    while base.hasSuffix("/") {
      base.removeLast()
    }
    if base.hasSuffix("/api/notify") {
      base.removeLast("/api/notify".count)
    }
    let urlString = base.hasSuffix("/api/devices") ? base : base + "/api/devices"
    guard let url = URL(string: urlString), url.scheme != nil else {
      throw RegistrationError.invalidURL
    }
    return url
  }

  func register(token: String) async throws {
    let settings = await AppSettings.shared
    let base = await settings.gatewayURL
    let bearer = await settings.deviceToken.trimmingCharacters(in: .whitespacesAndNewlines)

    guard !base.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw RegistrationError.missingConfiguration
    }
    let url = try devicesURL(from: base)

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if !bearer.isEmpty {
      request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
    }
    request.httpBody = try JSONSerialization.data(withJSONObject: [
      "token": token,
      "platform": "ios",
      "environment": environment,
    ])

    let (data, response) = try await Self.session.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw RegistrationError.invalidURL
    }
    guard (200..<300).contains(http.statusCode) else {
      let detail = String(data: data, encoding: .utf8) ?? ""
      throw RegistrationError.http(http.statusCode, detail)
    }
    logger.info("Registered device token with gateway")
  }
}
