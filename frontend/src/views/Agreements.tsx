// Waiver + club rules. Every signed-in page sits behind AgreementsGate: a player
// who hasn't signed the current versions sees this screen first (new sign-ups
// right after their first sign-in, everyone else when either document changes).
import { useEffect, useState, type ReactNode } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { FileSignature, ListChecks, LogOut, ScrollText } from 'lucide-react';
import { api, type AgreementDoc, type AgreementsStatus } from '@/api';
import { LogoMark } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { longDateOf } from '@/lib/format';
import { cn } from '@/lib/utils';

export function AgreementsGate({ children, onSignOut }: { children: ReactNode; onSignOut: () => void }) {
  const [s, setS] = useState<AgreementsStatus | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api
      .agreements()
      .then(setS)
      .catch(() => setFailed(true)); // never lock people out over a network blip
  }, []);

  if (failed || (s && (s.current || !s.hasPlayer))) return <>{children}</>;
  if (!s) {
    return (
      <div className="flex min-h-dvh items-center justify-center" data-loading="agreements">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }
  return (
    <SignScreen
      waiver={s.waiver}
      rules={s.rules}
      changed={!!s.signed}
      defaultName={s.signed?.signedName}
      submit={(b) => api.signAgreements(b)}
      onSigned={() => setS({ ...s, current: true })}
      exit={{ label: 'Sign out', icon: <LogOut />, onClick: onSignOut }}
    />
  );
}

export type SignatureBody = Parameters<typeof api.signAgreements>[0];

const NAME = z
  .string()
  .trim()
  .min(3, 'Type your full name')
  .max(100)
  .refine((v) => /\s/.test(v), 'Type your first and last name');

const schema = z
  .object({
    agreeRules: z.boolean().refine((v) => v, 'Please acknowledge the club rules'),
    adult: z.enum(['yes', 'no'], { message: 'Choose one' }),
    signedName: NAME,
    guardianName: z.string().trim().max(100).optional(),
    agreeWaiver: z.boolean().refine((v) => v, 'Please agree to the waiver to continue'),
  })
  .superRefine((v, ctx) => {
    if (v.adult === 'no') {
      const r = NAME.safeParse(v.guardianName ?? '');
      if (!r.success) ctx.addIssue({ code: 'custom', path: ['guardianName'], message: 'A parent or guardian must type their full name' });
    }
  });
type Values = z.infer<typeof schema>;

/**
 * The waiver + rules signing screen. Used after sign-in (AgreementsGate) and on
 * the kiosk, which submits through its own device-authenticated endpoint.
 */
export function SignScreen({
  waiver,
  rules,
  changed,
  defaultName,
  submit: send,
  onSigned,
  exit,
  heading,
  onActivity,
}: {
  waiver: AgreementDoc;
  rules: AgreementDoc;
  /** Signed before, but a document has a new version. */
  changed: boolean;
  defaultName?: string;
  submit: (b: SignatureBody) => Promise<unknown>;
  onSigned: () => void;
  exit: { label: string; icon: ReactNode; onClick: () => void };
  heading?: string;
  /** Called on any touch/typing (the kiosk uses it to keep its idle timer from resetting). */
  onActivity?: () => void;
}) {
  const s = { waiver, rules };
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { agreeRules: false, adult: undefined as any, signedName: defaultName ?? '', guardianName: '', agreeWaiver: false },
  });
  const adult = form.watch('adult');

  const submit = form.handleSubmit(async (v) => {
    try {
      await send({
        waiverVersion: s.waiver.version,
        rulesVersion: s.rules.version,
        agreeRules: v.agreeRules,
        agreeWaiver: v.agreeWaiver,
        signedName: v.signedName,
        adult: v.adult === 'yes',
        guardianName: v.adult === 'no' ? v.guardianName : undefined,
      });
      toast.success('Thanks! You’re all set.');
      window.scrollTo({ top: 0 });
      onSigned();
    } catch (e: any) {
      toast.error(e.message);
    }
  });

  return (
    <div
      className="safe-top safe-bottom min-h-dvh bg-gradient-to-b from-secondary/60 to-background px-4 py-8"
      onPointerDown={onActivity}
      onKeyDown={onActivity}
      onScroll={onActivity}
    >
      <div className="mx-auto max-w-2xl space-y-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <LogoMark className="size-10" />
            <div>
              <h1 className="text-xl font-semibold tracking-tight">
                {heading ?? (changed ? 'Our waiver or rules changed' : 'One more step')}
              </h1>
              <p className="text-sm text-muted-foreground">
                {changed ? 'Please read and sign the updated version to keep playing.' : 'Every player signs the waiver and agrees to the club rules before playing.'}
              </p>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={exit.onClick}>
            {exit.icon} <span className="hidden sm:inline">{exit.label}</span>
          </Button>
        </div>

        <form onSubmit={submit} noValidate className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ListChecks className="size-4 text-brand" /> {s.rules.title}
              </CardTitle>
              <CardDescription>{s.rules.intro}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ol className="space-y-2 text-sm">
                {s.rules.sections.map((r, i) => (
                  <li key={i} className="rounded-lg bg-muted/50 px-3 py-2">
                    {r.body}
                  </li>
                ))}
              </ol>
              <CheckRow control={form.control} name="agreeRules" label="I’ve read the club rules and I’ll follow them." />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ScrollText className="size-4 text-brand" /> {s.waiver.title}
              </CardTitle>
              <CardDescription className="font-medium text-foreground">{s.waiver.intro}</CardDescription>
            </CardHeader>
            <CardContent>
              <DocText doc={s.waiver} className="max-h-[50dvh] overflow-y-auto rounded-lg border bg-muted/30 p-4" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileSignature className="size-4 text-brand" /> Sign
              </CardTitle>
              <CardDescription>Your typed name is your electronic signature. We record it with the date and time.</CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <Controller
                  control={form.control}
                  name="adult"
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid || undefined}>
                      <FieldLabel>Is the player 18 or older?</FieldLabel>
                      <div role="radiogroup" aria-label="Is the player 18 or older?" className="grid gap-2 sm:grid-cols-2">
                        {(
                          [
                            ['yes', 'Yes, I’m 18 or older'],
                            ['no', 'No, a parent or guardian is signing'],
                          ] as const
                        ).map(([v, label]) => (
                          <button
                            key={v}
                            type="button"
                            role="radio"
                            aria-checked={field.value === v}
                            onClick={() => field.onChange(v)}
                            className={cn(
                              'rounded-lg border px-3 py-2.5 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                              field.value === v ? 'border-primary bg-primary/5 font-medium ring-1 ring-primary' : 'hover:bg-muted',
                            )}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      {fieldState.error && <FieldError errors={[fieldState.error]} />}
                    </Field>
                  )}
                />
                <TextField control={form.control} name="signedName" label={adult === 'no' ? 'Player’s full name' : 'Your full name'} autoComplete="name" />
                {adult === 'no' && (
                  <TextField
                    control={form.control}
                    name="guardianName"
                    label="Parent or guardian’s full name"
                    description="The parent or guardian signs on the player’s behalf and their own."
                  />
                )}
                <CheckRow
                  control={form.control}
                  name="agreeWaiver"
                  label={
                    adult === 'no'
                      ? 'As the parent or guardian, I have read this waiver, I understand I am giving up legal rights for myself and the player, and I agree to it.'
                      : 'I have read this waiver, I understand I am giving up legal rights, and I agree to it.'
                  }
                />
              </FieldGroup>
            </CardContent>
            <CardFooter className="justify-end">
              <Button type="submit" size="lg" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? <Spinner /> : <FileSignature />} Sign and continue
              </Button>
            </CardFooter>
          </Card>
        </form>
      </div>
    </div>
  );
}

