import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function InputGroup({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex h-9 w-full items-center overflow-hidden rounded-md border border-input bg-transparent shadow-xs focus-within:ring-2 focus-within:ring-ring',
        className,
      )}
      {...props}
    />
  );
}

export function InputGroupAddon({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex items-center px-3 text-muted-foreground [&_svg]:size-4', className)}
      {...props}
    />
  );
}

export function InputGroupInput({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-full min-w-0 flex-1 bg-transparent py-1 pr-3 text-sm outline-none placeholder:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
