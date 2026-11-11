// Admin → Expenses: record what the club spends (basketballs, insurance, the
// monthly facility fee, anything else) and see it next to what players paid.
import { useCallback, useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import {
  Building2,
  CalendarClock,
  CircleDollarSign,
  Pencil,
  Plus,
  Receipt,
  Shield,
  Trash2,
  Volleyball,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { api, type Expense, type ExpenseCategory, type ExpenseReport } from '@/api';
import { PageHeader } from '@/components/app-shell';
import { useConfirm } from '@/components/confirm';
import { FormInput } from '@/components/form-field';
import { StatCard } from '@/components/stat-card';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { money, ymdText } from '@/lib/format';
import { cn } from '@/lib/utils';

// Lucide has no basketball; its volleyball is the closest round ball.
const CATS: Record<ExpenseCategory, { label: string; icon: LucideIcon; hint: string; color: string }> = {
  basketballs: { label: 'Basketballs', icon: Volleyball, hint: 'e.g. 2 × Wilson Evolution', color: 'bg-brand' },
  insurance: { label: 'Insurance', icon: Shield, hint: 'e.g. Annual liability policy', color: 'bg-primary' },
  facility: { label: 'Facility', icon: Building2, hint: 'e.g. November gym rental', color: 'bg-success' },
  other: { label: 'Other', icon: Receipt, hint: 'What was it for?', color: 'bg-muted-foreground' },
};
const ORDER: ExpenseCategory[] = ['facility', 'basketballs', 'insurance', 'other'];
const MONTH = (ymd: string) => new Date(`${ymd}T12:00:00`).toLocaleDateString([], { month: 'long' });

export function ExpensesTab() {
  const confirm = useConfirm();
  const [season, setSeason] = useState<number | undefined>(undefined);
  /** null: the whole season; 1–4: one quarter of it. */
  const [quarter, setQuarter] = useState<number | null>(null);
  const [r, setR] = useState<ExpenseReport | null>(null);
  const [editing, setEditing] = useState<{ expense?: Expense; category?: ExpenseCategory } | null>(null);

  const load = useCallback(async () => {
    try {
      setR(await api.expenses(season, quarter ?? undefined));
    } catch (e: any) {
      toast.error(e.message);
    }
  }, [season, quarter]);
  useEffect(() => {
    load();
  }, [load]);

  async function remove(e: Expense) {
    const ok = await confirm({
      title: 'Delete this expense?',
      description: `${CATS[e.category].label} · ${money(e.amountCents)} on ${ymdText(e.date)}`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deleteExpense(e.cursor);
      toast.success('Expense deleted.');
      load();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  const net = r ? r.incomeCents - r.totalCents : 0;
  const span = r?.period.quarter ? 'quarter' : 'season';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Expenses"
        description="Track what the club spends: basketballs, insurance, and the monthly facility fee."
        actions={
          <>
            {r && r.seasons.length > 1 && (
              <select
                aria-label="Season"
                value={r.season.year}
                onChange={(e) => {
                  setSeason(Number(e.target.value));
                  setQuarter(null);
                }}
                className="h-8 rounded-lg border bg-background px-2.5 text-sm"
              >
                {r.seasons.map((s) => (
                  <option key={s.year} value={s.year}>
                    {s.label}
                  </option>
                ))}
              </select>
            )}
            {r && (
              <select
                aria-label="Period"
                value={quarter ?? ''}
                onChange={(e) => setQuarter(e.target.value ? Number(e.target.value) : null)}
                className="h-8 rounded-lg border bg-background px-2.5 text-sm"
              >
                <option value="">Whole season</option>
                {r.quarters.map((q) => (
                  <option key={q.quarter} value={q.quarter}>
                    {q.label}
                  </option>
                ))}
              </select>
            )}
            <Button onClick={() => setEditing({})}>
              <Plus /> Add expense
            </Button>
          </>
        }
      />

      {!r ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : (
        <>
          {r.facilityThisMonth === false && r.period.current && Number(r.today.slice(8, 10)) > 5 && (
            <Alert>
              <CalendarClock />
              <AlertTitle>No facility payment recorded for {MONTH(r.today)} yet</AlertTitle>
              <AlertDescription>
                {r.lastAmounts.facility ? `Last one was ${money(r.lastAmounts.facility)}.` : 'Record it once you’ve paid for the month.'}
              </AlertDescription>
              <AlertAction>
                <Button size="sm" variant="outline" onClick={() => setEditing({ category: 'facility' })}>
                  Record it
                </Button>
              </AlertAction>
            </Alert>
          )}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label={`Spent this ${span}`} icon={Wallet} value={money(r.totalCents)} hint={r.period.label} />
            <StatCard
              label="Payments received"
              icon={CircleDollarSign}
              tone="success"
              value={money(r.incomeCents)}
              hint="Confirmed card and cash"
            />
            <StatCard
              label={net < 0 ? `Short this ${span}` : 'Payments minus expenses'}
              icon={Receipt}
              tone={net < 0 ? 'danger' : 'default'}
              value={<span className={cn(net < 0 && 'text-destructive')}>{net < 0 ? '−' : ''}{money(net)}</span>}
              hint="Includes credit players haven’t used yet"
            />
            {r.period.current ? (
              <StatCard label={`Spent in ${MONTH(r.today)}`} icon={CalendarClock} value={money(r.monthCents)} hint="This month" />
            ) : (
              <StatCard label="Expenses" icon={CalendarClock} value={r.expenses.length} hint={`Recorded this ${span}`} />
            )}
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>By category</CardTitle>
                <CardDescription>{r.period.label}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {ORDER.map((c) => {
                  const v = r.byCategory[c] ?? 0;
                  const rawPct = r.totalCents ? (v / r.totalCents) * 100 : 0;
                  const pct = v > 0 ? Math.max(1, Math.round(rawPct)) : 0;
                  const Icon = CATS[c].icon;
                  return (
                    <div key={c}>
                      <div className="mb-1.5 flex items-center justify-between text-sm">
                        <span className="flex items-center gap-2">
                          <Icon className="size-4 text-muted-foreground" /> {CATS[c].label}
                        </span>
                        <span className="tabular font-medium">
                          {money(v)} <span className="text-xs font-normal text-muted-foreground">· {pct}%</span>
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-muted">
                        <div className={cn('h-full rounded-full', CATS[c].color)} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>All expenses</CardTitle>
                <CardDescription>
                  {r.expenses.length} recorded · {ymdText(r.period.start)} – {ymdText(r.period.end)}
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-1">
                {r.expenses.length === 0 ? (
                  <Empty className="border">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Receipt />
                      </EmptyMedia>
                      <EmptyTitle>No expenses yet</EmptyTitle>
                      <EmptyDescription>Add the facility fee, insurance or new basketballs as you pay for them.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>What</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead className="w-20">
                          <span className="sr-only">Actions</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {r.expenses.map((e) => (
                        <TableRow key={e.expenseId}>
                          <TableCell className="whitespace-nowrap text-muted-foreground">{ymdText(e.date)}</TableCell>
                          <TableCell className="max-w-72">
                            <Badge variant="secondary">{CATS[e.category].label}</Badge>
                            {e.note && <span className="ml-2 text-sm">{e.note}</span>}
                            <div className="mt-0.5 text-xs text-muted-foreground">Added by {e.createdByName}</div>
                          </TableCell>
                          <TableCell className="tabular text-right font-medium">{money(e.amountCents)}</TableCell>
                          <TableCell className="text-right whitespace-nowrap">
                            <Button variant="ghost" size="icon-sm" aria-label="Edit expense" onClick={() => setEditing({ expense: e })}>
                              <Pencil />
                            </Button>
                            <Button variant="ghost" size="icon-sm" aria-label="Delete expense" onClick={() => remove(e)}>
                              <Trash2 />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}

      {editing && r && (
        <ExpenseDialog
          key={editing.expense?.expenseId ?? editing.category ?? 'new'}
          expense={editing.expense}
          category={editing.category}
          today={r.today}
          lastAmounts={r.lastAmounts}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

const schema = z.object({
  category: z.enum(['basketballs', 'insurance', 'facility', 'other']),
  amount: z
    .string()
    .trim()
    .regex(/^\$?\d{1,3}(,?\d{3})*(\.\d{1,2})?$|^\$?\d+(\.\d{1,2})?$/, 'Enter an amount like 250 or 59.99')
    .refine((v) => toCents(v) > 0, 'Amount must be more than $0')
    .refine((v) => toCents(v) <= 10_000_000, 'That’s more than $100,000. Check the amount.'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date'),
  note: z.string().trim().max(200, '200 characters at most'),
});
type Values = z.infer<typeof schema>;

function toCents(v: string): number {
  return Math.round(Number(v.replace(/[$,\s]/g, '')) * 100);
}
const dollars = (cents?: number) => (cents ? (cents / 100).toFixed(2).replace(/\.00$/, '') : '');

function ExpenseDialog({
  expense,
  category,
  today,
  lastAmounts,
  onClose,
  onSaved,
}: {
  expense?: Expense;
  category?: ExpenseCategory;
  today: string;
  lastAmounts: ExpenseReport['lastAmounts'];
  onClose: () => void;
  onSaved: () => void;
}) {
  const start = expense?.category ?? category ?? 'facility';
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      category: start,
      amount: dollars(expense?.amountCents ?? lastAmounts[start]),
      date: expense?.date ?? today,
      note: expense?.note ?? (start === 'facility' && !expense ? `${MONTH(today)} gym rental` : ''),
    },
  });
  const cat = form.watch('category');
  const date = form.watch('date');

  // Keep the suggested facility note in step with the chosen date (unless the user typed their own).
  useEffect(() => {
    if (expense || form.getValues('category') !== 'facility' || form.getFieldState('note').isDirty || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    form.setValue('note', `${MONTH(date)} gym rental`);
  }, [date, expense, form]);

  // Switching category on a new expense suggests that category’s usual amount.
  function pick(c: ExpenseCategory) {
    form.setValue('category', c);
    if (!expense) {
      if (!form.getFieldState('amount').isDirty) form.setValue('amount', dollars(lastAmounts[c]));
      if (!form.getFieldState('note').isDirty) form.setValue('note', c === 'facility' ? `${MONTH(form.getValues('date'))} gym rental` : '');
    }
  }

  const submit = form.handleSubmit(async (v) => {
    const body = { category: v.category, amountCents: toCents(v.amount), date: v.date, note: v.note || undefined };
    try {
      if (expense) await api.updateExpense(expense.cursor, body);
      else await api.addExpense(body);
      toast.success(expense ? 'Expense updated.' : `${CATS[v.category].label} expense added.`);
      onSaved();
    } catch (e: any) {
      toast.error(e.message);
    }
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>{expense ? 'Edit expense' : 'Add an expense'}</DialogTitle>
            <DialogDescription>Record it once it’s paid. It counts toward the season it falls in.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-5">
            <Controller
              control={form.control}
              name="category"
              render={() => (
                <Field>
                  <FieldLabel>Category</FieldLabel>
                  <div role="radiogroup" aria-label="Category" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {ORDER.map((c) => {
                      const Icon = CATS[c].icon;
                      const on = cat === c;
                      return (
                        <button
                          key={c}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          onClick={() => pick(c)}
                          className={cn(
                            'flex flex-col items-center gap-1.5 rounded-lg border px-2 py-2.5 text-xs font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                            on ? 'border-primary bg-primary/5 text-foreground ring-1 ring-primary' : 'text-muted-foreground hover:bg-muted',
                          )}
                        >
                          <Icon className="size-4" />
                          {CATS[c].label}
                        </button>
                      );
                    })}
                  </div>
                </Field>
              )}
            />
            <div className="grid grid-cols-2 gap-4">
              <FormInput control={form.control} name="amount" label="Amount ($)" inputMode="decimal" placeholder="0.00" autoComplete="off" />
              <FormInput control={form.control} name="date" label="Date paid" type="date" max={today} />
            </div>
            <FormInput control={form.control} name="note" label="Note (optional)" placeholder={CATS[cat].hint} maxLength={200} autoComplete="off" />
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Spinner />} {expense ? 'Save' : 'Add expense'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
