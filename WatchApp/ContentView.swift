import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: CoachStore
    var body: some View {
        NavigationStack {
            if store.credentials == nil {
                PairView()
            } else {
                GameView()
            }
        }
        .tint(Color(red: 0.38, green: 0.73, blue: 0.96))
    }
}

struct PairView: View {
    @EnvironmentObject private var store: CoachStore
    @State private var key = ""
    @State private var role = "Third base"
    var body: some View {
        Form {
            Text("COACH COMMS").font(.headline)
            Text("Pair each coach once with the same relay and key.").font(.caption)
            TextField("HTTPS relay address", text: $store.endpoint)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            SecureField("Pairing key", text: $key)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            Picker("Position", selection: $role) {
                Text("First base").tag("First base")
                Text("Third base").tag("Third base")
            }
            Button(store.busy ? "Pairing…" : "Pair watch") {
                Task { await store.pair(key: key, role: role); if store.credentials != nil { key = "" } }
            }.disabled(store.busy || key.isEmpty || store.endpoint.isEmpty)
            ErrorView()
        }.navigationTitle("Coach Comms")
    }
}

struct GameView: View {
    @EnvironmentObject private var store: CoachStore
    @AppStorage("quickCalls") private var quickCalls = "Steal\nHold\nSend him\nBunt\nHit & run\nTime out"
    private var calls: [String] {
        quickCalls.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }.prefix(12).map { String($0.prefix(120)) }
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text(store.credentials?.role ?? "Coach").font(.caption).foregroundStyle(.secondary)
                Text(store.connection).font(.caption2)
                    .foregroundStyle(store.connection == "Both coaches online" ? .green : .orange)
                if !store.pushReady || !store.notificationsAllowed {
                    Text("Background alerts not ready. Keep both apps open.")
                        .font(.caption2).foregroundStyle(.orange)
                }
                // TimelineView updates expiry even when the relay becomes unavailable.
                TimelineView(.periodic(from: .now, by: 1)) { _ in
                    if let incoming = store.incoming {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(incoming.senderRole.uppercased()).font(.caption2)
                            Text(incoming.text).font(.title3.bold())
                            Button("Got it ✓") { Task { await store.acknowledge(incoming) } }
                                .disabled(store.busy)
                        }.padding(10).background(.blue.opacity(0.22), in: RoundedRectangle(cornerRadius: 12))
                    }
                }
                ErrorView()
                if let failed = store.failedCall {
                    Button("Retry: \(failed)") { Task { await store.send(failed, retry: true) } }
                        .disabled(store.busy)
                }
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                    ForEach(Array(calls.enumerated()), id: \.offset) { _, call in
                        Button { Task { await store.send(call) } } label: {
                            Text(call).font(.system(size: 15, weight: .semibold))
                                .frame(maxWidth: .infinity, minHeight: 42)
                        }.buttonStyle(.bordered).disabled(store.busy)
                    }
                }
                NavigationLink("Custom message") { ComposeView() }
                NavigationLink("Recent messages") { HistoryView() }
                NavigationLink("Settings") { SettingsView() }
            }.padding(.horizontal, 4)
        }.navigationTitle("Coach Comms")
    }
}

struct ComposeView: View {
    @EnvironmentObject private var store: CoachStore
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    var body: some View {
        Form {
            TextField("Message", text: $text)
            Text("\(text.count)/120").font(.caption2)
            Text("Use the keyboard or Scribble for silent input.").font(.caption2)
            Button("Send") {
                Task {
                    await store.send(text)
                    if store.failedCall == nil { dismiss() }
                }
            }.disabled(store.busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.count > 120)
            ErrorView()
        }.navigationTitle("Custom call")
    }
}

struct HistoryView: View {
    @EnvironmentObject private var store: CoachStore
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            List {
                if store.messages.isEmpty { Text("No messages yet.") }
                ForEach(store.messages.reversed()) { message in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(message.senderID == store.credentials?.id ? "You" : message.senderRole)
                            .font(.caption2).foregroundStyle(.secondary)
                        Text(message.text).font(.headline)
                        Text(message.status).font(.caption2)
                            .foregroundStyle(message.acknowledgedAt != nil ? .green : .secondary)
                        Text(CoachMessage.date(message.createdAt), style: .time).font(.caption2)
                    }
                }
            }
        }.navigationTitle("Recent calls")
    }
}

struct SettingsView: View {
    @EnvironmentObject private var store: CoachStore
    @AppStorage("quickCalls") private var quickCalls = "Steal\nHold\nSend him\nBunt\nHit & run\nTime out"
    @State private var confirmUnpair = false
    var body: some View {
        Form {
            Text("Turn on the watch’s Silent Mode for discreet wrist alerts.").font(.caption)
            Text("Calls expire after 60 seconds. A sent call is not confirmed until the other coach taps Got it.").font(.caption)
            Text("Quick calls · one per line")
            TextField("Calls", text: $quickCalls, axis: .vertical).lineLimit(3...12)
            Text("Up to 12 calls, 120 characters each.").font(.caption2)
            Text("Both coaches need internet. Test alerts at practice.").font(.caption)
            Button("Unpair watch", role: .destructive) { confirmUnpair = true }
                .disabled(store.busy)
            ErrorView()
        }
        .confirmationDialog("Unpair this coach’s watch?", isPresented: $confirmUnpair) {
            Button("Unpair", role: .destructive) { Task { await store.unpair() } }
        }.navigationTitle("Settings")
    }
}

struct ErrorView: View {
    @EnvironmentObject private var store: CoachStore
    var body: some View {
        if let error = store.error { Text(error).font(.caption).foregroundStyle(.red) }
    }
}
