// React Hook Form + shadcn Field glue: label, control, description and the Zod
// error message, with aria-invalid wired up for screen readers.
import type { ReactNode } from 'react';
import { Controller, type Control, type FieldPath, type FieldValues } from 'react-hook-form';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

type InputProps = Omit<React.ComponentProps<typeof Input>, 'name' | 'value' | 'onChange' | 'onBlur'>;

export function FormInput<T extends FieldValues>({
  control,
  name,
  label,
  description,
  ...input
}: { control: Control<T>; name: FieldPath<T>; label: string; description?: ReactNode } & InputProps) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid || undefined}>
          <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
          <Input
            id={field.name}
            aria-invalid={fieldState.invalid || undefined}
            {...input}
            {...field}
            value={field.value ?? ''}
          />
          {description && !fieldState.error && <FieldDescription>{description}</FieldDescription>}
          {fieldState.error && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );
}
