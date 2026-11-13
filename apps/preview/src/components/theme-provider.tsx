import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  applyThemeToDocument,
  DEFAULT_THEME,
  parseTheme,
  THEME_STORAGE_KEY,
  type ThemeMode,
} from '@/lib/themes-config';

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: string;
};

type ThemeProviderState = {
  theme: string;
  setTheme: (theme: string) => void;
  setColorTheme: (name: string) => void;
  setMode: (mode: ThemeMode) => void;
  colorTheme: string;
  mode: ThemeMode;
};

const ThemeProviderContext = createContext<ThemeProviderState | null>(null);

export function ThemeProvider({
  children,
  defaultTheme = DEFAULT_THEME,
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState(() => {
    if (typeof window === 'undefined') return defaultTheme;
    return window.localStorage.getItem(THEME_STORAGE_KEY) || defaultTheme;
  });

  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  const setTheme = useCallback((next: string) => {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    setThemeState(next);
  }, []);

  const { colorTheme, mode } = parseTheme(theme);

  const setColorTheme = useCallback(
    (name: string) => {
      setTheme(`${name}-${mode}`);
    },
    [mode, setTheme],
  );

  const setMode = useCallback(
    (next: ThemeMode) => {
      setTheme(`${colorTheme}-${next}`);
    },
    [colorTheme, setTheme],
  );

  const value = useMemo(
    () => ({ theme, setTheme, setColorTheme, setMode, colorTheme, mode }),
    [theme, setTheme, setColorTheme, setMode, colorTheme, mode],
  );

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeProviderContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
