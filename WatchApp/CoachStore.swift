import Foundation
import Combine
import WatchKit

@MainActor
final class CoachStore: ObservableObject {
    @Published var credentials = CredentialVault.read()
    @Published var messages: [CoachMessage] = []
    @Published var connection = "Connecting…"
    @Published var error: String?
    @Published var busy = false
    @Published var pushReady = false
    @Published var notificationsAllowed = false
    @Published var failedCall: String?
    @Published var endpoint = UserDefaults.standard.string(forKey: "relayURL") ?? ""
    private var failedID: String?
    private var shown = Set<String>()
    private var polling: Task<Void, Never>?
    private var uploadedToken: String?
    private var initialFeed = true
    private var active = false
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 8
        config.timeoutIntervalForResource = 12
        return URLSession(configuration: config)
    }()

    var incoming: CoachMessage? {
        guard let latest = messages.last(where: { $0.recipientID == credentials?.id }),
              !latest.expired, latest.acknowledgedAt == nil else { return nil }
        return latest
    }

    func request(_ path: String, method: String = "GET", body: [String: String]? = nil,
                 authenticated: Bool = true) async throws -> Data {
        guard let base = URL(string: endpoint), base.scheme == "https", base.host != nil,
              base.user == nil, base.password == nil, base.query == nil, base.fragment == nil else {
            throw ClientError("Enter a valid HTTPS relay address.")
        }
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = method
        if authenticated {
            guard let credentials else { throw ClientError("Pair this watch first.") }
            request.setValue("Bearer \(credentials.token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw ClientError("No relay response.") }
        guard (200..<300).contains(response.statusCode) else {
            let detail = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
            throw ClientError(detail ?? "Relay returned \(response.statusCode).")
        }
        return data
    }

    func pair(key: String, role: String) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            endpoint = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
            let data = try await request("v1/pair", method: "POST", body: ["key": key, "role": role], authenticated: false)
            let value = try JSONDecoder().decode(Credentials.self, from: data)
            // Keep the server pairing recoverable if local secure storage fails.
            credentials = value
            do { try CredentialVault.save(value) }
            catch {
                _ = try? await request("v1/device", method: "DELETE")
                credentials = nil
                throw error
            }
            UserDefaults.standard.set(endpoint, forKey: "relayURL")
            initialFeed = true
            if active { startPolling() }
        } catch { self.error = error.localizedDescription }
    }

    func setActive(_ value: Bool) {
        active = value
        if value { startPolling() }
        else { polling?.cancel(); polling = nil; connection = "Paused" }
    }

    private func startPolling() {
        polling?.cancel()
        guard credentials != nil else { return }
        polling = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                do { try await Task.sleep(for: .seconds(2)) }
                catch { break }
            }
        }
    }

    func refresh() async {
        guard credentials != nil else { return }
        do {
            let data = try await request("v1/messages")
            try Task.checkCancellation()
            let feed = try JSONDecoder().decode(MessageFeed.self, from: data)
            messages = feed.messages
            pushReady = feed.pushReady
            if let seen = feed.peerLastSeen {
                connection = Date().timeIntervalSince(CoachMessage.date(seen)) < 12 ? "Both coaches online" : "Other coach inactive"
            } else { connection = "Waiting for other coach" }
            for message in messages where message.recipientID == credentials?.id && !message.expired {
                if !shown.contains(message.id) {
                    if !initialFeed { WKInterfaceDevice.current().play(.notification) }
                    shown.insert(message.id)
                }
                if message.receivedAt == nil {
                    _ = try await request("v1/messages/\(message.id)/received", method: "POST")
                }
            }
            initialFeed = false
            await uploadPushToken()
        } catch is CancellationError { }
        catch {
            if !Task.isCancelled { connection = "Offline · reconnecting" }
        }
    }

    func send(_ text: String, retry: Bool = false) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        let id = retry ? (failedID ?? UUID().uuidString) : UUID().uuidString
        do {
            let data = try await request("v1/messages", method: "POST", body: ["id": id, "text": text])
            let sent = try JSONDecoder().decode(CoachMessage.self, from: data)
            if !messages.contains(where: { $0.id == sent.id }) { messages.append(sent) }
            failedCall = nil; failedID = nil
            WKInterfaceDevice.current().play(.click)
            await refresh()
        } catch {
            failedCall = text; failedID = id
            self.error = "Send not confirmed: \(error.localizedDescription)"
        }
    }

    func acknowledge(_ message: CoachMessage) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            _ = try await request("v1/messages/\(message.id)/ack", method: "POST")
            await refresh()
        } catch { self.error = error.localizedDescription }
    }

    func uploadPushToken() async {
        guard credentials != nil, let token = UserDefaults.standard.string(forKey: "pushToken"), token != uploadedToken else { return }
        do {
            _ = try await request("v1/push-token", method: "POST", body: ["token": token])
            uploadedToken = token
        } catch { /* Foreground messages still work; retry at next refresh. */ }
    }

    func unpair() async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            _ = try await request("v1/device", method: "DELETE")
            polling?.cancel(); polling = nil
            CredentialVault.clear(); credentials = nil
            messages = []; shown = []; uploadedToken = nil
            failedCall = nil; failedID = nil
        } catch { self.error = "Could not unpair: \(error.localizedDescription)" }
    }

    struct ClientError: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }
}
