import type { Entry } from './types';
import { configText } from './display';

export function resolveAgentSettings(entry: Entry, models: Entry[]) {
  const model = models.find(candidate => candidate.category === 'Models' && candidate.id === entry.data.model);
  const variant = typeof entry.data.variant === 'string' && entry.data.variant ? entry.data.variant : undefined;
  const variantReasoning = variant ? model?.data.variants?.[variant]?.reasoningEffort : undefined;
  const reasoning = entry.data.reasoningEffort ?? entry.data.options?.reasoningEffort ?? variantReasoning ?? model?.data.options?.reasoningEffort ?? model?.data.providerOptions?.reasoningEffort;
  const reasoningSource = entry.data.reasoningEffort !== undefined || entry.data.options?.reasoningEffort !== undefined
    ? 'Configured · agent' : variantReasoning !== undefined ? `Inherited · variant ${variant}`
      : reasoning !== undefined ? 'Inherited · model/provider options' : 'Unknown · not configured';
  const reasoningLabel = variant
    ? reasoning == null || reasoning === variant ? variant : `${variant} · ${configText(reasoning)} effort`
    : configText(reasoning);
  return { model, variant, reasoning, reasoningSource, reasoningLabel };
}
