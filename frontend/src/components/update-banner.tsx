import { useLocation } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { applyUpdate, useUpdateReady } from '@/pwa';
import { useNotifyBarVisible } from '@/notifications';
import { cn } from '@/lib/utils';

/** Floating "new version" pill. Hidden on the kiosk, which updates itself when idle. */
export function UpdateBanner() {
  const ready = useUpdateReady();
  const barVisible = useNotifyBarVisible(); // sit above the notifications bar
  const { pathname } = useLocation();
  if (!ready || pathname.startsWith('/kiosk')) return null;
  return (
    <div
      className={cn(
        'safe-bottom pointer-events-none fixed inset-x-0 z-50 flex justify-center px-4',
        barVisible ? 'bottom-40 sm:bottom-24' : 'bottom-4',
      )}
    >
      <div
        role="status"
        className="pointer-events-auto flex items-center gap-3 rounded-full border bg-popover py-1.5 pr-1.5 pl-4 text-sm text-popover-foreground shadow-lg"
      >
        <span>A new version is available</span>
        <Button size="sm" className="rounded-full" onClick={applyUpdate}>
          <RefreshCw /> Update
        </Button>
      </div>
    </div>
  );
}
