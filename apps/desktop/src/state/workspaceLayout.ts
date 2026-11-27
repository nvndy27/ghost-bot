export const WORKSPACE_MIN_WIDTH = 220
export const WORKSPACE_DEFAULT_WIDTH = 400
export const WORKSPACE_DESKTOP_MAX_RATIO = 0.65
export const WORKSPACE_OVERLAY_MAX_RATIO = 0.9

/** Computes the visible width without changing the user's persisted preference. */
export function effectiveWorkspaceWidth(
  preferredWidth: number,
  viewportWidth: number,
  overlay: boolean,
): number {
  const ratio = overlay ? WORKSPACE_OVERLAY_MAX_RATIO : WORKSPACE_DESKTOP_MAX_RATIO
  const viewportMaximum = Math.max(WORKSPACE_MIN_WIDTH, Math.floor(viewportWidth * ratio))
  return Math.max(WORKSPACE_MIN_WIDTH, Math.min(preferredWidth, viewportMaximum))
}
