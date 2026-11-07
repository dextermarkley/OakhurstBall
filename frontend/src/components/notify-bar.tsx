import { useEffect, useState, type ReactNode } from 'react';
import { BellOff, BellRing, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import {
  enableNotifications,
  setNotifyBarVisible,
  syncNotifications,
  useNotifications,
  type Platform,
} from '@/notifications';

const SNOOZE_KEY = 'notifyBarSnoozed';

/**
 * Floating reminder at the bottom of the installed app while notifications are
 * off. "Not now" hides it until the app is next opened.
 */
export function NotifyBar({ isAdmin }: { isAdmin?: boolean }) {
  const n = useNotifications();
  const [snoozed, setSnoozed] = useState(() => sessionStorage.getItem(SNOOZE_KEY) === '1');
  const [help, setHelp] = useState(false);
  const show = n.supported && n.installed && n.subscribed === false && !snoozed;

  useEffect(() => {
    setNotifyBarVisible(show);
    return () => setNotifyBarVisible(false);
  }, [show]);

  const blocked = n.permission === 'denied';
  return (
    <>
      {show && (
        <div className="safe-bottom pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center p-3 sm:p-4">
          <div
            role="region"
            aria-label="Notifications reminder"
            className="pointer-events-auto flex w-full max-w-2xl flex-col gap-3 rounded-xl border bg-popover p-3 text-sm text-popover-foreground shadow-lg sm:flex-row sm:items-center sm:gap-4 sm:pl-4"
          >
            <div className="flex flex-1 items-start gap-3">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
                {blocked ? <BellOff className="size-4" /> : <BellRing className="size-4" />}
              </div>
              <div className="min-w-0">
                <div className="font-medium">
                  {blocked ? 'Notifications are blocked' : n.error ? "Notifications didn't turn on" : 'Turn on notifications'}
                </div>
                <div className="text-muted-foreground">
                  {blocked
                    ? 'Allow them in your settings to hear when the gym opens and when payments go through.'
                    : isAdmin
                      ? 'Get cash payments to confirm, plus when the gym opens.'
                      : 'Know when the gym opens and when your payments go through.'}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 gap-2 self-end sm:self-auto">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  sessionStorage.setItem(SNOOZE_KEY, '1');
                  setSnoozed(true);
                }}
              >
                Not now
              </Button>
              <Button size="sm" onClick={() => setHelp(true)}>
                {blocked ? 'Show me how' : 'Turn on'}
              </Button>
            </div>
          </div>
        </div>
      )}
      <NotifyHelpDialog open={help} onClose={() => setHelp(false)} isAdmin={isAdmin} />
    </>
  );
}

