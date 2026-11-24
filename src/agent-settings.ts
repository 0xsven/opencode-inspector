import type { Entry } from './types';
import { configText } from './display';

function modelSelection(value: unknown) {
  if (typeof value === 'string') {
    const index = value.indexOf('#');
    return index < 0 ? { id: value } : { id: value.slice(0, index), variant: value.slice(index + 1) || undefined };
  }
  if (value && typeof value === 'object' && 'providerID' in value && 'model' in value
    && typeof value.providerID === 'string' && value.providerID && !/[\/#]/.test(value.providerID)
    && typeof value.model === 'string' && value.model && !value.model.includes('#')) {
    return { id: `${value.providerID}/${value.model}`, variant: 'variant' in value && typeof value.variant === 'string' ? value.variant || undefined : undefined };
  }
  return {};
}

export function resolveAgentSettings(entry: Entry, models: Entry[]) {
  const selection = modelSelection(entry.data.model);
  const model = models.find(candidate => candidate.category === 'Models' && candidate.id === selection.id);
  const inherited = entry.provenance.model === 'Inherited · global model';
  const variant = (!inherited ? selection.variant : undefined) || (typeof entry.data.variant === 'string' ? entry.data.variant || undefined : undefined);
  const variants = model?.data.variants;
  const variantReasoning = !variant ? undefined : Array.isArray(variants)
    ? variants.slice().reverse().find(option => option?.id === variant)?.settings?.reasoningEffort
    : variants && Object.hasOwn(variants, variant) ? variants[variant]?.reasoningEffort : undefined;
  const agentReasoning = entry.data.reasoningEffort ?? entry.data.options?.reasoningEffort;
  const reasoning = agentReasoning ?? variantReasoning ?? model?.data.settings?.reasoningEffort ?? model?.data.options?.reasoningEffort
    ?? model?.data.providerSettings?.reasoningEffort ?? model?.data.providerOptions?.reasoningEffort;
  const reasoningSource = agentReasoning != null
    ? 'Configured · agent' : variantReasoning !== undefined ? `Inherited · variant ${variant}`
      : reasoning !== undefined ? 'Inherited · model/provider options' : 'Unknown · not configured';
  const reasoningLabel = variant
    ? reasoning == null || reasoning === variant ? variant : `${variant} · ${configText(reasoning)} effort`
    : configText(reasoning);
  const modelLabel = selection.id ? `${selection.id}${!inherited && selection.variant ? `#${selection.variant}` : ''}` : configText(entry.data.model);
  const variantSource = !inherited && selection.variant ? entry.provenance.model : entry.provenance.variant;
  return { model, modelLabel, variant, variantSource, reasoning, reasoningSource, reasoningLabel };
}
