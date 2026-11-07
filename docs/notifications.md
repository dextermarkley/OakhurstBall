# Notifications (Web Push)

The installed app (desktop dock/Start menu, Android, iPhone/iPad home screen)
can show system notifications. They are sent with the standard Web Push
protocol straight to Apple/Google/Mozilla/Microsoft's push services, which are
free. There is no push vendor and no fixed cost.

## What gets sent

| Event | Who | Opens |
| --- | --- | --- |
| An admin opens a session | Everyone with notifications on, except that admin | `/player` |
| Someone records cash for an admin (kiosk or player page) | That admin | `/confirm/<token>` |
| A payment is confirmed (cash or card) or a cash payment is denied | The player | `/player` |
| "Send test" (automatic when turning notifications on) | The caller | `/player` or `/admin` |

Admins are matched by their Cognito user or by the login email on their admin
profile.

## How it fits together

- `frontend/public/push-sw.js`: the `push` and `notificationclick` handlers,
  imported into the generated service worker (`workbox.importScripts` in
  `vite.config.ts`).
- `frontend/src/notifications.ts`: permission state, subscribe/unsubscribe. With
  permission granted it re-registers the device on every launch (idempotent),
  so a new sign-in or a data reset heals itself. Signing out unregisters the
  device.
- `frontend/src/components/notify-bar.tsx`: the bottom reminder bar (installed
  app only, while notifications are off; "Not now" hides it until the next
  launch) and the help dialog with per-platform steps. The account menu opens
  the same dialog.
- `backend/src/lib/push.ts`: storage (`PK=PUSH`, `SK=SUB#<sha256(endpoint)>`),
  endpoint validation (known push-service hosts only), sending. Devices the push
  service reports as gone (404/410) are deleted. A send failure never fails the
  request that triggered it.
- API: `GET/POST/DELETE /api/me/push`, `POST /api/me/push/test`.

## VAPID keys

Created once, outside CDK (like the Stripe keys):

```
/oakhurst/push/vapid-public    String
/oakhurst/push/vapid-private   SecureString
```

To rotate them, generate a new pair (`npx web-push generate-vapid-keys`) and
overwrite both parameters. Existing devices then stop receiving until the app is
next opened; it notices the key change and re-subscribes on its own.

## Testing

`AWS_REGION=us-west-2 node backend/test/live-push.mjs` checks the endpoints
against the live stack with throwaway users and a fake device. Real delivery
has to be checked on a real device: install the app, turn notifications on, and
the test notification should arrive.
