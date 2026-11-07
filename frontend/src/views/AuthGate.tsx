// Cognito sign in / sign up / email confirmation, validated with React Hook Form + Zod.
// Renders children (with a sign-out callback) once a session exists.
import { useEffect, useState, type ReactNode } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { confirmSignUp, getCurrentUser, resendSignUpCode, signIn, signOut, signUp } from 'aws-amplify/auth';
import { toast } from 'sonner';
import { LogoMark } from '@/components/brand';
import { FormInput } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';

type Mode = 'signin' | 'signup' | 'confirm';

const email = z.string().trim().toLowerCase().email('Enter a valid email address');
const signInSchema = z.object({ email, password: z.string().min(1, 'Enter your password') });
const signUpSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name'),
  email,
  password: z
    .string()
    .min(8, 'At least 8 characters')
    .regex(/[a-z]/, 'Include a lowercase letter')
    .regex(/\d/, 'Include a number'),
});
const confirmSchema = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') });

export function AuthGate({ children }: { children: (signOut: () => void) => ReactNode }) {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [mode, setMode] = useState<Mode>('signin');
  const [pending, setPending] = useState<{ email: string; password: string } | null>(null);

  useEffect(() => {
    getCurrentUser().then(() => setAuthed(true)).catch(() => setAuthed(false));
  }, []);

  const doSignOut = () => signOut().then(() => setAuthed(false));

  if (authed === null) {
    return (
      <div className="flex min-h-dvh items-center justify-center" data-loading="auth">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }
  if (authed) return <>{children(doSignOut)}</>;

  return (
    <div className="safe-top flex min-h-dvh flex-col items-center justify-center bg-gradient-to-b from-secondary/60 to-background px-4 py-10">
      <div className="mb-6 flex flex-col items-center gap-3 text-center">
        <LogoMark className="size-12" />
        <div>
          <div className="text-lg font-semibold tracking-tight">Oakhurst Basketball</div>
          <div className="text-sm text-muted-foreground">oakhurst-ball.org</div>
        </div>
      </div>
      <Card className="w-full max-w-sm">
        {mode === 'signin' && (
          <SignInForm
            onDone={() => setAuthed(true)}
            onNeedsConfirm={(c) => {
              setPending(c);
              setMode('confirm');
            }}
            onSwitch={() => setMode('signup')}
          />
        )}
        {mode === 'signup' && (
          <SignUpForm
            onDone={(c) => {
              setPending(c);
              setMode('confirm');
            }}
            onSwitch={() => setMode('signin')}
          />
        )}
        {mode === 'confirm' && pending && (
          <ConfirmForm creds={pending} onDone={() => setAuthed(true)} onBack={() => setMode('signin')} />
        )}
      </Card>
    </div>
  );
}

function SignInForm({
  onDone,
  onNeedsConfirm,
  onSwitch,
}: {
  onDone: () => void;
  onNeedsConfirm: (c: { email: string; password: string }) => void;
  onSwitch: () => void;
}) {
  const [error, setError] = useState('');
  const form = useForm<z.infer<typeof signInSchema>>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: '', password: '' },
  });

  const submit = form.handleSubmit(async (v) => {
    setError('');
    try {
      await signIn({ username: v.email, password: v.password });
      onDone();
    } catch (e: any) {
      if (e?.name === 'UserNotConfirmedException') {
        await resendSignUpCode({ username: v.email }).catch(() => {});
        toast.info('Check your email for a verification code.');
        onNeedsConfirm(v);
      } else setError(e?.message ?? 'Sign in failed');
    }
  });

  return (
    <form onSubmit={submit} noValidate>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Players and admins sign in with their email.</CardDescription>
      </CardHeader>
      <CardContent className="pt-4">
        <FieldGroup>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <FormInput control={form.control} name="email" label="Email" type="email" autoComplete="email" inputMode="email" />
          <FormInput control={form.control} name="password" label="Password" type="password" autoComplete="current-password" />
        </FieldGroup>
      </CardContent>
      <CardFooter className="mt-2 flex-col gap-3">
        <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting && <Spinner />} Sign in
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          New to the club?{' '}
          <button type="button" className="font-medium text-foreground underline-offset-4 hover:underline" onClick={onSwitch}>
            Create an account
          </button>
        </p>
      </CardFooter>
    </form>
  );
}

