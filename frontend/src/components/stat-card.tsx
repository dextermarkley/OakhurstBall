import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon: LucideIcon;
  tone?: 'default' | 'brand' | 'success' | 'danger';
}) {
  const toneClass = {
    default: 'bg-secondary text-primary',
    brand: 'bg-brand/12 text-brand',
    success: 'bg-success/12 text-success',
    danger: 'bg-destructive/10 text-destructive',
  }[tone];
  return (
    <Card size="sm">
      <CardContent className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-muted-foreground">{label}</div>
          <div className="tabular mt-1 text-2xl font-semibold tracking-tight">{value}</div>
          {hint && <div className="mt-1 truncate text-xs text-muted-foreground">{hint}</div>}
        </div>
        <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', toneClass)}>
          <Icon className="size-4.5" />
        </div>
      </CardContent>
    </Card>
  );
}
