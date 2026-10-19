const sensitive = /api[-_]?key|password|passwd|token|secret|authorization|cookie|credential|private[-_]?key/i;
export function redactText(text: string): string {
  return text
    .replace(/-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z ]*PRIVATE KEY)-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{8,}|gh[pousr]_[a-zA-Z0-9_]{8,})\b/g, '[REDACTED]')
    .replace(/(--(?:api[-_]?key|password|token|secret|authorization)\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(\bBearer\s+)[\w.\-+/=]+/gi, '$1[REDACTED]')
    .replace(/((?:api[-_]?key|password|passwd|[\w-]*token|[\w-]*secret|authorization|cookie)\s*["']?\s*[:=]\s*)[^\n,;}]+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s<>"')]+/gi, raw => {
      try { const u = new URL(raw); if (u.username || u.password) { u.username = 'REDACTED'; u.password = ''; }
        for (const k of u.searchParams.keys()) if (sensitive.test(k)) u.searchParams.set(k, 'REDACTED'); return u.toString();
      } catch { return '[INVALID URL]'; }
    });
}
export function redact(value: any, key = ''): any {
  if (sensitive.test(key)) return '[REDACTED]';
  if (/^(env|environment)$/i.test(key)) return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).map(k => [k, '[REDACTED]'])) : '[REDACTED]';
  if (Array.isArray(value)) return value.map((v, i) => typeof v === 'string' && typeof value[i - 1] === 'string' && /^--(?:api[-_]?key|password|token|secret|authorization)$/i.test(value[i - 1]) ? '[REDACTED]' : redact(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  return typeof value === 'string' ? redactText(value) : value;
}
