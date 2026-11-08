// Cognito sign in / sign up / email confirmation, validated with React Hook Form + Zod.
// Renders children (with a sign-out callback) once a session exists.
import { useEffect, useState, type ReactNode } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { confirmResetPassword, confirmSignUp, getCurrentUser, resendSignUpCode, resetPassword, signIn, signOut, signUp } from 'aws-amplify/auth';
import { toast } from 'sonner';
import { LogoMark } from '@/components/brand';
import { FormInput } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { disableNotifications } from '@/notifications';
import { AgreementsGate } from './Agreements';

type Mode = 'signin' | 'signup' | 'confirm' | 'forgot';

/** Friendly text for common Cognito errors; falls back to the raw message. */
function authError(e: any, fallback: string) {
  switch (e?.name) {
    case 'NotAuthorizedException':
    case 'UserNotFoundException':
      return 'Wrong email or password.';
    case 'UsernameExistsException':
      return 'That email already has an account. Try signing in.';
    case 'CodeMismatchException':
      return 'That code isn’t right. Check it and try again.';
    case 'ExpiredCodeException':
      return 'That code has expired. Request a new one.';
    case 'LimitExceededException':
    case 'TooManyRequestsException':
      return 'Too many attempts. Wait a few minutes and try again.';
    default:
      return e?.message ?? fallback;
  }
}

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
const forgotSchema = z.object({ email });
const resetSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
  password: signUpSchema.shape.password,
});
const confirmSchema = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') });