/** Explains what notifications are for and walks through turning them on. */
export function NotifyHelpDialog({ open, onClose, isAdmin }: { open: boolean; onClose: () => void; isAdmin?: boolean }) {
  const n = useNotifications();
  const [checking, setChecking] = useState(false);

  const turnOn = async () => {
    const r = await enableNotifications();
    if (r === 'on') {
      toast.success('Notifications are on', { description: 'We sent a test notification to this device.' });
      onClose();
    } else if (r === 'dismissed') {
      toast.info('Choose Allow when your browser asks, to get notifications.');
    } else if (r === 'error') {
      toast.error("Couldn't turn on notifications", { description: 'Check your connection and try again.' });
    }
    // 'denied' → the dialog switches to the unblock steps on its own.
  };

  const recheck = async () => {
    setChecking(true);
    await syncNotifications();
    setChecking(false);
  };

  const iosNotInstalled = n.platform === 'ios' && !n.installed;
  const on = n.subscribed === true;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-brand/10 text-brand">
            {on ? <CheckCircle2 className="size-5" /> : n.permission === 'denied' ? <BellOff className="size-5" /> : <BellRing className="size-5" />}
          </div>
          <DialogTitle>
            {on ? 'Notifications are on' : n.permission === 'denied' ? 'Unblock notifications' : 'Turn on notifications'}
          </DialogTitle>
          <DialogDescription>
            {on
              ? "You're all set on this device."
              : n.permission === 'denied'
                ? 'This device blocked notifications for Oakhurst Basketball, so the app can’t ask again. Allow them in settings:'
                : 'We’ll only notify you about things that matter:'}
          </DialogDescription>
        </DialogHeader>

        {!on && n.permission !== 'denied' && (
          <>
            <ul className="space-y-1.5 text-sm">
              <Bullet>The gym is open and pickup has started</Bullet>
              <Bullet>Your payment went through, or a cash payment wasn’t confirmed</Bullet>
              {isAdmin && <Bullet>Someone handed you cash and it needs confirming</Bullet>}
            </ul>
            {iosNotInstalled ? (
              <Steps
                items={[
                  'On iPhone and iPad, notifications only work from the installed app.',
                  <>Tap <b>Share</b>, then <b>Add to Home Screen</b>.</>,
                  'Open Oakhurst from your home screen and turn notifications on there.',
                ]}
              />
            ) : (
              <Steps
                items={[
                  <>Click <b>Turn on notifications</b> below.</>,
                  <>When {browserName(n.platform)} asks, choose <b>Allow</b>.</>,
                  'We’ll send a test notification so you know it worked.',
                ]}
              />
            )}
            {n.error && <p className="text-sm text-destructive">{n.error}</p>}
          </>
        )}

        {!on && n.permission === 'denied' && <Steps items={unblockSteps(n.platform)} />}

        {/* The unblock steps for these already go through system settings. */}
        {(on || (n.permission === 'denied' && !['mac-safari', 'ios', 'android'].includes(n.platform))) && (
          <p className="text-xs text-muted-foreground">
            Not seeing them? Also check {osSettingsHint(n.platform)}, and that Focus / Do Not Disturb is off.
          </p>
        )}

        <DialogFooter>
          {on ? (
            <Button onClick={onClose}>Done</Button>
          ) : n.permission === 'denied' ? (
            <>
              <Button variant="outline" onClick={onClose}>Close</Button>
              <Button onClick={recheck} disabled={checking}>
                {checking && <Spinner />} I’ve allowed them
              </Button>
            </>
          ) : iosNotInstalled ? (
            <Button onClick={onClose}>Got it</Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>Not now</Button>
              <Button onClick={turnOn} disabled={n.busy || !n.supported}>
                {n.busy ? <Spinner /> : <BellRing />} Turn on notifications
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Bullet({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand" />
      <span>{children}</span>
    </li>
  );
}

function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="space-y-2 rounded-lg border bg-muted/40 p-3 text-sm">
      {items.map((it, i) => (
        <li key={i} className="flex gap-3">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-medium text-primary-foreground">
            {i + 1}
          </span>
          <span className="pt-px">{it}</span>
        </li>
      ))}
    </ol>
  );
}

function browserName(p: Platform) {
  if (p === 'mac-safari' || p === 'ios') return 'your Mac';
  return 'your browser';
}

function unblockSteps(p: Platform): ReactNode[] {
  switch (p) {
    case 'ios':
      return [
        <>Open the <b>Settings</b> app, then <b>Notifications</b>.</>,
        <>Tap <b>Oakhurst</b> and turn on <b>Allow Notifications</b>.</>,
        'Come back here and tap I’ve allowed them.',
      ];
    case 'android':
      return [
        <>Touch and hold the Oakhurst icon, then tap <b>App info</b>.</>,
        <>Tap <b>Notifications</b> and turn them on.</>,
        'Come back here and tap I’ve allowed them.',
      ];
    case 'mac-safari':
      return [
        <>Open <b>System Settings</b> → <b>Notifications</b>.</>,
        <>Choose <b>Oakhurst Basketball</b> and turn on <b>Allow notifications</b>.</>,
        'Come back here and click I’ve allowed them.',
      ];
    default:
      return [
        <>In this app window, click the <b>⋮</b> or <b>…</b> menu at the top right, then <b>App info</b> (or <b>Site settings</b>).</>,
        <>Set <b>Notifications</b> to <b>Allow</b>.</>,
        'Come back here and click I’ve allowed them.',
      ];
  }
}

function osSettingsHint(p: Platform) {
  switch (p) {
    case 'mac-safari':
    case 'mac-chromium':
      return 'System Settings → Notifications (Oakhurst Basketball, or your browser)';
    case 'windows':
      return 'Windows Settings → System → Notifications (Oakhurst Basketball, or your browser)';
    case 'ios':
      return 'Settings → Notifications → Oakhurst';
    case 'android':
      return 'the app’s notification settings';
    default:
      return 'your system’s notification settings';
  }
}
