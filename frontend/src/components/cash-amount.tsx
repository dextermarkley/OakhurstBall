// How much cash a player is handing over: $5 steps, with quick picks for the
// usual $5 / $10 / $20. Used on the player page and the kiosk.
import { Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { money } from '@/lib/format';
import { cn } from '@/lib/utils';

export const CASH_STEP_CENTS = 500;
export const CASH_MAX_CENTS = 20_000; // matches the server's MAX_CASH_CENTS
const QUICK = [500, 1000, 2000];

export function CashAmountPicker({
  value,
  onChange,
  disabled,
  size = 'default',
}: {
  value: number;
  onChange: (cents: number) => void;
  disabled?: boolean;
  /** 'lg' for the kiosk's touch screen. */
  size?: 'default' | 'lg';
}) {
  const lg = size === 'lg';
  const set = (c: number) => onChange(Math.min(CASH_MAX_CENTS, Math.max(CASH_STEP_CENTS, c)));
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex items-center gap-4">
        <Button
          variant="outline"
          size={lg ? 'icon-lg' : 'icon'}
          className={cn('rounded-full', lg && 'size-14 [&_svg]:size-6')}
          aria-label={`${money(CASH_STEP_CENTS)} less`}
          disabled={disabled || value <= CASH_STEP_CENTS}
          onClick={() => set(value - CASH_STEP_CENTS)}
        >
          <Minus />
        </Button>
        <div className={cn('tabular min-w-28 text-center font-semibold tracking-tight', lg ? 'text-5xl' : 'text-4xl')} aria-live="polite">
          {money(value)}
        </div>
        <Button
          variant="outline"
          size={lg ? 'icon-lg' : 'icon'}
          className={cn('rounded-full', lg && 'size-14 [&_svg]:size-6')}
          aria-label={`${money(CASH_STEP_CENTS)} more`}
          disabled={disabled || value >= CASH_MAX_CENTS}
          onClick={() => set(value + CASH_STEP_CENTS)}
        >
          <Plus />
        </Button>
      </div>
      {value >= CASH_MAX_CENTS && <p className="text-xs text-muted-foreground">Max {money(CASH_MAX_CENTS)}</p>}
      <div className="flex gap-2" role="group" aria-label="Quick amounts">
        {QUICK.map((c) => (
          <Button
            key={c}
            variant={value === c ? 'default' : 'outline'}
            size={lg ? 'lg' : 'sm'}
            className={cn('rounded-full', lg && 'h-12 px-6 text-base')}
            disabled={disabled}
            aria-pressed={value === c}
            onClick={() => set(c)}
          >
            {money(c)}
          </Button>
        ))}
      </div>
    </div>
  );
}
