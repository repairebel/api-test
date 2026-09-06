# Urgent store alerts and persistent admin sessions (test server)

## Implemented

- Store dispatch pushes always use the OS notification transport, a bundled 10.44-second PCM WAV sound, high priority, and a TTL capped at the request's expiry. The Android channel is now `dispatch-v2`, created before permissions and token registration; existing channels cannot have their sound changed in place. Both native projects already contain the sound resource.
- iOS dispatch notifications use `time-sensitive` interruption by default. Optional Critical Alerts support is gated behind `IOS_CRITICAL_ALERTS_ENABLED=true` in both the store build and server environment. Leave this disabled until Apple approves the entitlement and the provisioning profile includes it; then run Expo prebuild to regenerate entitlements and create a new signed native build. The app explicitly requests Critical Alerts permission only in that enabled build.
- Ordinary iOS alerts cannot override the mute switch. Android notification volume, DND access and user channel settings govern audible delivery. The app requests a DND-bypass-capable channel and exposes a phone settings shortcut. No fake calls, indefinite background playback, or guaranteed silent-mode bypass is implemented.
- Admin disputes, support requests and customer support messages produce persisted notifications and authenticated per-admin socket events. New socket joins validate user type, account status, token revocation and session version; connected admin sessions are rechecked every 30 seconds.
- Admin access tokens still expire, but the client renews them instead of logging out. New admin logins atomically revoke older device tokens and increment session version. The persistent refresh credential remains stable for concurrent tabs and is revoked on logout or another login. Its database expiry sentinel is year 9999 (no inactivity timeout). Password reset and suspension still invalidate access.
- Admin audio unlocks after a click or keypress; the top bar provides a Sound on/off control. Browser/OS muting still applies. The browser panel must be running for socket alerts; closed-browser Web Push is not included.

## Validation and rollout

Local authenticated integration tests cover persistent admin refresh, concurrent refresh, another-device invalidation, logout and persisted realtime alerts. Browser tests cover single-flight refresh, offline retention and revoked credentials. Store TypeScript and admin bundle checks pass. Admin has pre-existing strict TypeScript errors in Profile.tsx, Stores.tsx and Support.tsx.

No new database migration is needed for these changes. Deploy the test server and admin build against the test API, and install the updated native Store build before testing push delivery. Production has not been changed by this task.

Physical-device checks still required: foreground/background/terminated app, screen locked, notification permission denied, sound enabled/disabled, Android channel/DND settings, iOS mute/Focus, and approved Critical Alerts permission where available. Check Expo/APNs/FCM credentials and push ticket errors if a device receives no notification at all. This workspace cannot prove audibility on a physical phone.
