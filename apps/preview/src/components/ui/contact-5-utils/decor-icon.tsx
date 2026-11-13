import { PlusIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

const positionClass = {
  'top-left': '-left-[12.5px] -top-[12.5px]',
  'top-right': '-right-[12.5px] -top-[12.5px]',
  'bottom-left': '-left-[12.5px] -bottom-[12.5px]',
  'bottom-right': '-right-[12.5px] -bottom-[12.5px]',
} as const;

export function DecorIcon({
  position,
}: {
  position: keyof typeof positionClass;
}) {
  return (
    <PlusIcon
      className={cn('absolute size-6 text-muted-foreground', positionClass[position])}
      strokeWidth={0.5}
      aria-hidden
    />
  );
}
