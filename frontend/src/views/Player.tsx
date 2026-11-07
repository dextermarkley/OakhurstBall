import { useEffect, useState } from 'react';
import { api } from '@/api';
import { AppShell, type ShellUser } from '@/components/app-shell';
import { AuthGate } from './AuthGate';
import { PlayerDashboard } from './PlayerDashboard';

export function Player() {
  return <AuthGate>{(signOut) => <PlayerPage signOut={signOut} />}</AuthGate>;
}

function PlayerPage({ signOut }: { signOut: () => void }) {
  const [user, setUser] = useState<ShellUser>();
  useEffect(() => {
    api.me().then((m) => setUser({ name: m.name ?? m.player?.name ?? m.email, email: m.email, isAdmin: m.isAdmin })).catch(() => {});
  }, []);
  return (
    <AppShell section="Player" user={user ?? { name: '' }} onSignOut={signOut}>
      <PlayerDashboard />
    </AppShell>
  );
}
