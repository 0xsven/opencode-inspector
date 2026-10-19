// Configuration stays intact in the raw view; display fields only accept strings.
export function configText(value: unknown, fallback = 'Unknown'): string {
  return typeof value === 'string' ? value || fallback : value === undefined ? fallback : 'Unsupported value';
}

export function shortModel(value: unknown): string {
  return typeof value === 'string' && value ? value.split('/').at(-1) || 'Model unknown' : configText(value, 'Model unknown');
}
