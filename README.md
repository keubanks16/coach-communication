# Coach Comms

A native Apple Watch app for quiet, two-way communication between first- and third-base coaches. Each coach wears an ordinary watch and taps a preset call. The other coach sees the call and taps **Got it**. Default calls: **Steal, Hold, Send him, Bunt, Hit & run, Time out**. Calls can be edited, and custom messages are supported.

## What is included

- SwiftUI watch-only app, watchOS 10 or newer.
- Independent HTTPS communication: nearby paired iPhone, Wi-Fi, or watch cellular data. No iPhone companion app is required.
- Haptic alerts in the active app and APNs support when the app is inactive.
- Sent, Received, Got it, and Expired states. “Sent” means stored by the relay, not read by the coach.
- Calls expire after 60 seconds. Older incoming calls do not replace an acknowledged newer call.
- Two coach positions protected by a shared setup key; each watch receives its own bearer credential stored in Keychain.
- A Node 24 relay with SQLite persistence and no package dependencies. One relay is one pair of coaches.
- Relay integration tests and a macOS GitHub Actions simulator build.

**This repository contains source, not an installed or signed app.** The relay must be hosted, and Apple signing is required to install on real watches. Push alerts require APNs credentials. Source and relay tests can be checked here; simulator compilation and physical-watch behavior require Apple tooling. Check the repository’s **Actions** tab for the watch build result.

## Install

See [the setup guide](docs/SETUP.md). You need a Mac with Xcode, two compatible Apple Watches, and an HTTPS relay. For APNs and TestFlight distribution to other coaches, use an Apple Developer Program membership and a registered bundle ID. GitHub Pages cannot run this relay or install a native watch app.

On each watch, enter the same relay URL and pairing key; choose a different coach position. Turn on **Silent Mode** on both watches. Apple controls notification sound and haptics, so the app cannot force a background notification to be silent regardless of system settings. Preset buttons never use spoken input; for custom calls, choose keyboard/Scribble rather than dictation.

## Game use

1. Pair both watches before practice.
2. Open both apps and verify **Both coaches online**.
3. Tap a call. Watch for **Received**, then **Got it ✓** in Recent messages.
4. If sending is not confirmed, use **Retry**; it reuses the same message ID to avoid duplicate calls.
5. With push notifications configured, test messages while the recipient’s app is closed and wrist is lowered.

This uses internet messaging, not a direct watch-to-watch radio. Foreground refresh is approximately every two seconds; watchOS can suspend the app when inactive. APNs delivery is best effort and latency is not guaranteed. Calls must not be assumed received before confirmation. Without push support, keep both apps active; wrist lowering can still suspend them. Test at your actual field before relying on the app in a game.

## Developer checks

```sh
cd relay
npm test
```

On a Mac:

```sh
brew install xcodegen
xcodegen generate
xcodebuild -project CoachCommunication.xcodeproj -scheme CoachCommunication \
  -sdk watchsimulator -destination 'generic/platform=watchOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

## Apple references

- [Single-target watchOS apps](https://developer.apple.com/documentation/watchos-apps/migrating-to-a-single-target-watchos-app)
- [watchOS notifications](https://developer.apple.com/documentation/watchos-apps/enabling-and-receiving-notifications)
- [APNs requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)
- [Foreground networking lifecycle](https://developer.apple.com/documentation/watchos-apps/making-default-and-ephemeral-requests)
