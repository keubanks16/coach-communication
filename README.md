# Coach Comms

## Free Cloudflare version

**Use this version for free hosting:** the Home Screen web app now runs on Cloudflare Workers with persistent D1 storage. Both coaches send calls from their iPhones and can receive mirrored notifications on Apple Watch. [Cloudflare setup instructions](docs/CLOUDFLARE.md) cover deployment, pairing and wrist-alert testing.

[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/keubanks16/coach-communication)

Upload the updated source first. Use `npm run deploy` and supply your own `PAIRING_KEY` secret of at least 10 characters. Cloudflare creates/resolves the database and applies migrations. Notification keys are generated automatically and saved in D1. Free-tier quotas apply. No live deployment or phone/watch delivery verification has been performed from this session.

```sh
npm ci
npm test
```

The checks include the real Cloudflare local runtime, D1, and the encrypted Web Push fetch path with a mocked push endpoint. The root `package.json` and `wrangler.json` configure Cloudflare. The older Node and native watch versions remain below for reference.

## NEW: iPhone Home Screen version

The repo now also includes an installable web app: send calls from either iPhone and receive notifications mirrored to the paired Apple Watch. **No Mac or native-app signing is needed for the web version.** Follow [Home Screen setup](docs/HOME_SCREEN.md) to deploy it over HTTPS, add it to both phones, and enable notifications. The web app is served by `relay/server.mjs`; the `web/` folder contains the interface, service worker, manifest and icons. `render.yaml` provides an optional deployment blueprint with persistent disk.

The web app uses one coach slot per iPhone; unpair an existing native-watch pairing before switching that role to the phone. Sending and acknowledging from the watch itself continues to require the native app described below. Background Web Push and on-watch delivery still require real-device testing.

```sh
npm ci --prefix relay
npm test --prefix relay
```

## Native watch version

A native Apple Watch app for quiet, two-way communication between first- and third-base coaches. Each coach wears an ordinary watch and taps a preset call. The other coach sees the call and taps **Got it**. Default calls: **Steal, Hold, Send him, Bunt, Hit & run, Time out**. Calls can be edited, and custom messages are supported.

## What is included

- SwiftUI watch-only app, watchOS 10 or newer.
- Independent HTTPS communication: nearby paired iPhone, Wi-Fi, or watch cellular data. No iPhone companion app is required.
- Haptic alerts in the active app and APNs support when the app is inactive.
- Sent, Received, Got it, and Expired states. “Sent” means stored by the relay, not read by the coach.
- Calls expire after 60 seconds. Older incoming calls do not replace an acknowledged newer call.
- Two coach positions protected by a shared setup key; each watch receives its own bearer credential stored in Keychain.
- A Node 24 relay with SQLite persistence and the `web-push` dependency for Home Screen notifications. One relay is one pair of coaches.
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
npm ci
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
