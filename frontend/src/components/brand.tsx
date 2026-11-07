import { cn } from '@/lib/utils';

/** Basketball mark: orange ball with navy seams. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className={cn('size-8', className)}>
      <circle cx="32" cy="32" r="30" fill="var(--brand)" />
      <g fill="none" stroke="var(--primary)" strokeWidth="3.2" strokeLinecap="round">
        <circle cx="32" cy="32" r="30" />
        <path d="M2 32h60M32 2v60" />
        <path d="M11 11c9 7 9 35 0 42M53 11c-9 7-9 35 0 42" />
      </g>
    </svg>
  );
}

export function Logo({ className, sub }: { className?: string; sub?: string }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <LogoMark />
      <div className="leading-tight">
        <div className="font-semibold tracking-tight">Oakhurst Basketball</div>
        {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
      </div>
    </div>
  );
}
