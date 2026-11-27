import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const desktop = join(process.cwd(), 'apps', 'desktop')
const dataDir = await mkdtemp(join(tmpdir(), 'ghost-discussion-electron-'))
const launch = () => electron.launch({
  executablePath: join(desktop, 'node_modules', '.bin', 'electron'),
  args: [join(desktop, 'dist-electron/main.js')],
  cwd: desktop,
  env: { ...process.env, GHOST_BOT_DATA_DIR: dataDir, GHOST_BOT_RUNTIME_MODE: 'mock', GHOST_BOT_SMOKE_EXIT: '0' },
})

let app
try {
  app = await launch()
  let page = await app.firstWindow()
  await page.getByText('Chief of Staff', { exact: true }).first().waitFor()
  const teamId = await page.evaluate(async () => (await window.ghostBot.createTeam({
    name: 'Discussion fixture', leadBotId: 'chief', memberBotIds: ['chief', 'developer'],
  })).id)
  await page.reload()
  const selectTeam = () => page.locator(`[data-team-id="${teamId}"] .gb-team-item`).click()
  await selectTeam()
  const compose = page.getByLabel('Group discussion message')
  await compose.fill('Offline hello')
  await page.getByRole('button', { name: 'Insert member mention' }).click()
  await page.getByRole('button', { name: /Developer.*@developer/i }).click()
  await page.getByRole('button', { name: 'Send to group' }).click()
  await page.getByText('[Mock response] Offline hello @developer', { exact: true }).waitFor()
  const turns = () => page.evaluate((id) => window.ghostBot.listTeamDiscussion({ teamId: id }), teamId)
  assert.deepEqual((await turns()).turns[0].replies.map((reply) => reply.botId), ['developer'])
  const fanout = await page.evaluate(async (id) => {
    const request = { teamId: id, text: '@all offline check', operationId: crypto.randomUUID() }
    const first = await window.ghostBot.sendTeamDiscussion(request)
    const second = await window.ghostBot.sendTeamDiscussion(request)
    return { first, second }
  }, teamId)
  assert.equal(fanout.first.id, fanout.second.id)
  assert.deepEqual(fanout.first.replies.map((reply) => reply.botId), ['chief', 'developer'])
  await assert.rejects(page.evaluate((id) => window.ghostBot.sendTeamDiscussion({
    teamId: id, text: '@researcher outside this group', operationId: crypto.randomUUID(),
  }), teamId), /Mention only members/)
  await page.getByRole('button', { name: /Discussion rounds/ }).click()
  await page.getByRole('button', { name: '2 rounds' }).click()
  await compose.fill('@all two round check')
  await page.getByRole('button', { name: 'Send to group' }).click()
  await page.getByText('Round 2', { exact: true }).first().waitFor()

  await page.getByRole('button', { name: 'Advanced tasks' }).click()
  await page.getByLabel('Team goal input').waitFor()
  await app.close()

  app = await launch()
  page = await app.firstWindow()
  await selectTeam()
  assert.equal((await turns()).turns.length, 3)
  await page.getByText('[Mock response] Offline hello @developer', { exact: true }).waitFor()
  await page.getByText('Round 2', { exact: true }).first().waitFor()
  console.log('Alpha.1C offline Electron verified discussion, mentions, 2-round rebuttal, idempotency, advanced tasks and restart')
} finally {
  await app?.close()
  await rm(dataDir, { recursive: true, force: true })
}