export function AuthGate({ children }: { children: (signOut: () => void) => ReactNode }) {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [mode, setMode] = useState<Mode>('signin');
  const [pending, setPending] = useState<{ email: string; password: string } | null>(null);

  useEffect(() => {
    getCurrentUser().then(() => setAuthed(true)).catch(() => setAuthed(false));
  }, []);

  // Unregister this device first (needs the token), so the next person to sign in
  // here doesn't get the previous user's notifications.
  const doSignOut = () =>
    disableNotifications()
      .catch(() => {})
      .then(() => signOut())
      .then(() => setAuthed(false));

  if (authed === null) {
    return (
      <div className="flex min-h-dvh items-center justify-center" data-loading="auth">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }
  if (authed) return <AgreementsGate onSignOut={doSignOut}>{children(doSignOut)}</AgreementsGate>;

  return (
    <div className="safe-top flex min-h-dvh flex-col items-center justify-center bg-gradient-to-b from-secondary/60 to-background px-4 py-10">
      <div className="mb-6 flex flex-col items-center gap-3 text-center">
        <LogoMark className="size-12" />
        <div>
          <div className="text-lg font-semibold tracking-tight">Oakhurst Basketball</div>
          <div className="text-sm text-muted-foreground">{window.location.host}</div>
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
            onForgot={() => setMode('forgot')}
          />
        )}
        {mode === 'forgot' && (
          <ForgotForm
            onBack={() => setMode('signin')}
            onSignedIn={() => setAuthed(true)}
            onReset={() => {
              toast.success('Password updated. Sign in with your new password.');
              setMode('signin');
            }}
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
  onForgot,
}: {
  onDone: () => void;
  onNeedsConfirm: (c: { email: string; password: string }) => void;
  onSwitch: () => void;
  onForgot: () => void;
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
      } else setError(authError(e, 'Sign in failed'));
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
          <button type="button" className="-mt-2 self-start text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" onClick={onForgot}>
            Forgot your password?
          </button>
        </FieldGroup>
      </CardContent>
      <CardFooter className="mt-2 flex-col gap-3">
        <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting && <Spinner />} Sign in
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          New to the club?{' '}
          <button type="button" className="font-medium text-foreground underline-offset-4 hover:underline" onClick={onSwitch}>
            Create account
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
      setError(authError(e, 'Sign up failed'));
    }
  });

  return (
    <form onSubmit={submit} noValidate>
      <CardHeader>
        <CardTitle>Create account</CardTitle>
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
          <p className="text-xs text-muted-foreground">After you confirm your email, you’ll sign the club waiver and agree to the Club Rules and Play Rules.</p>
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

function ForgotForm({ onBack, onReset, onSignedIn }: { onBack: () => void; onReset: () => void; onSignedIn: () => void }) {
  const [sentTo, setSentTo] = useState('');
  const [error, setError] = useState('');
  const emailForm = useForm<z.infer<typeof forgotSchema>>({ resolver: zodResolver(forgotSchema), defaultValues: { email: '' } });
  const resetForm = useForm<z.infer<typeof resetSchema>>({ resolver: zodResolver(resetSchema), defaultValues: { code: '', password: '' } });

  const send = async (addr: string) => {
    setError('');
    try {
      await resetPassword({ username: addr });
      setSentTo(addr);
      toast.success('We emailed you a 6-digit code.');
    } catch (e: any) {
      setError(authError(e, 'Couldn’t send the code'));
    }
  };
  const submitEmail = emailForm.handleSubmit((v) => send(v.email));
  const submitReset = resetForm.handleSubmit(async (v) => {
    setError('');
    try {
      await confirmResetPassword({ username: sentTo, confirmationCode: v.code, newPassword: v.password });
      try {
        await signIn({ username: sentTo, password: v.password });
        toast.success('Password updated. You’re signed in.');
        onSignedIn();
      } catch {
        onReset();
      }
    } catch (e: any) {
      setError(authError(e, 'Couldn’t reset the password'));
    }
  });

  const errorAlert = error && (
    <Alert variant="destructive">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );

  if (!sentTo) {
    return (
      <form onSubmit={submitEmail} noValidate>
        <CardHeader>
          <CardTitle>Reset your password</CardTitle>
          <CardDescription>Enter your email and we’ll send you a 6-digit code.</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <FieldGroup>
            {errorAlert}
            <FormInput control={emailForm.control} name="email" label="Email" type="email" autoComplete="email" inputMode="email" />
          </FieldGroup>
        </CardContent>
        <CardFooter className="mt-2 flex-col gap-3">
          <Button type="submit" size="lg" className="w-full" disabled={emailForm.formState.isSubmitting}>
            {emailForm.formState.isSubmitting && <Spinner />} Send code
          </Button>
          <button type="button" className="text-sm text-muted-foreground hover:text-foreground" onClick={onBack}>
            Back to sign in
          </button>
        </CardFooter>
      </form>
    );
  }

  return (
    <form onSubmit={submitReset} noValidate>
      <CardHeader>
        <CardTitle>Choose a new password</CardTitle>
        <CardDescription>
          Enter the 6-digit code we sent to <span className="font-medium text-foreground">{sentTo}</span>.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-4">
        <FieldGroup>
          {errorAlert}
          <Controller
            control={resetForm.control}
            name="code"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined} className="items-center">
                <FieldLabel htmlFor="reset-code" className="sr-only">
                  Verification code
                </FieldLabel>
                <InputOTP
                  id="reset-code"
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
          <FormInput
            control={resetForm.control}
            name="password"
            label="New password"
            type="password"
            autoComplete="new-password"
            description="At least 8 characters, with a lowercase letter and a number."
          />
        </FieldGroup>
      </CardContent>
      <CardFooter className="mt-2 flex-col gap-3">
        <Button type="submit" size="lg" className="w-full" disabled={resetForm.formState.isSubmitting}>
          {resetForm.formState.isSubmitting && <Spinner />} Update password
        </Button>
        <div className="flex w-full justify-between text-sm">
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={onBack}>
            Back to sign in
          </button>
          <button type="button" className="font-medium hover:underline" onClick={() => send(sentTo)}>
            Resend code
          </button>
        </div>
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
      setError(authError(e, 'Confirmation failed'));
    }
  });

  const resend = async () => {
    try {
      await resendSignUpCode({ username: creds.email });
      toast.success('A new code is on its way.');
    } catch (e: any) {
      toast.error(authError(e, 'Couldn’t resend the code'));
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
            Use a different email
          </button>
          <button type="button" className="font-medium hover:underline" onClick={resend}>
            Resend code
          </button>
        </div>
      </CardFooter>
    </form>
  );
}
