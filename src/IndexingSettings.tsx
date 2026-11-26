import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import type { UsageIndexState } from './usage-types';

export function IndexingSettings() {
  const [index, setIndex] = createSignal<UsageIndexState>();
  const [checking, setChecking] = createSignal(true);
  const [starting, setStarting] = createSignal(false);
  const [unsupported, setUnsupported] = createSignal(false);
  const [requestError, setRequestError] = createSignal('');
  const building = () => index()?.state === 'indexing' || index()?.state === 'refreshing';
  const disabled = () => checking() || starting() || building() || unsupported();
  let observation: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const stopObserving = () => {
    clearTimeout(timer);
    observation?.abort();
    observation = undefined;
  };

  async function update(mode: 'observe' | 'rebuild') {
    if (disposed || document.hidden) return;
    if (mode === 'rebuild') {
      if (disabled()) return;
      setStarting(true);
      stopObserving();
      setRequestError('');
    } else {
      if (starting() || observation) return;
      observation = new AbortController();
    }
    // Only status reads are canceled: navigation should not cancel a submitted rebuild.
    const signal = mode === 'observe' ? observation?.signal : undefined;
    const canceled = () => disposed || signal?.aborted;
    try {
      const response = await fetch(`/api/usage/index?mode=${mode}`, { signal, cache: 'no-store' });
      if (canceled()) return;
      if (response.status === 404) {
        setUnsupported(true);
        return;
      }
      if (!response.ok) throw new Error();
      const status: UsageIndexState = await response.json();
      if (canceled()) return;
      setIndex(status);
      setRequestError('');
      setUnsupported(false);
    } catch {
      if (!canceled()) setRequestError(mode === 'rebuild'
        ? 'Couldn’t confirm the rebuild request. Check that Inspector is running and try again.'
        : 'Couldn’t check index status. Check that Inspector is running.');
    } finally {
      if (!canceled()) {
        if (mode === 'rebuild') setStarting(false);
        else {
          observation = undefined;
          setChecking(false);
        }
        if (!document.hidden && !unsupported() && building()) {
          timer = setTimeout(() => void update('observe'), requestError() ? 3_000 : 1_000);
        }
      }
    }
  }

  onMount(() => {
    const sync = () => {
      if (document.hidden) stopObserving();
      else if (!starting()) {
        setChecking(true);
        void update('observe');
      }
    };
    document.addEventListener('visibilitychange', sync);
    onCleanup(() => {
      disposed = true;
      stopObserving();
      document.removeEventListener('visibilitychange', sync);
    });
    sync();
  });

  const statusText = () => {
    if (checking()) return 'Checking index status…';
    if (starting()) return 'Starting rebuild…';
    if (unsupported()) return '';
    if (building()) return index()?.state === 'refreshing' ? 'Rebuilding the usage index…' : 'Building the usage index…';
    if (requestError() || index()?.state === 'failed') return '';
    if (index()?.indexedAt && index()?.sourceChanged) return 'New history is available to index.';
    return index()?.indexedAt ? 'The usage index is ready.' : 'The usage index has not been built yet.';
  };
  const errorText = () => {
    if (checking() || starting()) return '';
    if (unsupported()) return 'This Inspector server does not support manual rebuilding. Restart Inspector to use this control.';
    if (requestError()) return requestError();
    if (index()?.state !== 'failed') return '';
    return index()?.sourceChanged === null
      ? 'Inspector couldn’t read OpenCode’s history. Check that it’s available, then try again.'
      : 'The rebuild failed. Choose Rebuild index to try again.';
  };

  return <section class="settings-indexing surface-card">
    <h2>Usage index</h2>
    <p class="secondary">Inspector builds its own index from your local OpenCode session history. Rebuilding reads that history from scratch without changing it. Usage keeps showing the previous index if one is available, and you can leave this page while the rebuild runs.</p>
    <div class="settings-indexing-status">
      <p role="status">{statusText()}</p>
      <Show when={errorText()}>{error => <p role="alert">{error()}</p>}</Show>
      <Show when={index()?.indexedAt}>{at => <p class="secondary">Last indexed: <time dateTime={at()}>{new Date(at()).toLocaleString()}</time></p>}</Show>
    </div>
    <button type="button" class="plain-button" disabled={disabled()} onClick={() => void update('rebuild')}>Rebuild index</button>
  </section>;
}
