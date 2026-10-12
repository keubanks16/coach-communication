import Foundation
import Security

struct Credentials: Codable {
    let id: String
    let token: String
    let role: String
}

struct CoachMessage: Codable, Identifiable {
    let id: String
    let senderID: String
    let recipientID: String
    let senderRole: String
    let text: String
    let createdAt: String
    let expiresAt: String
    let receivedAt: String?
    let acknowledgedAt: String?
    let pushStatus: String

    var expired: Bool { Self.date(expiresAt) <= Date() }
    static func date(_ value: String) -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? .distantPast
    }
    var status: String {
        if acknowledgedAt != nil { return "Got it ✓" }
        if expired { return "Expired" }
        if receivedAt != nil { return "Received" }
        return "Sent · awaiting receipt"
    }
}

struct MessageFeed: Decodable {
    let messages: [CoachMessage]
    let peerRole: String?
    let peerLastSeen: String?
    let pushReady: Bool
}

enum CredentialVault {
    static let service = "CoachCommunication"
    static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: "watch"]
    }
    static func read() -> Credentials? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(Credentials.self, from: data)
    }
    static func save(_ credentials: Credentials) throws {
        let data = try JSONEncoder().encode(credentials)
        let update = [kSecValueData as String: data]
        let existing = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if existing == errSecSuccess { return }
        guard existing == errSecItemNotFound else { throw VaultError() }
        var request = query
        request[kSecValueData as String] = data
        request[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(request as CFDictionary, nil) == errSecSuccess else { throw VaultError() }
    }
    static func clear() { SecItemDelete(query as CFDictionary) }
    struct VaultError: LocalizedError {
        var errorDescription: String? { "Could not securely save pairing. Try again." }
    }
}
