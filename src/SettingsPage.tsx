import { createEffect, createMemo, For, Show } from 'solid-js';
import { IndexingSettings } from './IndexingSettings';
import { settingsRoute, type Route } from './navigation';
import type { ThemePreferences } from './theme';
import type { Snapshot } from './types';
import type { useInspectorTheme } from './useTheme';
import { WorkspaceLinks } from './WorkspaceLinks';

const settingsLinks = [
  { label: 'General', route: settingsRoute },
  { label: 'Theme', route: { ...settingsRoute, subpage: 'theme' } },
  { label: 'Indexing', route: { ...settingsRoute, subpage: 'indexing' } },
] satisfies { label: string; route: Route }[];
const defaultThemeOptions = [
  { id: 'follow', label: 'Follow OpenCode CLI' },
  { id: 'inspector:default', label: 'Inspector default' },
  { id: 'builtin:system', label: 'System (browser approximation)' },
];

type ThemeState = ReturnType<typeof useInspectorTheme>;

export function SettingsPage(props: {
  subpage?: Route['subpage']; themeState: ThemeState; snapshot?: Snapshot; loading: boolean; error: string; retry: () => void; go: (route: Route) => void;
}) {
  const showTheme = () => props.subpage === 'theme';
  const current = () => settingsLinks.find(link => link.route.subpage === props.subpage) ?? settingsLinks[0];
  return <div class="settings-page">
    <WorkspaceLinks label="Settings pages" links={settingsLinks} route={current().route} go={props.go}/>
    <h1 tabIndex={-1} data-route-heading>Settings · {current().label}</h1>
    <Show when={props.subpage !== 'indexing'} fallback={<IndexingSettings/>}>
      <p class="secondary">{showTheme() ? 'Preferences for this browser. Your OpenCode configuration is unchanged.' : 'Read-only information about your local OpenCode configuration.'}</p>
      <Show when={props.loading}><p class="secondary" role="status">{showTheme() ? 'Reading configured theme and available palettes…' : 'Reading configuration…'}</p></Show>
      <Show when={props.error}><div class="settings-error surface-card" role="alert"><p>{props.error} Configured theme information may be unavailable or out of date.</p><button class="plain-button" onClick={() => props.retry()}>Try again</button></div></Show>
      <Show when={showTheme()} fallback={<ConfigurationInformation snapshot={props.snapshot}/>}>
        <ThemeSettings themeState={props.themeState} theme={props.snapshot?.theme}/>
      </Show>
    </Show>
  </div>;
}

function ConfigurationInformation(props: { snapshot?: Snapshot }) {
  const noticeCount = () => props.snapshot?.warnings.length;
  return <section class="settings-information surface-card">
    <h2>Configuration information{noticeCount() ? ` · ${noticeCount()} notices` : ''}</h2>
    <dl class="source-paths"><dt>Config root</dt><dd><code>{props.snapshot?.root || 'Connecting…'}</code></dd><dt>Real path</dt><dd><code>{props.snapshot?.realpath || 'Unknown'}</code></dd></dl>
    <p class="secondary">Read-only, static inspection of local configuration. Runtime defaults and availability are not verified. Secrets are masked with best-effort redaction; paths remain visible. Inspect before sharing. No telemetry.</p>
    <Warnings warnings={props.snapshot?.warnings}/>
  </section>;
}

function ThemeSettings(props: { themeState: ThemeState; theme?: Snapshot['theme'] }) {
  const preferences = () => props.themeState.preferences;
  const applied = () => props.themeState.applied;
  const options = createMemo(() => [...defaultThemeOptions, ...(props.theme?.palettes || [])]);
  const unknownOverride = () => !options().some(option => option.id === preferences().theme);
  let themeSelect!: HTMLSelectElement;
  createEffect(() => {
    // Loading palettes can replace the selected fallback option with a new node.
    options();
    themeSelect.value = preferences().theme;
  });
  return <>
    <fieldset class="appearance-controls surface-card">
      <legend>Appearance</legend>
      <label>Theme<select name="inspector-theme" ref={themeSelect} onChange={event => props.themeState.updatePreferences({ ...preferences(), theme: event.currentTarget.value })}>
        <For each={options()}>{option => <option value={option.id} selected={preferences().theme === option.id}>{option.label}</option>}</For>
        <Show when={unknownOverride()}><option value={preferences().theme} selected>Unavailable override</option></Show>
      </select></label>
      <label>Color mode<select name="inspector-color-mode" onChange={event => props.themeState.updatePreferences({ ...preferences(), mode: event.currentTarget.value as ThemePreferences['mode'] })}>
        <option value="auto" selected={preferences().mode === 'auto'}>{preferences().theme === 'follow' ? 'Auto (follow or browser)' : 'Auto (browser)'}</option><option value="light" selected={preferences().mode === 'light'}>Light</option><option value="dark" selected={preferences().mode === 'dark'}>Dark</option>
      </select></label>
      <p class="appearance-status">{applied().label} · {applied().mode}<br/><span class="secondary">{applied().source}</span></p>
      <Show when={applied().palette}>{palette => <p class="secondary">Palette: {palette().source}</p>}</Show>
      <Show when={applied().note}><p class="secondary">{applied().note}</p></Show>
      <Show when={props.themeState.storageFailed}><p class="secondary">Browser storage is unavailable. This override lasts for the current page only.</p></Show>
    </fieldset>
    <p class="secondary">Theme overrides affect only this Inspector browser. Follow reads configured CLI settings first for the global root and falls back to legacy TUI preferences only when CLI settings are absent. Auto honors an explicit CLI light or dark mode when following; otherwise it uses your browser’s color scheme. Desktop has separate browser storage and its preferences are not inspected.</p>
    <p class="secondary">System is a browser approximation using Inspector colors and browser color-mode detection. It cannot reproduce the terminal palette or terminal transparency.</p>
    <Warnings warnings={props.theme?.warnings}/>
  </>;
}

function Warnings(props: { warnings?: string[] }) {
  return <For each={props.warnings}>{warning => <p class="secondary">{warning}</p>}</For>;
}
