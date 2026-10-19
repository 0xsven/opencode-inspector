import type { ModelCapacity, Value } from '../src/types.js';

// Allowlisted projection of https://models.dev/api.json; no runtime fetch.
// Full response SHA-256 pins this extraction (see THIRD_PARTY_NOTICES.md).
const source = {
  url: 'https://models.dev/api.json',
  checked: '2026-10-15',
  sha256: 'd89d121bb5511e41bd5e9ddf00873aab132849fd96df549f0d39f6e80d64a4d3',
};
const contexts: Readonly<Record<string, number>> = Object.freeze({
  'openai/gpt-5.6': 1050000,
  'openai/gpt-5.6-sol': 1050000,
  'openai/gpt-5.6-luna': 1050000,
  'openai/gpt-5.6-terra': 1050000,
  'openai/gpt-6-astra': 1050000,
  'openai/gpt-6-sol': 1050000,
  'openai/gpt-6.1-sol': 1050000,
  'openai/gpt-6-luna': 1050000,
  'openai/gpt-5.5': 1050000,
  'openai/gpt-5.2': 400000,
  'openai/gpt-5.1': 400000,
});

export function lookupModelCapacity(provider: string, key: string, model: Value, providerConfig: Value): ModelCapacity | undefined {
  // A custom endpoint/SDK is not a verified mapping to this catalogue provider.
  if (provider !== 'openai' || providerConfig.options?.baseURL !== undefined
    || (providerConfig.npm !== undefined && providerConfig.npm !== '@ai-sdk/openai')) return;
  const id = model.id === undefined ? key : model.id;
  if (typeof id !== 'string' || !id) return;
  const match = `${provider}/${id}`;
  if (!Object.hasOwn(contexts, match)) return;
  return { provider, model: id, context: contexts[match], source: { ...source } };
}
