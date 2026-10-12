import SwiftUI
import WatchKit
import UserNotifications

@main
struct CoachCommunicationApp: App {
    @WKApplicationDelegateAdaptor(NotificationDelegate.self) var delegate
    @StateObject private var store = CoachStore()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            ContentView().environmentObject(store)
                .task {
                    store.setActive(phase == .active)
                    await enableNotifications()
                }
                .onChange(of: phase) { _, value in
                    store.setActive(value == .active)
                    if value == .active { Task { await enableNotifications() } }
                }
                .onReceive(NotificationCenter.default.publisher(for: .coachPushToken)) { _ in
                    Task { await store.uploadPushToken() }
                }
        }
    }
    @MainActor
    private func enableNotifications() async {
        let center = UNUserNotificationCenter.current()
        do {
            store.notificationsAllowed = try await center.requestAuthorization(options: [.alert, .sound])
            if store.notificationsAllowed { WKApplication.shared().registerForRemoteNotifications() }
        } catch { store.notificationsAllowed = false }
    }
}

extension Notification.Name {
    static let coachPushToken = Notification.Name("coachPushToken")
}

final class NotificationDelegate: NSObject, WKApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching() {
        UNUserNotificationCenter.current().delegate = self
    }
    func didRegisterForRemoteNotifications(withDeviceToken deviceToken: Data) {
        UserDefaults.standard.set(deviceToken.map { String(format: "%02x", $0) }.joined(), forKey: "pushToken")
        NotificationCenter.default.post(name: .coachPushToken, object: nil)
    }
    func didFailToRegisterForRemoteNotificationsWithError(_ error: Error) {
        // Pairing and foreground messaging remain available without APNs.
        UserDefaults.standard.removeObject(forKey: "pushToken")
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // The active app polls and vibrates once per new call; no duplicate banner or sound.
        completionHandler([])
    }
}
