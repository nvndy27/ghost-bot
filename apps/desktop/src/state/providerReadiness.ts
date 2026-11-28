import type { SelectedBotReadiness } from '@ghost-bot/shared-types/ipc'

export function providerReadinessLabel(readiness: SelectedBotReadiness | null | undefined): string {
  if (!readiness) return 'Checking provider…'
  switch (readiness.status) {
    case 'ready': return 'Ready'
    case 'mock': return 'Offline Demo'
    case 'runtime-unavailable': return 'Runtime unavailable'
    case 'provider-not-configured': return 'Provider setup required'
    case 'authentication-required': return 'Sign-in required'
    case 'catalog-unavailable': return 'Models unavailable'
    case 'model-unavailable': return 'Model unavailable'
    case 'effort-unsupported': return 'Effort unavailable'
    case 'permission-unsupported': return 'Permission gated'
    case 'workspace-unavailable': return 'Choose workspace'
    case 'execution-gated': return 'Execution gated'
  }
}
