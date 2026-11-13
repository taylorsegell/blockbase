import {
  Children,
  createContext,
  forwardRef,
  isValidElement,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ButtonHTMLAttributes,
  ComponentType,
  HTMLAttributes,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
} from 'react';
import { LayoutGroup, motion } from 'framer-motion';
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type TreeVariant = 'line' | 'pill';

export interface TreeItemData {
  id: string;
  label: string;
  icon?: LucideIcon | ComponentType<{ className?: string }>;
  badge?: string;
  disabled?: boolean;
}

interface TreeContextValue {
  selectedId: string | null;
  hoveredId: string | null;
  variant: TreeVariant;
  activeColor: string;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
}

const TreeContext = createContext<TreeContextValue | null>(null);

function useTreeContext() {
  const context = useContext(TreeContext);
  if (!context) {
    throw new Error('Tree components must be rendered within a TreeView.');
  }
  return context;
}

function isChildActive(child: ReactNode, activeId: string | null): boolean {
  if (!activeId || !isValidElement(child)) {
    return false;
  }

  const props = child.props as { id?: string; children?: ReactNode };

  if (props.id === activeId) {
    return true;
  }

  if (props.children) {
    return Children.toArray(props.children).some((nestedChild) =>
      isChildActive(nestedChild, activeId),
    );
  }

  return false;
}

interface TreeSvgLinesProps {
  offsets: number[];
  selectedOffset: number | null;
  variant: TreeVariant;
  activeColor: string;
  className?: string;
}

export function TreeSvgLines({
  offsets,
  selectedOffset,
  variant,
  activeColor,
  className,
}: TreeSvgLinesProps) {
  if (offsets.length === 0) {
    return null;
  }

  const lastOffset = offsets[offsets.length - 1];
  const totalHeight = lastOffset + 1;
  const lastV = lastOffset - 5;

  return (
    <svg
      aria-hidden="true"
      width="12"
      height={totalHeight}
      viewBox={`0 0 12 ${totalHeight}`}
      fill="none"
      className={cn(
        'preview-tree-lines pointer-events-none absolute top-0 z-0 select-none text-border',
        className,
      )}
    >
      <path d={`M0.5 0 V${lastV}`} stroke="currentColor" strokeWidth="1" />

      {offsets.map((y, index) => {
        const v = y - 5;
        return (
          <path
            key={index}
            d={`M0.5 ${v} Q0.5 ${y} 5.5 ${y} H11.5`}
            stroke="currentColor"
            strokeWidth="1"
          />
        );
      })}

      {variant === 'line' && selectedOffset !== null && (
        <motion.path
          d={`M0.5 0 V${selectedOffset - 5} Q0.5 ${selectedOffset} 5.5 ${selectedOffset} H11.5`}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          className={cn(activeColor)}
          initial={false}
          animate={{
            d: `M0.5 0 V${selectedOffset - 5} Q0.5 ${selectedOffset} 5.5 ${selectedOffset} H11.5`,
          }}
          transition={{
            type: 'spring',
            stiffness: 450,
            damping: 35,
          }}
        />
      )}
    </svg>
  );
}

export interface TreeListProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function TreeList({ children, className, ...props }: TreeListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [offsets, setOffsets] = useState<number[]>([]);
  const { selectedId, variant, activeColor } = useTreeContext();
  const childrenCount = Children.count(children);

  const activeIndex = useMemo(() => {
    if (!selectedId) {
      return -1;
    }
    const childArray = Children.toArray(children).filter(isValidElement);
    return childArray.findIndex((child) => isChildActive(child, selectedId));
  }, [children, selectedId]);

  const selectedOffset =
    activeIndex >= 0 && activeIndex < offsets.length ? offsets[activeIndex] : null;

  const updateOffsets = useCallback(() => {
    if (!containerRef.current) {
      return;
    }
    const directChildren = Array.from(containerRef.current.children).filter(
      (el) => el.tagName !== 'svg',
    ) as HTMLElement[];
    setOffsets(directChildren.map((child) => child.offsetTop + 16));
  }, []);

  useLayoutEffect(() => {
    updateOffsets();
    if (!containerRef.current) {
      return;
    }
    const resizeObserver = new ResizeObserver(() => {
      updateOffsets();
    });
    resizeObserver.observe(containerRef.current);
    return () => {
      resizeObserver.disconnect();
    };
  }, [childrenCount, updateOffsets]);

  return (
    <div
      ref={containerRef}
      role="group"
      className={cn('relative flex flex-col gap-0.5', className)}
      {...props}
    >
      <TreeSvgLines
        offsets={offsets}
        selectedOffset={selectedOffset}
        variant={variant}
        activeColor={activeColor}
      />
      {children}
    </div>
  );
}

export interface TreeItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  id: string;
  label: string;
  icon?: LucideIcon | ComponentType<{ className?: string }>;
  badge?: string;
  disabled?: boolean;
}