function DocText({ doc, className }: { doc: AgreementDoc; className?: string }) {
  return (
    <div className={cn('space-y-3 text-sm leading-relaxed', className)}>
      {doc.sections.map((sec, i) => (
        <section key={i}>
          {sec.heading && <h3 className="font-medium">{sec.heading}</h3>}
          <p className="text-muted-foreground">{sec.body}</p>
        </section>
      ))}
    </div>
  );
}

function CheckRow({ control, name, label }: { control: any; name: 'agreeRules' | 'agreeWaiver'; label: string }) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid || undefined}>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
            <input
              type="checkbox"
              checked={!!field.value}
              onChange={(e) => field.onChange(e.target.checked)}
              onBlur={field.onBlur}
              aria-invalid={fieldState.invalid || undefined}
              className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
            />
            <span>{label}</span>
          </label>
          {fieldState.error && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );
}

function TextField({
  control,
  name,
  label,
  description,
  autoComplete,
}: {
  control: any;
  name: 'signedName' | 'guardianName';
  label: string;
  description?: string;
  autoComplete?: string;
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid || undefined}>
          <FieldLabel htmlFor={name}>{label}</FieldLabel>
          <Input
            id={name}
            {...field}
            value={field.value ?? ''}
            autoComplete={autoComplete ?? 'off'}
            aria-invalid={fieldState.invalid || undefined}
            className="h-11 font-serif text-lg italic"
          />
          {description && !fieldState.error && <FieldDescription>{description}</FieldDescription>}
          {fieldState.error && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );
}

/** Read-only view of the signed documents (account menu → Waiver & rules). */
export function AgreementsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [s, setS] = useState<AgreementsStatus | null>(null);
  useEffect(() => {
    if (open && !s) api.agreements().then(setS).catch((e) => toast.error(e.message));
  }, [open, s]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Waiver & club rules</DialogTitle>
          <DialogDescription>
            {s?.signed ? `Signed by ${s.signed.signedName} on ${longDateOf(s.signed.agreedAt)}.` : s ? 'Not signed yet.' : 'Loading…'}
          </DialogDescription>
        </DialogHeader>
        {s && (
          <div className="space-y-5">
            <div>
              <h3 className="mb-2 font-medium">{s.rules.title}</h3>
              <ol className="space-y-1.5 text-sm text-muted-foreground">
                {s.rules.sections.map((r, i) => (
                  <li key={i}>{r.body}</li>
                ))}
              </ol>
            </div>
            <div>
              <h3 className="mb-1 font-medium">{s.waiver.title}</h3>
              <p className="mb-3 text-sm">{s.waiver.intro}</p>
              <DocText doc={s.waiver} />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
