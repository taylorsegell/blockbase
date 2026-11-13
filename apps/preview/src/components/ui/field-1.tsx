import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Field({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-3', className)} {...props} />;
}

export function FieldGroup({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-6', className)} {...props} />;
}

export function FieldLabel({ className, ...props }: ComponentProps<'label'>) {
  return (
    <label
      className={cn('text-sm leading-none font-medium', className)}
      {...props}
    />
  );
}

export function FieldDescription({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p className={cn('text-sm text-muted-foreground', className)} {...props} />
  );
}