export const TreeItem = forwardRef<HTMLButtonElement, TreeItemProps>(
  (
    { id, label, icon: Icon = File, badge, disabled, className, onClick, ...props },
    ref,
  ) => {
    const { selectedId, hoveredId, variant, activeColor, onSelect, onHover } =
      useTreeContext();
    const isSelected = selectedId === id;
    const isHovered = hoveredId === id;

    const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
      if (disabled) {
        event.preventDefault();
        return;
      }
      onSelect(id);
      onClick?.(event);
    };

    const handleMouseEnter = () => {
      if (!disabled) {
        onHover(id);
      }
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (!disabled) {
          onSelect(id);
        }
      }
    };

    return (
      <button
        ref={ref}
        type="button"
        role="treeitem"
        aria-selected={isSelected}
        aria-disabled={disabled}
        disabled={disabled}
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onKeyDown={handleKeyDown}
        className={cn(
          'preview-tree-leaf group relative z-10 flex h-8 cursor-pointer items-center justify-between gap-2 rounded-md pr-2.5 text-left text-xs outline-none transition-colors select-none',
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
          isSelected
            ? variant === 'line'
              ? 'font-semibold text-foreground'
              : 'font-medium text-foreground'
            : 'font-normal text-muted-foreground',
          disabled && 'pointer-events-none cursor-not-allowed opacity-40',
          className,
        )}
        {...props}
      >
        {variant === 'pill' && isSelected && (
          <motion.div
            layoutId="tree-selected-pill"
            className="pointer-events-none absolute inset-0 z-0 rounded-md bg-secondary"
            transition={{
              type: 'spring',
              stiffness: 500,
              damping: 35,
            }}
          />
        )}

        {isHovered && (variant === 'line' || !isSelected) && (
          <motion.div
            layoutId="tree-hover-pill"
            className="pointer-events-none absolute inset-0 z-0 rounded-md bg-accent/60"
            transition={{
              type: 'spring',
              stiffness: 500,
              damping: 35,
            }}
          />
        )}

        <div className="relative z-10 flex min-w-0 items-center gap-2">
          {Icon && (
            <Icon
              className={cn(
                'size-4 shrink-0 transition-colors duration-150',
                isSelected
                  ? variant === 'line'
                    ? cn(activeColor)
                    : 'text-foreground'
                  : 'text-muted-foreground group-hover:text-foreground',
              )}
            />
          )}
          <span className="truncate leading-none transition-colors duration-150 group-hover:text-foreground">
            {label}
          </span>
        </div>

        {badge && (
          <span className="relative z-10 ml-auto shrink-0 rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-bold tracking-tight text-blue-600 uppercase dark:bg-blue-400/15 dark:text-blue-400">
            {badge}
          </span>
        )}
      </button>
    );
  },
);

TreeItem.displayName = 'TreeItem';

export interface TreeFolderProps extends HTMLAttributes<HTMLDivElement> {
  id: string;
  label: string;
  icon?: LucideIcon | ComponentType<{ className?: string }>;
  badge?: string;
  defaultExpanded?: boolean;
  children: ReactNode;
  disabled?: boolean;
}

export function TreeFolder({
  id,
  label,
  icon: CustomIcon,
  badge,
  defaultExpanded = false,
  children,
  disabled,
  className,
  ...props
}: TreeFolderProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const { hoveredId, onHover } = useTreeContext();
  const contentId = useId();
  const isHovered = hoveredId === id;
  const Icon = CustomIcon || (isExpanded ? FolderOpen : Folder);

  const handleToggle = () => {
    if (!disabled) {
      setIsExpanded((prev) => !prev);
    }
  };

  const handleMouseEnter = () => {
    if (!disabled) {
      onHover(id);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleToggle();
    } else if (event.key === 'ArrowRight' && !isExpanded) {
      event.preventDefault();
      setIsExpanded(true);
    } else if (event.key === 'ArrowLeft' && isExpanded) {
      event.preventDefault();
      setIsExpanded(false);
    }
  };

  return (
    <div className={cn('flex flex-col gap-0.5', className)} {...props}>
      <button
        type="button"
        role="treeitem"
        aria-expanded={isExpanded}
        aria-controls={contentId}
        disabled={disabled}
        onClick={handleToggle}
        onMouseEnter={handleMouseEnter}
        onKeyDown={handleKeyDown}
        className={cn(
          'group relative flex h-8 cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 pl-8 text-left text-sm font-normal text-muted-foreground outline-none select-none',
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
          disabled && 'pointer-events-none cursor-not-allowed opacity-40',
        )}
      >
        {isHovered && (
          <motion.div
            layoutId="tree-hover-pill"
            className="pointer-events-none absolute inset-0 z-0 rounded-md bg-accent/60"
            transition={{
              type: 'spring',
              stiffness: 500,
              damping: 35,
            }}
          />
        )}

        <div className="relative z-10 flex min-w-0 items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground transition-colors duration-150 group-hover:text-foreground" />
          <span className="truncate leading-none transition-colors duration-150 group-hover:text-foreground">
            {label}
          </span>
        </div>

        <div className="relative z-10 flex items-center gap-1">
          {badge && (
            <span className="shrink-0 rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-bold tracking-tight text-blue-600 uppercase dark:bg-blue-400/15 dark:text-blue-400">
              {badge}
            </span>
          )}
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:text-foreground',
              isExpanded && 'rotate-90',
            )}
          />
        </div>
      </button>

      <div
        id={contentId}
        aria-hidden={!isExpanded}
        className={cn(
          'grid pl-4 transition-[grid-template-rows,opacity] duration-300 ease-in-out',
          isExpanded
            ? 'grid-rows-[1fr] opacity-100'
            : 'pointer-events-none grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="overflow-hidden">
          <TreeList>{children}</TreeList>
        </div>
      </div>
    </div>
  );
}

