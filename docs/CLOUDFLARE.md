# Free hosting with Cloudflare

This version serves the iPhone Home Screen app from Cloudflare Workers and stores coach pairings, calls, notification subscriptions and notification keys in D1. It does not need a paid disk, an always-running Node server, a custom domain, a Mac, or Apple app signing. Use the Workers Free plan and stay within its quotas. No Cloudflare account has been connected or charged by this code, and no production deployment has been created in this session.

## Upload the update

Extract the ZIP and upload the **contents** of the `coach-communication` folder to the root of your GitHub repository. The root must contain `package.json`, `package-lock.json`, `wrangler.json`, `cloudflare/`, and `web/`. Do not upload the ZIP alone or nest the project in an extra folder. Accept replacement of the README and updated web files.

The older `relay/` and `WatchApp/` folders can remain. Cloudflare runs `cloudflare/worker.mjs`, not the Node server or native watch app. The older Render blueprint applies only to the Node version; use the Cloudflare route described here for free hosting.

## Deploy from your phone

After the updated files are in GitHub, open:

[Deploy Coach Comms to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/keubanks16/coach-communication)

1. Sign in to or create a Cloudflare account and stay on **Workers Free**.
2. Authorize the GitHub connection when Cloudflare asks. The deployment button can create a copy of the public repository in your GitHub account; select an available name if it asks. If you want to connect the original repository without a copy, use the dashboard steps below.
3. For **PAIRING_KEY**, choose your own private value with at least 10 characters. Both coaches enter this key when pairing. Do not put the real value in GitHub.
4. Keep the deployment command as **`npm run deploy`**. There is no front-end build command required. Cloudflare installs the packages from the root package lock.
5. Deploy and wait for the build to finish. The D1 database is provisioned or resolved and migrations are applied before the Worker is published.
6. Open the HTTPS `workers.dev` URL shown by Cloudflare. This is your app link for both coaches.

The deployment link requires a public source repository. For a private repo, connect it directly in **Cloudflare → Workers & Pages → Create application → Import a repository**. Choose `coach-communication`, keep the Worker name consistent with `wrangler.json`, use the repository root, leave the build command empty, and set the deploy command to `npm run deploy`.

If the setup screen does not offer a pairing-key field, add **PAIRING_KEY** as a runtime Secret under the Worker's **Settings → Variables and Secrets**, then retry the deployment. Ensure it is a runtime secret rather than only a build environment variable. The app shows an actionable setup error if this value is absent or too short.

The deploy helper uses the actual D1 ID returned by Cloudflare. It writes an ignored local `wrangler.resolved.json` for migrations and deployment, so account-specific IDs and credentials are not added to GitHub. If your build token lacks D1 permissions, allow D1 access for that project's deployment token and retry. Repeated deployment uses the existing named database and preserves records.

## Install on each iPhone

1. Open the live HTTPS app link in **Safari**.
2. Tap **Share → Add to Home Screen**, confirm, and open the new **Coach Comms** icon.
3. Pair one phone as **First base** and the other as **Third base**, using your shared pairing key.
4. Open **Setup → Enable notifications** and choose **Allow** on both phones.
5. Check the iPhone Watch app's notification mirroring settings for Coach Comms. Turn on **Silent Mode** on the watches.
6. Tap **Send a wrist-alert test** and immediately lock the iPhone. The test is scheduled eight seconds later. Confirm the actual wrist alert on your unlocked watch.

Normally, a notification appears on your iPhone if it is unlocked, and on your unlocked watch if the iPhone is locked or asleep. Focus and notification settings can affect delivery. A web app lets you read alerts on the watch; send calls and tap **Got it** in the phone app.

## Moving from the earlier host

The Cloudflare URL is a new app origin with a new D1 database. Existing Render/Node pairings and push subscriptions are not automatically transferred. Install the Cloudflare URL as a new Home Screen app, pair both phones again, and enable notifications again. This does not modify or delete data at the old host.

## What stays saved

D1 stores the two coach slots, bearer credential hashes, push subscriptions, message history and the server's VAPID key pair. The public notification key is exposed to browsers as required by Web Push; its private key is never returned by the API. Keys are created on the first use and survive redeployment. No local file persistence is required.

The pairing key is a Cloudflare Secret; editing it affects future pairing and does not revoke existing phone credentials. Use **Setup → Unpair** to free a coach slot. If a phone is lost, an administrator can remove that device's row from D1 to revoke its token. Deleting the database resets all pairing and notification data.

## Free-tier usage

Cloudflare's Workers Free plan currently includes 100,000 Worker requests per day. D1's free allocation currently includes 5 million rows read and 100,000 rows written per day, with storage quotas. Static assets are served separately from API Worker invocations. These are limits, not unlimited hosting or a guarantee of notification delivery.

The app polls only while visible and writes coach presence at most about every ten seconds. Ordinary two-coach game use is intended to fit within the free allocation. Running both apps continuously for an entire day or exposing credentials can consume limits; check usage in Cloudflare. Leave the account on the free plan if you want free-tier limits rather than paid overages.

## Developer checks and local testing

```sh
npm ci
npm test
```

The tests build the Worker bundle, run it in workerd with Miniflare D1, and check two-way calls, encryption, idempotent retries, authorization, expiry, subscriptions, notification destination and persistent keys. The test's outbound push service is mocked: it verifies the real Workers encryption and fetch path without delivering notifications to a real phone.

For local development, copy the secret example to a local development vars file, set your own test key, then:

```sh
npx wrangler d1 migrations apply DB --local
npm run dev
```

Local HTTP is for development. Install the deployed HTTPS URL for iPhone push testing. Actual iPhone installation and Apple Watch notification routing still require real-device checks.

From an authenticated computer, deployment also works with `npx wrangler login`, setting the `PAIRING_KEY` runtime secret, and `npm run deploy`. Avoid putting actual secrets in shell history or command arguments; use Wrangler's interactive secret prompt or the dashboard.

The Cloudflare backend supports **Home Screen Web Push**. Native watch APNs from the first version remains available through the separate Node relay. The native watch app can poll foreground calls against the same API, but its background APNs token route is not supported by this Cloudflare backend.

## References

- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Deploy to Cloudflare](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Workers static assets](https://developers.cloudflare.com/workers/static-assets/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Apple Home Screen push notifications](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)
