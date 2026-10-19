import { Tiktoken } from 'js-tiktoken/lite';
import o200k from 'js-tiktoken/ranks/o200k_base';
import type { PromptSize } from '../src/types.js';

let encoder: Tiktoken | undefined;

// Server-only: count the selected local body, never assembled runtime context.
export function estimatePromptSize(prompt: unknown): PromptSize | undefined {
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt, 'utf8') > 2_000_000) return undefined;
  try {
    encoder ??= new Tiktoken(o200k);
    let count = 0;
    // Bound BPE work for pathological long runs; chunk boundaries can slightly
    // change the estimate. Keep UTF-16 surrogate pairs together.
    for (let start = 0; start < prompt.length;) {
      let end = Math.min(start + 8192, prompt.length);
      if (end < prompt.length && /[\uD800-\uDBFF]/.test(prompt[end - 1])) end--;
      count += encoder.encode(prompt.slice(start, end), [], []).length;
      start = end;
    }
    return { count, approximate: true, encoding: 'o200k_base' };
  } catch { return undefined; }
}
