// Outbound email through Amazon SES (v2). The sender domain is verified in SES by
// the CDK stack (DKIM records in Route 53).
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

const ses = new SESv2Client({});

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

export async function sendEmail(msg: { to: string; subject: string; text: string; html: string }) {
  const from = process.env.EMAIL_FROM;
  if (!from) throw new Error('EMAIL_FROM is not set');
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [msg.to] },
      Content: {
        Simple: {
          Subject: { Data: msg.subject, Charset: 'UTF-8' },
          Body: {
            Text: { Data: msg.text, Charset: 'UTF-8' },
            Html: { Data: msg.html, Charset: 'UTF-8' },
          },
        },
      },
    }),
  );
}
