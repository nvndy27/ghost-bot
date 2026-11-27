export type WorkspaceTabId = 'overview' | 'files' | 'changes' | 'browser' | 'output'

export interface WorkspaceTabDefinition {
  id: WorkspaceTabId
  label: string
  shortLabel: string
  implemented: boolean
  milestone?: string
  summary: string
}

export const WORKSPACE_TABS: readonly WorkspaceTabDefinition[] = [
  {
    id: 'overview',
    label: 'Overview',
    shortLabel: 'Overview',
    implemented: true,
    summary: 'Live computer, active tasks, routines, connected tools, and account usage.',
  },
  {
    id: 'files',
    label: 'Files / Editor',
    shortLabel: 'Files',
    implemented: true,
    milestone: 'Alpha.2B',
    summary: 'Authorized workspace file tree and embedded editor.',
  },
  {
    id: 'changes',
    label: 'Changes',
    shortLabel: 'Changes',
    implemented: false,
    milestone: 'Alpha.2D',
    summary: 'Read-only Git status and diff inspection are not yet enabled in Alpha.2A.',
  },
  {
    id: 'browser',
    label: 'Browser',
    shortLabel: 'Browser',
    implemented: false,
    milestone: 'Alpha.2E',
    summary: 'Embedded live preview browser is not yet enabled in Alpha.2A.',
  },
  {
    id: 'output',
    label: 'Output',
    shortLabel: 'Output',
    implemented: false,
    milestone: 'Alpha.2F',
    summary: 'Persisted run and command output stream is not yet enabled in Alpha.2A.',
  },
] as const

export function getNextWorkspaceTab(
  current: WorkspaceTabId,
  key: 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End',
): WorkspaceTabId {
  if (key === 'Home') return WORKSPACE_TABS[0].id
  if (key === 'End') return WORKSPACE_TABS[WORKSPACE_TABS.length - 1].id
  const idx = WORKSPACE_TABS.findIndex((tab) => tab.id === current)
  const safeIdx = idx === -1 ? 0 : idx
  const delta = key === 'ArrowRight' ? 1 : -1
  const nextIdx = (safeIdx + delta + WORKSPACE_TABS.length) % WORKSPACE_TABS.length
  return WORKSPACE_TABS[nextIdx].id
}
