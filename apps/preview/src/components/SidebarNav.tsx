import type { ComponentType, KeyboardEvent, ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

// Parts adapted from cmp_sidebars_workspace-01: identity row, grouped rows with
// icons and count badges, children that open on a grid-rows transition beside a
// guide line, and a bottom-pinned action block.

type Icon = ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: boolean }>;

const rowBase =
  'group flex w-full items-center justify-between gap-2 rounded-[6px] px-2.5 py-[7px] text-left select-none transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 sidebar-nav-row';

export function SidebarIdentity({
  markSrc,
  title,
  detail,
  onClick,
}: {
  markSrc: string;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${title} home`}
      className="group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors select-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <img src={markSrc} alt="" className="size-8 shrink-0" />
      <span className="flex min-w-0 flex-col">
        <span className="mb-1 truncate text-[13px] leading-none font-medium text-foreground">{title}</span>
        <span className="truncate text-[11px] leading-none text-muted-foreground tabular-nums">{detail}</span>
      </span>
    </button>
  );
}

export function SidebarGroup({
  heading,
  count,
  expanded,
  onExpandedChange,
  children,
}: {
  heading?: string;
  count?: number;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  children: ReactNode;
}) {
  const collapsible = heading !== undefined && onExpandedChange !== undefined;
  const open = !collapsible || expanded;

  return (
    <div className="flex flex-col gap-0.5">
      {heading !== undefined ? (
        collapsible ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={typeof count === 'number' ? `${heading}, ${count} blocks` : heading}
            onClick={() => onExpandedChange(!open)}
            className="group mb-1 flex items-center justify-between rounded-[6px] px-2.5 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase transition-colors group-hover:text-foreground">
              {heading}
            </span>
            <span className="flex items-center gap-1.5 text-muted-foreground transition-colors group-hover:text-foreground">
              {typeof count === 'number' ? (
                <span className="text-[11px] font-medium tabular-nums">{count}</span>
              ) : null}
              <ChevronDown
                aria-hidden={true}
                strokeWidth={1.5}
                className={cn('size-3.5 transition-transform duration-200', !open && '-rotate-90')}
              />
            </span>
          </button>
        ) : (
          <span className="mb-1 px-2.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
            {heading}
          </span>
        )
      ) : null}
      <Reveal open={open}>{children}</Reveal>
    </div>
  );
}

function Reveal({ open, children, guide }: { open: boolean; children: ReactNode; guide?: boolean }) {
  return (
    <div
      aria-hidden={!open}
      inert={!open}
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]',
        open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
      )}
    >
      <div className={cn('relative flex min-h-0 flex-col gap-0.5 overflow-hidden', guide && 'mt-0.5')}>
        {guide ? (
          <span aria-hidden="true" className="absolute top-0 bottom-0 left-[17.5px] border-l border-foreground/10" />
        ) : null}
        {children}
      </div>
    </div>
  );
}

export function SidebarItem({
  icon: ItemIcon,
  title,
  badge,
  shortcut,
  active = false,
  disabled,
  onSelect,
}: {
  icon: Icon;
  title: string;
  badge?: number | string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-current={active ? 'page' : undefined}
      onClick={onSelect}
      className={cn(
        rowBase,
        active
          ? 'bg-foreground/[0.07] font-medium text-foreground'
          : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <ItemIcon
          aria-hidden={true}
          strokeWidth={1.5}
          className={cn(
            'size-4 shrink-0 transition-colors',
            active ? 'text-brand' : 'text-muted-foreground/80 group-hover:text-foreground/80',
          )}
        />
        <span className="truncate text-[13px]">{title}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {shortcut ? <SidebarKbd>{shortcut}</SidebarKbd> : null}
        {badge !== undefined ? <SidebarBadge>{badge}</SidebarBadge> : null}
      </span>
    </button>
  );
}

export function SidebarFolder({
  icon: ItemIcon,
  title,
  badge,
  expanded,
  onExpandedChange,
  children,
}: {
  icon: Icon;
  title: string;
  badge?: number;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  children: ReactNode;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowRight' && !expanded) {
      event.preventDefault();
      onExpandedChange(true);
    } else if (event.key === 'ArrowLeft' && expanded) {
      event.preventDefault();
      onExpandedChange(false);
    }
  };

  return (
    <div className="flex w-full flex-col">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => onExpandedChange(!expanded)}
        onKeyDown={onKeyDown}
        className={cn(rowBase, 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground')}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <ItemIcon
            aria-hidden={true}
            strokeWidth={1.5}
            className="size-4 shrink-0 text-muted-foreground/80 transition-colors group-hover:text-foreground/80"
          />
          <span className="truncate text-[13px]">{title}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {badge !== undefined ? <SidebarBadge>{badge}</SidebarBadge> : null}
          <ChevronRight
            aria-hidden={true}
            strokeWidth={2}
            className={cn(
              'size-3.5 text-muted-foreground/60 transition-transform duration-200',
              expanded && 'rotate-90',
            )}
          />
        </span>
      </button>
      <Reveal open={expanded} guide>
        {children}
      </Reveal>
    </div>
  );
}

export function SidebarLeaf({
  title,
  active,
  onSelect,
}: {
  title: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onSelect}
      className={cn(
        rowBase,
        'relative pl-[30px]',
        active
          ? 'sidebar-nav-leaf-active bg-foreground/[0.07] font-medium text-foreground'
          : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
      )}
    >
      <span className="truncate text-[13px]">{title}</span>
    </button>
  );
}

export function SidebarFooter({ children }: { children: ReactNode }) {
  return <div className="mt-auto flex flex-col gap-0.5 border-t border-border/70 px-3 pt-3 pb-3">{children}</div>;
}

export function SidebarKbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 items-center justify-center rounded-[4px] border border-border/70 bg-background/60 px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}

function SidebarBadge({ children }: { children: ReactNode }) {
  return (
    <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-foreground/[0.06] px-1.5 text-[10px] font-medium text-muted-foreground tabular-nums">
      {children}
    </span>
  );
}
