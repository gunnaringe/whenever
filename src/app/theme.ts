// The colour theme. The choice (auto, light, dark or hacker) is stored with
// the rest of this device's memory (localStorage, STORE_KEY); the theme in
// use goes on <html data-theme> as light, dark or hacker, and the CSS reads
// only that. theme-head.ts applies it from <head>, before the page paints;
// the app calls applyTheme again when the choice changes. No other imports:
// this is bundled into that small head script too.

export type ThemeChoice = 'auto' | 'light' | 'dark' | 'hacker';
export const THEMES: readonly ThemeChoice[] = ['auto', 'light', 'dark', 'hacker'];
export const STORE_KEY = 'whenever-v1';

// The browser's address bar on phones.
const BAR = { light: '#0f766e', dark: '#11181c', hacker: '#000000' };
const darkOs = matchMedia('(prefers-color-scheme: dark)');

export const isTheme = (x: unknown): x is ThemeChoice => THEMES.includes(x as ThemeChoice);

export function storedTheme(): ThemeChoice {
  try {
    const s: unknown = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
    const theme = s && typeof s === 'object' ? (s as { theme?: unknown }).theme : undefined;
    return isTheme(theme) ? theme : 'auto';
  } catch {
    return 'auto';
  }
}

export function applyTheme(choice: ThemeChoice = storedTheme()): void {
  const theme = choice === 'auto' ? (darkOs.matches ? 'dark' : 'light') : choice;
  document.documentElement.dataset.theme = theme;
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) m.content = BAR[theme];
  const scheme = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (scheme) scheme.content = theme === 'light' ? 'light' : 'dark';
}

// Auto follows the device switching between light and dark, and a choice
// made in another tab applies here too.
export function watchTheme(): void {
  darkOs.addEventListener('change', () => applyTheme());
  window.addEventListener('storage', (e) => e.key === STORE_KEY && applyTheme());
}
