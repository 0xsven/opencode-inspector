import { createSignal } from 'solid-js';

export type ClockFormat = 'automatic' | 'h12' | 'h23';
const storageKey = 'opencode-inspector-clock-format';

function readClockFormat(): ClockFormat {
  try {
    const value = window.localStorage.getItem(storageKey);
    return value === 'h12' || value === 'h23' ? value : 'automatic';
  } catch { return 'automatic'; }
}

export function useClockFormat() {
  const [format, setFormat] = createSignal(readClockFormat());
  const [storageFailed, setStorageFailed] = createSignal(false);
  function updateFormat(next: ClockFormat) {
    setFormat(next);
    try { window.localStorage.setItem(storageKey, next); setStorageFailed(false); }
    catch { setStorageFailed(true); }
  }
  return {
    get format() { return format(); },
    updateFormat,
    get storageFailed() { return storageFailed(); },
  };
}
