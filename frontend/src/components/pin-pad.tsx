import { useEffect, useState } from 'react';
import { Check, Delete } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Large touch PIN pad for the kiosk. PINs are 4-6 digits, so it submits on ✓
 * (or automatically at 6). Physical keyboards work too.
 */
export function PinPad({
  min = 4,
  max = 6,
  disabled,
  onComplete,
}: {
  min?: number;
  max?: number;
  disabled?: boolean;
  onComplete: (pin: string) => void;
}) {
  const [pin, setPin] = useState('');

  const submit = (value: string) => {
    onComplete(value);
    setPin('');
  };
  const push = (d: string) => {
    if (disabled || pin.length >= max) return;
    const next = pin + d;
    if (next.length === max) submit(next);
    else setPin(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (disabled) return;
      if (/^\d$/.test(e.key)) push(e.key);
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
      else if (e.key === 'Enter' && pin.length >= min) submit(pin);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const key =
    'flex h-16 items-center justify-center rounded-2xl border bg-card text-2xl font-medium shadow-xs transition ' +
    'active:scale-[0.97] active:bg-muted disabled:opacity-40 sm:h-[72px]';

  return (
    <div className="mx-auto w-full max-w-xs">
      <div className="mb-6 flex h-6 items-center justify-center gap-3" role="status" aria-live="polite">
        <span className="sr-only">{pin.length} digits entered</span>
        {Array.from({ length: Math.max(min, pin.length) }).map((_, i) => (
          <span
            key={i}
            className={cn('size-3.5 rounded-full border-2 transition', i < pin.length ? 'border-primary bg-primary' : 'border-input')}
          />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} type="button" className={key} disabled={disabled} onClick={() => push(d)}>
            {d}
          </button>
        ))}
        <button type="button" className={cn(key, 'text-muted-foreground')} disabled={disabled} onClick={() => setPin((p) => p.slice(0, -1))} aria-label="Delete">
          <Delete className="size-6" />
        </button>
        <button type="button" className={key} disabled={disabled} onClick={() => push('0')}>
          0
        </button>
        <button
          type="button"
          className={cn(key, 'border-transparent bg-primary text-primary-foreground active:bg-primary/90')}
          disabled={disabled || pin.length < min}
          onClick={() => submit(pin)}
          aria-label="Enter"
        >
          <Check className="size-7" />
        </button>
      </div>
    </div>
  );
}
