import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AppearanceSettingsSchema } from '../packages/shared-types/ipc.ts'
import { effectiveWorkspaceWidth } from '../apps/desktop/src/state/workspaceLayout.ts'

test('V03.2 workspace defaults and settings validation preserve saved widths', () => {
  assert.equal(AppearanceSettingsSchema.parse({}).rightWidth, 400)
  assert.equal(AppearanceSettingsSchema.parse({ rightWidth: 285 }).rightWidth, 285)
  assert.equal(AppearanceSettingsSchema.parse({ rightWidth: 2048 }).rightWidth, 2048)
  assert.equal(AppearanceSettingsSchema.safeParse({ rightWidth: 2049 }).success, false)
})

test('workspace effective bounds use desktop 65% and narrow overlay 90% without mutating preference', () => {
  const savedWidth = 1100
  assert.equal(effectiveWorkspaceWidth(savedWidth, 1440, false), 936)
  assert.equal(effectiveWorkspaceWidth(savedWidth, 760, true), 684)
  assert.equal(effectiveWorkspaceWidth(400, 400, true), 360)
  assert.equal(effectiveWorkspaceWidth(savedWidth, 300, true), 270)
  assert.equal(savedWidth, 1100)
})
