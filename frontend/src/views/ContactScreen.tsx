// Phone + emergency contact, required once for every member with an account.
// New sign-ups typed them on the sign-up form, so they're saved silently on
// first sign-in; anyone else (older accounts, a different device) sees this.
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { LogOut, PhoneCall } from 'lucide-react';
import { api } from '@/api';
import { LogoMark } from '@/components/brand';
import { FormInput } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldGroup } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { contactSchema, phoneText, type ContactValues } from '@/lib/contact';

export function ContactScreen({
  initial,
  onSaved,
  onSignOut,
}: {
  initial?: { phone: string | null; emergencyName: string | null; emergencyPhone: string | null } | null;
  onSaved: () => void;
  onSignOut: () => void;
}) {
  const form = useForm<ContactValues>({
    resolver: zodResolver(contactSchema),
    defaultValues: {
      phone: phoneText(initial?.phone),
      emergencyName: initial?.emergencyName ?? '',
      emergencyPhone: phoneText(initial?.emergencyPhone),
    },
  });
  const submit = form.handleSubmit(async (v) => {
    try {
      await api.setContact(v);
      toast.success('Saved.');
      onSaved();
    } catch (e: any) {
      toast.error(e.message);
    }
  });

  return (
    <div className="safe-top safe-bottom flex min-h-dvh flex-col items-center justify-center bg-gradient-to-b from-secondary/60 to-background px-4 py-8">
      <div className="w-full max-w-sm space-y-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <LogoMark className="size-10" />
            <h1 className="text-xl font-semibold tracking-tight">One more step</h1>
          </div>
          <Button variant="ghost" size="sm" onClick={onSignOut} aria-label="Sign out">
            <LogOut /> <span className="hidden sm:inline">Sign out</span>
          </Button>
        </div>
        <Card>
          <form onSubmit={submit} noValidate>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <PhoneCall className="size-4 text-brand" /> Your contact details
              </CardTitle>
              <CardDescription>
                Every player gives a phone number and an emergency contact, in case you get hurt at the gym. Only admins can see them.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
              <FieldGroup>
                <FormInput control={form.control} name="phone" label="Your phone number" type="tel" autoComplete="tel" inputMode="tel" />
                <FormInput control={form.control} name="emergencyName" label="Emergency contact’s name" autoComplete="off" />
                <FormInput
                  control={form.control}
                  name="emergencyPhone"
                  label="Emergency contact’s phone number"
                  type="tel"
                  autoComplete="off"
                  inputMode="tel"
                />
              </FieldGroup>
            </CardContent>
            <CardFooter className="mt-2">
              <Button type="submit" size="lg" className="w-full" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting && <Spinner />} Save and continue
              </Button>
            </CardFooter>
          </form>
        </Card>
      </div>
    </div>
  );
}
