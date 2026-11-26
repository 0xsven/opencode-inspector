import { createEffect, createMemo, createSignal, on, onCleanup, onMount, type Accessor } from 'solid-js';
import { appearance, appliedTheme, defaultPreferences, readPreferences, savePreferences } from './theme';
import type { ThemeInfo, ThemePreferences } from './theme';

export function useInspectorTheme(info: Accessor<ThemeInfo | undefined>) {
  const readStoredPreferences = () => {
    try { return readPreferences(window.localStorage); } catch { return { ...defaultPreferences }; }
  };
  const media = typeof window === 'undefined' ? undefined : window.matchMedia?.('(prefers-color-scheme: dark)');
  const [preferences, setPreferences] = createSignal(readStoredPreferences());
  const [prefersDark, setPrefersDark] = createSignal(media?.matches ?? true);
  const [storageFailed, setStorageFailed] = createSignal(false);
  onMount(() => {
    if (!media) return;
    const update = () => setPrefersDark(media.matches);
    media.addEventListener('change', update);
    update();
    onCleanup(() => media.removeEventListener('change', update));
  });
  const applied = createMemo(() => appliedTheme(info(), preferences(), prefersDark()));
  const palette = createMemo(() => applied().palette);
  const mode = createMemo(() => applied().mode);
  const label = createMemo(() => applied().label);
  createEffect(on([palette, mode, label], ([palette, mode, label]) => {
    const root = document.documentElement;
    const colors = appearance(palette, mode);
    for (const [key, value] of Object.entries(colors)) root.style.setProperty(`--${key}`, value);
    root.style.colorScheme = mode;
    root.dataset.theme = palette?.id || (label.startsWith('System') ? 'builtin:system' : 'inspector:default');
    root.dataset.colorMode = mode;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colors.background);
  }));

  function updatePreferences(next: ThemePreferences) {
    setPreferences(next);
    try { setStorageFailed(!savePreferences(window.localStorage, next)); } catch { setStorageFailed(true); }
  }
  return {
    get preferences() { return preferences(); },
    updatePreferences,
    get applied() { return applied(); },
    get storageFailed() { return storageFailed(); },
  };
}
