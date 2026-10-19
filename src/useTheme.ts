import { useEffect, useState } from 'react';
import { appearance, appliedTheme, defaultPreferences, readPreferences, savePreferences } from './theme';
import type { ThemeInfo, ThemePreferences } from './theme';

export function useInspectorTheme(info: ThemeInfo | undefined) {
  const [preferences, setPreferences] = useState<ThemePreferences>(() => {
    try { return readPreferences(window.localStorage); } catch { return { ...defaultPreferences }; }
  });
  const [prefersDark, setPrefersDark] = useState(() => typeof window === 'undefined' || !window.matchMedia ? true : window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [storageFailed, setStorageFailed] = useState(false);
  useEffect(() => {
    if (!window.matchMedia) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setPrefersDark(media.matches);
    media.addEventListener('change', update);
    update();
    return () => media.removeEventListener('change', update);
  }, []);
  const applied = appliedTheme(info, preferences, prefersDark);
  useEffect(() => {
    const root = document.documentElement;
    const colors = appearance(applied.palette, applied.mode);
    for (const [key, value] of Object.entries(colors)) root.style.setProperty(`--${key}`, value);
    root.style.colorScheme = applied.mode;
    root.dataset.theme = applied.palette?.id || (applied.label.startsWith('System') ? 'builtin:system' : 'inspector:default');
    root.dataset.colorMode = applied.mode;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colors.background);
  }, [applied.palette, applied.mode, applied.label]);

  function updatePreferences(next: ThemePreferences) {
    setPreferences(next);
    try { setStorageFailed(!savePreferences(window.localStorage, next)); } catch { setStorageFailed(true); }
  }
  return { preferences, updatePreferences, applied, storageFailed };
}
