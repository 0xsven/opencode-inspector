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
const openAIPackages = new Set([
  'aisdk:@ai-sdk/openai', '@opencode/ai/providers/openai', '@opencode/ai/providers/openai/chat', '@opencode/ai/providers/openai/responses',
]);

export function lookupModelCapacity(provider: string, key: string, model: Value, providerConfig: Value): ModelCapacity | undefined {
  // A custom endpoint/SDK is not a verified mapping to this catalogue provider.
  const customRoute = (data: Value) => data.api !== undefined || data.options?.baseURL !== undefined || data.settings?.baseURL !== undefined
    || (data.npm !== undefined && data.npm !== '@ai-sdk/openai')
    || (data.package !== undefined && !openAIPackages.has(data.package));
  if (provider !== 'openai' || customRoute(providerConfig) || customRoute(model)
    || (providerConfig.canonical !== undefined && providerConfig.canonical !== 'openai')
    || (Array.isArray(model.variants) && model.variants.some(variant => variant && customRoute(variant)))) return;
  const id = model.modelID !== undefined ? model.modelID : model.id !== undefined ? model.id : key;
  if (typeof id !== 'string' || !id) return;
  const match = `${provider}/${id}`;
  if (!Object.hasOwn(contexts, match)) return;
  return { provider, model: id, context: contexts[match], source: { ...source } };
}
