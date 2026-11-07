import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Bell, BellOff, Download, Home, LogOut, MessagesSquare, RefreshCw, Repeat } from 'lucide-react';
import { promptInstall, useInstall } from '@/install';
import { InstallHelpDialog } from '@/components/install-banner';
import { useChatUnread } from '@/chat-unread';
import { APP_VERSION, applyUpdate, useUpdateReady } from '@/pwa';
import { setSignedIn, useNotifications, useNotifyBarVisible } from '@/notifications';
import { NotifyBar, NotifyHelpDialog } from '@/components/notify-bar';
import { Logo } from '@/components/brand';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { initials } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface ShellUser {
  name: string;
  email?: string;
  isAdmin?: boolean;
}

/** Sticky top bar + centered content column, used by the Player and Admin areas. */
export function AppShell({
  section,
  user,
  onSignOut,
  children,
  wide,
  fill,
  hideNotifyBar,
}: {
  section: string;
  user?: ShellUser;
  onSignOut?: () => void;
  children: ReactNode;
  wide?: boolean;
  /** Content fills the screen below the header (the chat). */
  fill?: boolean;
  hideNotifyBar?: boolean;
}) {
  const signedIn = !!(user && onSignOut);
  const barVisible = useNotifyBarVisible() && !hideNotifyBar;
  const inChat = section === 'Chat';
  const chatUnread = useChatUnread(signedIn && !inChat);
  useEffect(() => {
    if (!signedIn) return;
    setSignedIn(true);
    return () => setSignedIn(false);
  }, [signedIn]);
  return (
    <div className={cn('bg-background', fill ? 'flex h-dvh flex-col overflow-hidden' : 'min-h-dvh')}>
      <header className="safe-top sticky top-0 z-30 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className={cn('mx-auto flex h-14 items-center gap-2 px-4 sm:gap-3 sm:px-6', wide ? 'max-w-7xl' : 'max-w-5xl')}>
          <Link to="/" className="rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            <Logo sub={section} />
          </Link>
          <div className="flex-1" />
          {signedIn &&
            (inChat ? (
              <Button variant="ghost" size="sm" render={<Link to="/player" />}>
                <Home /> <span className="hidden sm:inline">My page</span>
              </Button>
            ) : (
              <Button variant="ghost" size="sm" render={<Link to="/chat" />} aria-label={chatUnread ? 'Chat, new messages' : 'Chat'}>
                <span className="relative">
                  <MessagesSquare />
                  {chatUnread && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-brand ring-2 ring-background" />}
                </span>
                <span className="hidden sm:inline">Chat</span>
              </Button>
            ))}
          {user && onSignOut && <UserMenu user={user} onSignOut={onSignOut} />}
        </div>
      </header>
      <main
        className={cn(
          'safe-bottom mx-auto w-full px-4 sm:px-6',
          fill ? 'flex min-h-0 flex-1 flex-col py-3 sm:py-4' : 'py-6 sm:py-8',
          wide ? 'max-w-7xl' : 'max-w-5xl',
          barVisible && 'pb-40 sm:pb-28', // room for the notifications bar
        )}
      >
        {children}
      </main>
      {signedIn && !hideNotifyBar && <NotifyBar isAdmin={user?.isAdmin} />}
    </div>
  );
}

function UserMenu({ user, onSignOut }: { user: ShellUser; onSignOut: () => void }) {
  const updateReady = useUpdateReady();
  const n = useNotifications();
  const inst = useInstall();
  const [help, setHelp] = useState(false);
  const [installHelp, setInstallHelp] = useState(false);
  const canInstall = inst.kind !== 'none' && !inst.installed;
  async function install() {
    if (inst.canPrompt && (await promptInstall()) !== 'unavailable') return;
    setInstallHelp(true);
  }
  return (
    <>
    <NotifyHelpDialog open={help} onClose={() => setHelp(false)} isAdmin={user.isAdmin} />
    <InstallHelpDialog open={installHelp} onClose={() => setInstallHelp(false)} kind={inst.kind} />
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" className="h-9 gap-2 px-1.5 sm:px-2" aria-label="Account menu">
            <Avatar className="size-7">
              <AvatarFallback className="bg-primary text-[11px] font-medium text-primary-foreground">
                {initials(user.name || user.email || '?')}
              </AvatarFallback>
            </Avatar>
            <span className="hidden max-w-40 truncate text-sm font-medium sm:inline">{user.name}</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <div className="truncate font-medium text-foreground">{user.name}</div>
            {user.email && <div className="truncate text-xs font-normal">{user.email}</div>}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {user.isAdmin && (
          <>
            <DropdownMenuItem render={<Link to="/admin" />}>
              <Repeat /> Admin console
            </DropdownMenuItem>
            <DropdownMenuItem render={<Link to="/player" />}>
              <Repeat /> My player page
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {canInstall && (
          <DropdownMenuItem onClick={install}>
            <Download /> Install the app
          </DropdownMenuItem>
        )}
        {n.supported && (
          <DropdownMenuItem onClick={() => setHelp(true)}>
            {n.subscribed ? <Bell /> : <BellOff />}
            {n.subscribed ? 'Notifications on' : 'Turn on notifications'}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={onSignOut}>
          <LogOut /> Sign out
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {updateReady ? (
          <DropdownMenuItem onClick={applyUpdate}>
            <RefreshCw /> Update to the new version
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-[11px] font-normal">Version {APP_VERSION}</DropdownMenuLabel>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    </>
  );
}

/** Page title row with optional actions on the right. */
export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
