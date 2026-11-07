// Phone visitors who haven't installed the app get a bottom bar with steps for
// their phone and browser. Android Chrome can install in one tap.
import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Copy, Download, EllipsisVertical, Menu, Share, SquarePlus } from 'lucide-react';
import { toast } from 'sonner';
import { LogoMark } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { isInstallSnoozed, promptInstall, setInstallBarVisible, snoozeInstall, useInstall, type InstallKind } from '@/install';

// Pages where the bar would get in the way: the kiosk iPad, the chat (its message
// box is at the bottom), and one-off pages people land on from a link.
const HIDDEN_ON = ['/kiosk', '/chat', '/confirm', '/paid'];

export function InstallBanner() {
  const s = useInstall();
  const { pathname } = useLocation();
  const [snoozed, setSnoozed] = useState(isInstallSnoozed);
  const [help, setHelp] = useState(false);
  const show = s.kind !== 'none' && !s.installed && !snoozed && !HIDDEN_ON.some((p) => pathname.startsWith(p));

  useEffect(() => {
    setInstallBarVisible(show);
    return () => setInstallBarVisible(false);
  }, [show]);

  if (!show) return null;

  async function install() {
    if (s.canPrompt) {
      const r = await promptInstall();
      if (r === 'accepted') toast.success('Installing Oakhurst Basketball…');
      if (r !== 'unavailable') return;
    }
    setHelp(true);
  }

  return (
    <>
      {/* Keeps the end of the page from hiding under the bar. */}
      <div aria-hidden className="h-36" />
      <div className="safe-bottom pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center p-3">
        <div
          role="region"
          aria-label="Install the app"
          className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
        >
          <LogoMark className="size-10 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">Get the Oakhurst app</div>
            <div className="text-muted-foreground">
              {s.kind === 'in-app' ? 'Open this page in your browser to install it.' : 'Add it to your home screen for quick check-in and notifications.'}
            </div>
          </div>
          <div className="flex shrink-0 flex-col gap-1.5">
            <Button size="sm" onClick={install}>
              {s.canPrompt ? <Download /> : null} {s.canPrompt ? 'Install' : 'Show me'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              onClick={() => {
                snoozeInstall();
                setSnoozed(true);
              }}
            >
              Not now
            </Button>
          </div>
        </div>
      </div>
      <InstallHelpDialog open={help} onClose={() => setHelp(false)} kind={s.kind} />
    </>
  );
}

/** Step-by-step install instructions for this phone and browser. */
export function InstallHelpDialog({ open, onClose, kind }: { open: boolean; onClose: () => void; kind: InstallKind }) {
  const steps = stepsFor(kind);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mb-1 flex items-center gap-3">
            <LogoMark className="size-10" />
            <div>
              <DialogTitle>{kind === 'in-app' ? 'Open in your browser' : 'Install Oakhurst Basketball'}</DialogTitle>
              <DialogDescription className="mt-1">{platformLabel(kind)}</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <ol className="space-y-3 rounded-lg border bg-muted/40 p-3 text-sm">
          {steps.map((st, i) => (
            <li key={i} className="flex gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                {i + 1}
              </span>
              <span className="pt-0.5">{st}</span>
            </li>
          ))}
        </ol>
        <p className="text-xs text-muted-foreground">
          Then open Oakhurst from your home screen. It works like an app, signs you in faster, and can send you notifications.
        </p>
        <DialogFooter>
          {kind === 'in-app' && (
            <Button
              variant="outline"
              onClick={() =>
                navigator.clipboard
                  ?.writeText(window.location.href)
                  .then(() => toast.success('Link copied. Paste it into Safari or Chrome.'))
                  .catch(() => toast.error('Couldn’t copy. Use the menu to open in your browser.'))
              }
            >
              <Copy /> Copy link
            </Button>
          )}
          <Button onClick={onClose}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** An inline icon matching what the person will see on their screen. */
function Ico({ children }: { children: ReactNode }) {
  return (
    <span className="mx-0.5 inline-flex size-6 translate-y-1.5 items-center justify-center rounded-md border bg-background text-foreground [&_svg]:size-3.5">
      {children}
    </span>
  );
}

function platformLabel(kind: InstallKind) {
  switch (kind) {
    case 'ios-safari':
      return 'iPhone · Safari';
    case 'ios-other':
      return 'iPhone';
    case 'android-chrome':
      return 'Android · Chrome';
    case 'android-samsung':
      return 'Android · Samsung Internet';
    case 'android-firefox':
      return 'Android · Firefox';
    case 'in-app':
      return 'This page is open inside another app, which can’t install it.';
    default:
      return 'Android';
  }
}

function stepsFor(kind: InstallKind): ReactNode[] {
  switch (kind) {
    case 'ios-safari':
      return [
        <>Tap the <b>Share</b> button <Ico><Share /></Ico> in the toolbar at the bottom of the screen (or next to the address bar).</>,
        <>Scroll down and tap <b>Add to Home Screen</b> <Ico><SquarePlus /></Ico>. If you don’t see it, tap <b>Edit Actions</b> to add it.</>,
        <>Tap <b>Add</b> in the top right corner.</>,
      ];
    case 'ios-other':
      return [
        <>Tap the <b>Share</b> button <Ico><Share /></Ico> in the address bar.</>,
        <>Tap <b>Add to Home Screen</b> <Ico><SquarePlus /></Ico>, then <b>Add</b>.</>,
        <>Don’t see it? Open <b>oakhurst-ball.org</b> in <b>Safari</b> and add it from there.</>,
      ];
    case 'android-chrome':
      return [
        <>Tap the menu <Ico><EllipsisVertical /></Ico> at the top right.</>,
        <>Tap <b>Install app</b> (on some phones it says <b>Add to Home screen</b>).</>,
        <>Tap <b>Install</b> to confirm.</>,
      ];
    case 'android-samsung':
      return [
        <>Tap the menu <Ico><Menu /></Ico> at the bottom right.</>,
        <>Tap <b>Add page to</b>, then <b>Home screen</b>.</>,
        <>Tap <b>Add</b> to confirm.</>,
      ];
    case 'android-firefox':
      return [
        <>Tap the menu <Ico><EllipsisVertical /></Ico>.</>,
        <>Tap <b>Install</b> (or <b>Add to Home screen</b>).</>,
        <>Tap <b>Add</b> to confirm.</>,
      ];
    case 'in-app':
      return [
        <>Tap the <b>⋯</b> or <Ico><EllipsisVertical /></Ico> menu in this screen’s corner.</>,
        <>Choose <b>Open in Safari</b> (iPhone) or <b>Open in Chrome</b> / <b>Open in browser</b> (Android). Or tap <b>Copy link</b> below and paste it into your browser.</>,
        <>Then follow the install steps shown there.</>,
      ];
    default:
      return [
        <>Open your browser’s menu <Ico><EllipsisVertical /></Ico>.</>,
        <>Tap <b>Install app</b> or <b>Add to Home screen</b>.</>,
        <>Confirm, then open Oakhurst from your home screen.</>,
      ];
  }
}
