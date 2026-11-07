import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { LogOut, RefreshCw, Repeat } from 'lucide-react';
import { APP_VERSION, applyUpdate, useUpdateReady } from '@/pwa';
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
}: {
  section: string;
  user?: ShellUser;
  onSignOut?: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="min-h-dvh bg-background">
      <header className="safe-top sticky top-0 z-30 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className={cn('mx-auto flex h-14 items-center gap-3 px-4 sm:px-6', wide ? 'max-w-7xl' : 'max-w-5xl')}>
          <Link to="/" className="rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            <Logo sub={section} />
          </Link>
          <div className="flex-1" />
          {user && onSignOut && <UserMenu user={user} onSignOut={onSignOut} />}
        </div>
      </header>
      <main className={cn('safe-bottom mx-auto px-4 py-6 sm:px-6 sm:py-8', wide ? 'max-w-7xl' : 'max-w-5xl')}>
        {children}
      </main>
    </div>
  );
}

function UserMenu({ user, onSignOut }: { user: ShellUser; onSignOut: () => void }) {
  const updateReady = useUpdateReady();
  return (
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
