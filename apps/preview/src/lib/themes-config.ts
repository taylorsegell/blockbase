export type ThemeMode = 'light' | 'dark';

export interface ThemeConfig {
  name: string;
  title: string;
  primaryLight: string;
  primaryDark: string;
}

export const themes: ThemeConfig[] = [
  {
    name: 'blocks',
    title: 'Blocks',
    primaryLight: '#ea580c',
    primaryDark: '#f97316',
  },
  {
    name: 'modern-minimal',
    title: 'Modern Minimal',
    primaryLight: 'oklch(0.62 0.19 259.81)',
    primaryDark: 'oklch(0.62 0.19 259.81)',
  },
  {
    name: 'catppuccin',
    title: 'Catppuccin',
    primaryLight: 'oklch(0.55 0.25 297.02)',
    primaryDark: 'oklch(0.79 0.12 304.77)',
  },
  {
    name: 'vercel',
    title: 'Vercel',
    primaryLight: 'oklch(0 0 0)',
    primaryDark: 'oklch(1 0 0)',
  },
  {
    name: 'github',
    title: 'GitHub',
    primaryLight: 'oklch(0.52 0.16 145)',
    primaryDark: 'oklch(0.62 0.16 145)',
  },
  {
    name: 'neo-brutalism',
    title: 'Neo Brutalism',
    primaryLight: 'oklch(0.65 0.24 26.97)',
    primaryDark: 'oklch(0.70 0.19 23.19)',
  },
  {
    name: 'cyberpunk',
    title: 'Cyberpunk',
    primaryLight: 'oklch(0.67 0.29 341.41)',
    primaryDark: 'oklch(0.67 0.29 341.41)',
  },
  {
    name: 'arkitect',
    title: 'Arkitect',
    primaryLight: 'oklch(0.60 0.19 42)',
    primaryDark: 'oklch(0.70 0.20 45)',
  },
];

export const DEFAULT_THEME = 'blocks-dark';
export const THEME_STORAGE_KEY = 'blocks-preview-theme';

export function parseTheme(theme: string | undefined): {
  colorTheme: string;
  mode: ThemeMode;
} {
  if (!theme) return { colorTheme: 'blocks', mode: 'dark' };
  if (theme.endsWith('-dark')) {
    return { colorTheme: theme.slice(0, -5), mode: 'dark' };
  }
  if (theme.endsWith('-light')) {
    return { colorTheme: theme.slice(0, -6), mode: 'light' };
  }
  return { colorTheme: 'blocks', mode: 'dark' };
}

export function applyThemeToDocument(theme: string) {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.classList.toggle('dark', theme.endsWith('-dark'));
}
