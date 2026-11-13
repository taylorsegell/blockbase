import * as MenubarPrimitive from '@radix-ui/react-menubar';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Menubar = ({
  className,
  ...props
}: ComponentProps<typeof MenubarPrimitive.Root>) => (
  <MenubarPrimitive.Root
    className={cn(
      'flex h-10 items-center gap-1 rounded-md border bg-background p-1',
      className,
    )}
    {...props}
  />
);

export const MenubarMenu = MenubarPrimitive.Menu;
export const MenubarGroup = MenubarPrimitive.Group;
export const MenubarPortal = MenubarPrimitive.Portal;
export const MenubarRadioGroup = MenubarPrimitive.RadioGroup;
export const MenubarSub = MenubarPrimitive.Sub;

export const MenubarTrigger = ({
  className,
  ...props
}: ComponentProps<typeof MenubarPrimitive.Trigger>) => (
  <MenubarPrimitive.Trigger
    className={cn(
      'flex cursor-default items-center rounded-sm px-3 py-1.5 text-sm font-medium outline-none select-none hover:bg-accent focus:bg-accent data-[state=open]:bg-accent',
      className,
    )}
    {...props}
  />
);

export const MenubarContent = ({
  className,
  align = 'start',
  alignOffset = -4,
  sideOffset = 8,
  ...props
}: ComponentProps<typeof MenubarPrimitive.Content>) => (
  <MenubarPrimitive.Portal>
    <MenubarPrimitive.Content
      align={align}
      alignOffset={alignOffset}
      sideOffset={sideOffset}
      className={cn(
        'z-50 min-w-48 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
        className,
      )}
      {...props}
    />
  </MenubarPrimitive.Portal>
);

export const MenubarItem = ({
  className,
  inset,
  ...props
}: ComponentProps<typeof MenubarPrimitive.Item> & { inset?: boolean }) => (
  <MenubarPrimitive.Item
    className={cn(
      'relative flex cursor-default items-center rounded-sm px-2 py-1.5 text-sm outline-none select-none hover:bg-accent focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      inset && 'pl-8',
      className,
    )}
    {...props}
  />
);

export const MenubarSeparator = ({
  className,
  ...props
}: ComponentProps<typeof MenubarPrimitive.Separator>) => (
  <MenubarPrimitive.Separator
    className={cn('-mx-1 my-1 h-px bg-border', className)}
    {...props}
  />
);

export const MenubarSubTrigger = ({
  className,
  inset,
  children,
  ...props
}: ComponentProps<typeof MenubarPrimitive.SubTrigger> & { inset?: boolean }) => (
  <MenubarPrimitive.SubTrigger
    className={cn(
      'flex cursor-default items-center rounded-sm px-2 py-1.5 text-sm outline-none select-none hover:bg-accent focus:bg-accent data-[state=open]:bg-accent',
      inset && 'pl-8',
      className,
    )}
    {...props}
  >
    {children}
    <span className="ml-auto text-muted-foreground">›</span>
  </MenubarPrimitive.SubTrigger>
);

export const MenubarSubContent = ({
  className,
  ...props
}: ComponentProps<typeof MenubarPrimitive.SubContent>) => (
  <MenubarPrimitive.SubContent
    className={cn(
      'z-50 min-w-32 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
      className,
    )}
    {...props}
  />
);
