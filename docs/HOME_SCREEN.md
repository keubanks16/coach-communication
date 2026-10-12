# Home Screen app → Apple Watch notifications

This version runs on the iPhone and sends Web Push notifications. iOS can mirror those notifications to the paired Apple Watch. Coaches send and acknowledge calls on their phones, and read alerts on their watches. It does not install a native watch interface or let a coach send from the watch itself.

**You do not need a Mac, Xcode, or an Apple Developer Program account for this web version.** You do need a live HTTPS server and two iPhones with compatible paired watches. Apple supports Home Screen Web Push on iOS 16.4 or newer. The ZIP must be deployed; a downloaded HTML/ZIP file cannot provide background notifications.

## Host it

The web interface and API are served by the same Node app. Use Node 24 and persistent storage for both the SQLite database and `vapid.json`. Web Push keys are generated automatically on the first launch and must be kept across restarts. Changing those keys requires both coaches to enable notifications again.

For a local check:

```sh
npm ci --prefix relay
export PAIRING_KEY='choose-a-long-secret-of-at-least-16-characters'
export VAPID_SUBJECT='mailto:your-real-email@example.com'
node relay/server.mjs
```

Open `http://localhost:8080` on that computer. Home Screen push on real phones requires an HTTPS URL; localhost is only for local development. In production bind to `HOST=0.0.0.0` as required by your hosting platform and put HTTPS in front of the server. GitHub Pages alone cannot run the messaging/push backend.

### Included Render blueprint

1. Upload the source folders to your `coach-communication` GitHub repo. Preserve the top-level folder structure: `web`, `relay`, and `render.yaml` are at the repository root.
2. In Render choose **New → Blueprint**, connect the repo, and select this blueprint.
3. Supply `VAPID_SUBJECT` using your actual email in the form `mailto:you@yourdomain.com`, or your actual HTTPS website URL.
4. Review the service and persistent-disk price before creating it. The included blueprint uses a paid plan for persistent disk; no hosting purchase has been made by this code.
5. After deployment, use the HTTPS URL shown by Render. Find the generated `PAIRING_KEY` in the service's Environment settings and share that key only with the other coach.

The blueprint has not been deployed from this session. You can also host the same app on another Node-capable service with a persistent writable disk. To use Docker, build from the repo root: `docker build -f relay/Dockerfile .`; mount a writable volume at `/data` owned by UID 1000, pass `PAIRING_KEY` and `VAPID_SUBJECT`, and add HTTPS.

## Set up each iPhone

Do these steps on both coaches' phones:

1. Open the live HTTPS URL in **Safari**.
2. Tap **Share → Add to Home Screen** and confirm. If offered an Open as Web App option, keep it enabled.
3. Close Safari and launch **Coach Comms** from the new Home Screen icon. Install first, then pair, because browser and installed-app storage may differ.
4. Choose **First base** on one phone and **Third base** on the other. Enter the same pairing key and tap **Join the game**.
5. In **Setup**, tap **Enable notifications** and choose **Allow** when iOS asks.
6. In the iPhone's Watch app, check **Notifications → Mirror iPhone Alerts From** and enable Coach Comms when it appears. Also make sure the app's iPhone notifications are allowed and not delayed by a summary/Focus setting.
7. Turn on the watch's **Silent Mode** for discreet alerts.
8. Tap **Send a wrist-alert test**, immediately lock the iPhone, and wait. The server schedules the test after eight seconds so the phone can be locked before the push arrives.

Normally, notifications go to the iPhone when it is unlocked, and to the unlocked paired watch when the iPhone is locked/asleep. Settings and connection state affect this behavior. The scheduled test is not proof of delivery; confirm the actual wrist alert.

## During a game

- Open **Calls** and tap a preset: Steal, Hold, Send him, Bunt, Hit & run, or Time out. Edit these under Setup.
- The other coach gets a notification, which may appear on his watch according to Apple's routing and settings.
- To reply **Got it**, open the phone app and tap Got it. Web notification reply actions on the watch are not promised.
- Both coaches have call buttons, so messages work in either direction.
- **Sent** means stored on the server. **Received** means fetched by the recipient's active app. **Got it** means the coach explicitly acknowledged it. A push service accepting a notification is not a receipt.
- Instructions expire after 60 seconds. Late pushes are visibly labeled expired, and old instructions cannot be acknowledged.
- Offline sends are blocked instead of queued for later game situations. A timeout offers an explicit Retry using the same message ID, so a call already saved by the server is not duplicated.
- A device-local app shell can open offline, but sending/receiving calls requires internet.

The app has no automatic sound effects. Notification sound and watch haptics are controlled by iOS/watchOS; use Silent Mode and test at the field. Apple controls push delivery, so latency and guaranteed delivery are not promised.

## Pairing and privacy

One relay supports two coach positions. If the native watch app from the first version is already paired, unpair it before assigning that same position to an iPhone. The phone stores its bearer credential in site storage; keep the phone locked and do not share a paired phone's browser profile. The shared pairing key is not stored by the web app.

Use **Setup → Unpair this phone** before replacing the phone or changing from Safari to a Home Screen install. Unpairing frees the role and revokes its server credential. If a paired phone is lost, the host administrator can remove its role from the SQLite devices table, or reset the database to revoke both coaches. Back up needed history first.

Never commit real `.env`, `vapid.json`, SQLite files, or Apple `.p8` keys. No real keys are included in this package. The Web Push subscription endpoints are restricted to known Apple, Google, and Mozilla push hosts.

## Verification

Run `npm ci --prefix relay` then `npm test --prefix relay`. Automated tests cover both directions, authorization, retry deduplication, expiry, push failures, subscription validation, endpoint restrictions, static/manifest headers, notification handling, and persistent Web Push keys. Actual iPhone installation, sunlight readability, and Apple Watch notification mirroring must be verified on devices.

## References

- [Apple: Web Push for Home Screen web apps](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)
- [WebKit: iOS Web Push and Apple Watch notification support](https://webkit.org/blog/13878/)
- [Apple: iPhone and Apple Watch notification routing](https://support.apple.com/en-ie/108274)
- [Render: blueprint specification](https://render.com/docs/blueprint-spec)
