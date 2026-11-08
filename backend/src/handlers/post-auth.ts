// Cognito PostConfirmation trigger: when a user confirms their signup, create a
// linked player profile (if one doesn't already exist for this cognito sub), and
// tell the admins someone new joined so they can approve them for the chat.
//
// Admins are promoted separately by adding them to the 'admin' Cognito group and
// creating an ADMIN# record (via POST /api/admin/admins). Every Cognito user gets
// a player profile here so an admin can always "view as player".
import type { PostConfirmationTriggerEvent } from 'aws-lambda';
import { getPlayerByCognitoSub, createPlayer } from '../lib/repo.js';
import { sendPush } from '../lib/push.js';

// Cognito gives a trigger about 5 seconds in total; the notification must never
// be what makes a sign-up fail, so it gets at most this long.
const NOTIFY_BUDGET_MS = 2500;

export const handler = async (
  event: PostConfirmationTriggerEvent,
): Promise<PostConfirmationTriggerEvent> => {
  try {
    const sub = event.request.userAttributes.sub;
    const name =
      event.request.userAttributes.name ||
      event.request.userAttributes.email ||
      'New Player';
    const email = event.request.userAttributes.email;
    const phone = event.request.userAttributes.phone_number;

    if (sub) {
      const existing = await getPlayerByCognitoSub(sub);
      if (!existing) {
        await createPlayer({ name, email, phone, cognitoSub: sub });
        console.log('created player for cognito sub', sub);
        // Only a brand-new account (not a password reset, which also fires this).
        if (event.triggerSource === 'PostConfirmation_ConfirmSignUp') {
          await Promise.race([
            sendPush((d) => !!d.isAdmin && d.sub !== sub, {
              title: 'New sign-up',
              body: `${name} signed up. Tap to approve them for the chat.`,
              url: '/admin?tab=players',
              tag: `signup-${sub}`,
            }),
            new Promise((r) => setTimeout(r, NOTIFY_BUDGET_MS)),
          ]);
        }
      }
    }
  } catch (err) {
    // Never block signup on a profile-creation hiccup; log and continue.
    console.error('post-confirmation error', err);
  }
  return event;
};
