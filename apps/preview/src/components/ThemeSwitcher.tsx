import { useEffect, useId, useRef, useState } from 'react';
import { Check, Palette } from 'lucide-react';
import { useTheme } from '@/components/theme-provider';
import { themes } from '@/lib/themes-config';

export function ThemeSwitcher() {
  const { colorTheme, mode, setColorTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = themes.find((theme) => theme.name === colorTheme) ?? themes[0];
  const swatch = mode === 'dark' ? current.primaryDark : current.primaryLight;

  if (!mounted) {
    return (
      <span
        className="inline-flex h-8 min-w-8 items-center gap-1.5 rounded-md border px-2 text-muted-foreground"
        aria-hidden
      >
        <Palette className="size-3.5" />
      </span>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Theme: ${current.title}. Change color theme`}
        title={current.title}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-8 max-w-[9.5rem] items-center gap-1.5 rounded-md border px-2 text-[0.6875rem] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <span
          className="size-2.5 shrink-0 rounded-full border border-border"
          style={{ backgroundColor: swatch }}
        />
        <span className="truncate">{current.title}</span>
      </button>
      {open ? (
        <ul
          id={menuId}
          role="listbox"
          aria-label="Color themes"
          className="absolute top-full right-0 z-50 mt-1.5 w-48 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {themes.map((theme) => {
            const selected = theme.name === colorTheme;
            return (
              <li key={theme.name} role="none">
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[0.8125rem] transition-colors hover:bg-accent hover:text-accent-foreground"
                  onClick={() => {
                    setColorTheme(theme.name);
                    setOpen(false);
                  }}
                >
                  <span
                    className="size-3.5 shrink-0 rounded-full border border-border"
                    style={{
                      backgroundColor:
                        mode === 'dark' ? theme.primaryDark : theme.primaryLight,
                    }}
                  />
                  <span className="flex-1">{theme.title}</span>
                  {selected ? <Check className="size-3.5 text-brand" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
