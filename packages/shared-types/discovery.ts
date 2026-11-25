export interface ModelDiscovery {
  id: string
  label: string
  efforts: string[]
}

// A catalog entry carries only observed metadata. Execution capabilities
// need independent verification before an adapter can advertise them.
export function normalizeCodexModel(value: unknown): ModelDiscovery | null {
  if (!value || typeof value !== 'object') return null
  const model = value as Record<string, unknown>
  if (typeof model.id !== 'string' || !model.id.trim() ||
      typeof model.displayName !== 'string' || !model.displayName.trim() ||
      !Array.isArray(model.supportedReasoningEfforts)) return null

  const efforts = new Set<string>()
  for (const entry of model.supportedReasoningEfforts as unknown[]) {
    if (!entry || typeof entry !== 'object' || !('reasoningEffort' in entry) ||
        typeof entry.reasoningEffort !== 'string' || !entry.reasoningEffort.trim()) return null
    efforts.add(entry.reasoningEffort)
  }
  return { id: model.id, label: model.displayName, efforts: [...efforts] }
}
