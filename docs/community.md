# Announcements and chat

## Session announcement

An admin posts today's announcement from Admin → Overview or Admin → Sessions.
The text starts as **"Ball today OCI - 5:30"** and can be edited before posting.

- Posting shows it at the top of every player page with **I'm in** and
  **Can't make it** buttons and the list of who's in, and sends a notification
  to every device with notifications on (except the poster's).
- Tapping your RSVP again clears it.
- Editing keeps the RSVPs. "Notify everyone about the change" is on by default.
- Taking it down removes it from player pages without notifying anyone.
- It is only for the day it was posted and disappears at midnight Pacific.
  Posting a new one replaces it and starts the RSVPs fresh.

Storage: `CURRENT/ANNOUNCE` points at `ANN#<id>/META`; RSVPs are
`ANN#<id>/RSVP#<playerId>`. Code: `backend/src/lib/announce.ts`,
`frontend/src/components/announcement.tsx`.

## Chat

`/chat` (the Chat button in the header) is one room for every signed-in member.

- Text up to 2,000 characters, links open in a new tab.
- Images: pick a file, paste, or drag one in. Photos are shrunk in the browser
  to at most 1600 px (GIFs are kept as-is so they stay animated). JPEG, PNG,
  GIF and WebP up to 10 MB.
- Delete: your own messages, or anyone's if you're an admin. Deleting removes
  the image from S3 too.
- The page checks for new messages every 4 seconds while it's on screen. Other
  pages show a dot on the Chat button when someone else has posted since you
  last looked (checked every minute).
- **Notify me** (off by default) sends a notification for new messages. The
  server skips anyone who has the chat open right now, and each device keeps a
  single chat notification that updates instead of stacking up.

Storage: messages are `CHAT/MSG#<iso>#<id>`; deletions leave a
`CHAT/DEL#<iso>#<id>` marker for 2 days so open chats drop them; preferences
are `PREFS/USER#<sub>`. Images live in the private `ChatMedia` S3 bucket
(stack output `ChatBucket`, kept if the stack is deleted). The browser uploads
them with a presigned POST that S3 checks for type and size, and they are shown
through `/api/media/<owner>/<id>.<ext>`, which redirects to a one-hour signed
URL. Code: `backend/src/lib/chat.ts`, `frontend/src/views/Chat.tsx`.

## Cost

All pay-per-use: DynamoDB requests, Lambda, and S3 storage (about $0.023 per GB
per month). An open chat makes one small request every 4 seconds.

## Testing

`AWS_REGION=us-west-2 node backend/test/live-community.mjs` runs 38 checks
against the live stack with throwaway users and sends no notifications. It
refuses to run while a real announcement is up.
