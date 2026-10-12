# Setup on two coaches’ watches

## 1. Host the relay

Use an always-on Node 24 host with persistent disk and HTTPS. Run one relay instance with one SQLite database. This app supports one first-base coach and one third-base coach per relay. Do not use ephemeral disk for the database. The relay has no browser UI.

From the repository:

```sh
cd relay
export PAIRING_KEY='choose-your-own-long-random-secret'
export DATABASE_PATH='data/coach.sqlite'
npm start
```

Supply environment variables through your host’s secret settings in production. Never commit real keys. Node does not automatically load `.env.example` or `.env`. Bind to `127.0.0.1` behind a reverse proxy, or set `HOST=0.0.0.0` inside a container.

For example, place Caddy in front of the service using your own DNS name:

```caddyfile
comms.your-domain.com {
    reverse_proxy 127.0.0.1:8080
}
```

The watch URL is `https://comms.your-domain.com`. A browser request to `/health` should return `{"ok":true}`. HTTP is deliberately rejected by the watch app. Do not expose the unencrypted Node port to the public internet. Pairing and device requests are rate-limited. Protect and back up the SQLite database.

Alternatively, build `relay/Dockerfile`, mount a writable persistent volume at `/data` owned by the container’s node user (UID 1000), provide `PAIRING_KEY`, and put HTTPS in front of port 8080. This service does not trust client-provided forwarding headers; if a reverse proxy aggregates clients under one address, pairing attempt limits are shared.

## 2. Generate and open the Apple project

On a Mac with Xcode and watchOS platform support:

```sh
git clone https://github.com/keubanks16/coach-communication.git
cd coach-communication
brew install xcodegen
xcodegen generate
open CoachCommunication.xcodeproj
```

In Xcode select the **CoachCommunication** target, then **Signing & Capabilities**:

1. Choose your Apple development team.
2. Replace `com.gsbaseball.coachcommunication` with a unique bundle identifier you own. Also update `project.yml` so regeneration preserves it.
3. Keep automatic signing enabled. Enable the **Push Notifications** capability for that App ID and target.
4. Select a paired watch as the run destination and follow Xcode’s Developer Mode and device setup prompts.
5. Build and run on each coach’s watch using a provisioning profile that includes the device, or distribute using TestFlight after Apple processing/review and account setup.

The unsigned GitHub Actions build is a compilation check, not a watch-installable app. An app icon and App Store metadata must be added before a store submission. A free personal signing account is not a substitute for APNs/TestFlight provisioning. If testing only foreground communication under a personal account, remove the push entitlement/capability for that build; background alerts will be unavailable.

## 3. Configure background wrist notifications

In your Apple Developer account create an APNs signing key and download its `.p8` file. Store it outside the repo on the relay host. Set:

| Variable | Value |
| --- | --- |
| `APNS_KEY_PATH` | Absolute path to the mounted `.p8` key |
| `APNS_KEY_ID` | Apple key ID |
| `APNS_TEAM_ID` | Apple developer team ID |
| `APNS_TOPIC` | Exactly the watch app’s bundle ID |
| `APNS_ENVIRONMENT` | `sandbox` for an Xcode development build; `production` for TestFlight/App Store |

Restart the relay. Both watches must run builds using the matching APNs environment. The app requests notification permission and registers its device token on launch. Open each app after pairing so both tokens upload. **Background alerts not ready** stays visible until the other coach has a registered token and the relay has APNs credentials, or if local notification permission is denied. Configuration presence is not proof of successful push delivery; validate on real devices.

APNs requests contain the call text and a 60-second expiration, and failures are stored as the message’s `pushStatus`. The app uses foreground polling for message/ack status and relies on the system’s notification interface when inactive. A background alert does not itself count as Received or Got it: the recipient must open the app, then tap Got it.

**Turn on Silent Mode on each watch.** APNs uses a normal alert with a default notification sound so Apple can provide the usual wrist alert behavior. Silent Mode suppresses the audible sound while allowing system haptics subject to watch settings. Focus, denied permission, low-power settings, connection loss, and watchOS scheduling can prevent or delay alerts.

## 4. Pair and customize

On each watch:

1. Enter your HTTPS relay URL without query parameters.
2. Enter the shared pairing key from the relay host. Watch text entry can use the paired iPhone’s keyboard when offered.
3. Select First base on one watch and Third base on the other.
4. Tap Pair watch and allow notifications.
5. In Settings edit the quick calls, one per line, and enable the watch’s Silent Mode in Control Center.

There is no relay URL or real secret embedded in the source. The setup key is used once, is not saved by the app, and should be kept between the two coaches. Each watch’s bearer credential is stored in Keychain. Changing the pairing key blocks future pairing with the old key but does not revoke devices already paired.

Use **Settings → Unpair watch** before replacing a watch; it revokes that credential and frees the coach position. If a device is lost and cannot unpair, stop the relay and remove that role from the devices table using SQLite, then restart and pair the replacement. Removing the database revokes both devices and erases call history. Keep a backup first if history matters.

## 5. Verify before game use

- Send both ways with both apps open, and check Received and Got it.
- Lower the recipient’s wrist and close its app; confirm the actual background wrist notification.
- Disconnect internet on one coach’s watch; verify the UI shows inactive/offline and no false receipt.
- Retry a send after a temporary outage; verify it does not create a duplicate.
- Wait more than 60 seconds; the call must expire and cannot be acknowledged.
- Test sunlight readability and Silent Mode at your field.

The app does not promise instantaneous delivery or continuous background polling. Background notification delivery and its timing are controlled by Apple.