export interface TreeSectionProps {
  title: string;
  count?: number;
  tone?: 'group' | 'section';
  lined?: boolean;
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  children: ReactNode;
  className?: string;
}

export function TreeSection({
  title,
  count,
  tone = 'section',
  lined = true,
  defaultExpanded = false,
  expanded: expandedProp,
  onExpandedChange,
  children,
  className,
}: TreeSectionProps) {
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(defaultExpanded);
  const isControlled = expandedProp !== undefined;
  const isExpanded = isControlled ? expandedProp : uncontrolledExpanded;
  const contentId = useId();
  const isGroup = tone === 'group';

  const handleToggle = () => {
    const next = !isExpanded;
    if (!isControlled) {
      setUncontrolledExpanded(next);
    }
    onExpandedChange?.(next);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleToggle();
    } else if (event.key === 'ArrowRight' && !isExpanded) {
      event.preventDefault();
      onExpandedChange?.(true);
      if (!isControlled) setUncontrolledExpanded(true);
    } else if (event.key === 'ArrowLeft' && isExpanded) {
      event.preventDefault();
      onExpandedChange?.(false);
      if (!isControlled) setUncontrolledExpanded(false);
    }
  };

  return (
    <div
      className={cn(
        'flex flex-col gap-0.5',
        isGroup && 'border-border/80 border-t pt-1 first:border-t-0 first:pt-0',
        className,
      )}
    >
      <button
        type="button"
        aria-expanded={isExpanded}
        aria-controls={contentId}
        aria-label={
          typeof count === 'number' ? `${title}, ${count} blocks` : title
        }
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
        className={cn(
          'group flex w-full cursor-pointer items-center justify-between rounded-md text-left outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
          isGroup ? 'px-2 py-2' : 'px-2 py-1.5',
        )}
      >
        <span
          className={cn(
            'font-semibold text-muted-foreground uppercase transition-colors duration-150 group-hover:text-foreground',
            isGroup
              ? 'text-[0.6875rem] tracking-[0.18em]'
              : 'text-[11px] tracking-wider',
          )}
        >
          {title}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {typeof count === 'number' ? (
            <span className="tabular-nums text-[0.6875rem] font-medium text-muted-foreground group-hover:text-foreground">
              {count}
            </span>
          ) : null}
          <ChevronDown
            className={cn(
              'size-3.5 text-muted-foreground transition-transform duration-200 group-hover:text-foreground',
              !isExpanded && '-rotate-90',
            )}
          />
        </span>
      </button>

      <div
        id={contentId}
        aria-hidden={!isExpanded}
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-300 ease-in-out',
          isExpanded
            ? 'grid-rows-[1fr] opacity-100'
            : 'pointer-events-none grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          {lined ? <TreeList>{children}</TreeList> : children}
        </div>
      </div>
    </div>
  );
}

export interface TreeViewProps extends Omit<HTMLAttributes<HTMLElement>, 'onSelect'> {
  selectedId?: string;
  defaultSelectedId?: string;
  variant?: TreeVariant;
  activeColor?: string;
  onSelect?: (id: string) => void;
  children: ReactNode;
}

export function TreeView({
  selectedId: controlledSelectedId,
  defaultSelectedId,
  variant = 'line',
  activeColor = 'text-blue-600 dark:text-blue-500',
  onSelect: controlledOnSelect,
  children,
  className,
  ...props
}: TreeViewProps) {
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(
    defaultSelectedId || null,
  );
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const selectedId =
    controlledSelectedId !== undefined ? controlledSelectedId : internalSelectedId;

  const handleSelect = useCallback(
    (id: string) => {
      if (controlledSelectedId === undefined) {
        setInternalSelectedId(id);
      }
      controlledOnSelect?.(id);
    },
    [controlledSelectedId, controlledOnSelect],
  );

  const handleMouseLeave = useCallback(() => {
    setHoveredId(null);
  }, []);

  const contextValue = useMemo(
    () => ({
      selectedId,
      hoveredId,
      variant,
      activeColor,
      onSelect: handleSelect,
      onHover: setHoveredId,
    }),
    [selectedId, hoveredId, variant, activeColor, handleSelect],
  );

  return (
    <TreeContext.Provider value={contextValue}>
      <LayoutGroup id="branching-tree-nav">
        <nav
          role="tree"
          aria-orientation="vertical"
          onMouseLeave={handleMouseLeave}
          className={cn('flex w-full flex-col gap-0.5 px-1 select-none', className)}
          {...props}
        >
          {children}
        </nav>
      </LayoutGroup>
    </TreeContext.Provider>
  );
}
