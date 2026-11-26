import type { TeamRecord, TeamTaskPlan } from '../contracts/types.ts'
import { TeamError, validateTaskPlan } from '../security/validation.ts'

export interface TeamPlanPreview {
  valid: boolean
  errors: Array<{ code: string; message: string }>
  warnings: string[]
  layers: Array<{ layer: number; planKeys: string[] }>
  dependencies: Array<{ planKey: string; dependsOn: string[] }>
  assignedMembers: string[]
  estimatedTokenAllocation: Record<string, number>
  maxPossibleConcurrency: number
  unboundedPeakWidth: number
  totalPlannedTasks: number
  isEstimateOnly: true
}

/**
 * Pure validation and execution-layer preview for a proposed team task plan.
 * Never executes tasks, mutates storage, or calls any planner/runtime.
 */
export function previewTeamPlan(team: TeamRecord, plan: TeamTaskPlan): TeamPlanPreview {
  try {
    const validated = validateTaskPlan(plan, team)
    const byLayer = new Map<number, string[]>()
    const members = new Set<string>()
    const estimatedTokenAllocation: Record<string, number> = {}
    const defaultPerTaskTokens = Math.max(
      1,
      Math.floor(team.bounds.maxTokens / validated.tasks.length),
    )

    let totalEstimatedTokens = 0
    for (const t of validated.tasks) {
      const layer = t.depth
      const list = byLayer.get(layer) ?? []
      list.push(t.planKey)
      byLayer.set(layer, list)
      members.add(t.assignedBotId)

      const est = t.tokenBudget ?? defaultPerTaskTokens
      estimatedTokenAllocation[t.planKey] = est
      totalEstimatedTokens += est
    }

    const layers = [...byLayer.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([layer, planKeys]) => ({ layer, planKeys: planKeys.sort() }))

    const unboundedPeakWidth = layers.reduce((m, l) => Math.max(m, l.planKeys.length), 0)
    const maxPossibleConcurrency = Math.min(unboundedPeakWidth, team.bounds.maxConcurrentTasks)

    const warnings: string[] = []
    if (totalEstimatedTokens > team.bounds.maxTokens) {
      warnings.push(
        `Estimated token allocation (${totalEstimatedTokens}) exceeds team maxTokens (${team.bounds.maxTokens})`,
      )
    }
    if (unboundedPeakWidth > team.bounds.maxConcurrentTasks) {
      warnings.push(
        `Peak parallel width (${unboundedPeakWidth}) exceeds maxConcurrentTasks (${team.bounds.maxConcurrentTasks}); execution will serialize across waves`,
      )
    }
    if (members.size === 1 && validated.tasks.length > 1) {
      warnings.push('All planned tasks are assigned to a single bot')
    }

    return {
      valid: true,
      errors: [],
      warnings,
      layers,
      dependencies: validated.tasks.map((t) => ({
        planKey: t.planKey,
        dependsOn: [...t.dependsOn],
      })),
      assignedMembers: [...members].sort(),
      estimatedTokenAllocation,
      maxPossibleConcurrency,
      unboundedPeakWidth,
      totalPlannedTasks: validated.tasks.length,
      isEstimateOnly: true,
    }
  } catch (err) {
    const code = err instanceof TeamError ? err.code : 'INVALID_PLAN'
    const message = err instanceof Error ? err.message : 'Invalid team plan'
    return {
      valid: false,
      errors: [{ code, message }],
      warnings: [],
      layers: [],
      dependencies: [],
      assignedMembers: [],
      estimatedTokenAllocation: {},
      maxPossibleConcurrency: 0,
      unboundedPeakWidth: 0,
      totalPlannedTasks: 0,
      isEstimateOnly: true,
    }
  }
}