function SignUpForm({ onDone, onSwitch }: { onDone: (c: { email: string; password: string }) => void; onSwitch: () => void }) {
  const [error, setError] = useState('');
  const form = useForm<z.infer<typeof signUpSchema>>({
    resolver: zodResolver(signUpSchema),
    defaultValues: { name: '', email: '', password: '' },
  });

  const submit = form.handleSubmit(async (v) => {
    setError('');
    try {
      await signUp({ username: v.email, password: v.password, options: { userAttributes: { email: v.email, name: v.name } } });
      toast.success('We emailed you a 6-digit code.');
      onDone({ email: v.email, password: v.password });
    } catch (e: any) {
      setError(e?.message ?? 'Sign up failed');
    }
  });

  return (
    <form onSubmit={submit} noValidate>
      <CardHeader>
        <CardTitle>Create your account</CardTitle>
        <CardDescription>Track your balance, passes and attendance.</CardDescription>
      </CardHeader>
      <CardContent className="pt-4">
        <FieldGroup>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <FormInput control={form.control} name="name" label="Full name" autoComplete="name" />
          <FormInput control={form.control} name="email" label="Email" type="email" autoComplete="email" inputMode="email" />
          <FormInput
            control={form.control}
            name="password"
            label="Password"
            type="password"
            autoComplete="new-password"
            description="At least 8 characters, with a lowercase letter and a number."
          />
        </FieldGroup>
      </CardContent>
      <CardFooter className="mt-2 flex-col gap-3">
        <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting && <Spinner />} Create account
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{' '}
          <button type="button" className="font-medium text-foreground underline-offset-4 hover:underline" onClick={onSwitch}>
            Sign in
          </button>
        </p>
      </CardFooter>
    </form>
  );
}

function ConfirmForm({
  creds,
  onDone,
  onBack,
}: {
  creds: { email: string; password: string };
  onDone: () => void;
  onBack: () => void;
}) {
  const [error, setError] = useState('');
  const form = useForm<z.infer<typeof confirmSchema>>({ resolver: zodResolver(confirmSchema), defaultValues: { code: '' } });

  const submit = form.handleSubmit(async (v) => {
    setError('');
    try {
      await confirmSignUp({ username: creds.email, confirmationCode: v.code });
      await signIn({ username: creds.email, password: creds.password });
      toast.success('Welcome to Oakhurst Basketball!');
      onDone();
    } catch (e: any) {
      setError(e?.message ?? 'Confirmation failed');
    }
  });

  const resend = async () => {
    try {
      await resendSignUpCode({ username: creds.email });
      toast.success('A new code is on its way.');
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not resend the code');
    }
  };

  return (
    <form onSubmit={submit} noValidate>
      <CardHeader>
        <CardTitle>Check your email</CardTitle>
        <CardDescription>
          Enter the 6-digit code we sent to <span className="font-medium text-foreground">{creds.email}</span>.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-4">
        <FieldGroup>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Controller
            control={form.control}
            name="code"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined} className="items-center">
                <FieldLabel htmlFor="code" className="sr-only">
                  Verification code
                </FieldLabel>
                <InputOTP
                  id="code"
                  maxLength={6}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={field.value}
                  onChange={field.onChange}
                  aria-invalid={fieldState.invalid || undefined}
                >
                  <InputOTPGroup>
                    {[0, 1, 2, 3, 4, 5].map((i) => (
                      <InputOTPSlot key={i} index={i} className="size-11 text-lg" />
                    ))}
                  </InputOTPGroup>
                </InputOTP>
                {fieldState.error && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
        </FieldGroup>
      </CardContent>
      <CardFooter className="mt-2 flex-col gap-3">
        <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting && <Spinner />} Verify and sign in
        </Button>
        <div className="flex w-full justify-between text-sm">
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onBack}>
            Back
          </button>
          <button type="button" className="font-medium hover:underline" onClick={resend}>
            Resend code
          </button>
        </div>
      </CardFooter>
    </form>
  );
}
