import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const repoRoot = process.cwd()
const desktopDir = join(repoRoot, 'apps', 'desktop')
const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-alpha1a-e2e-'))
const combined = process.argv.includes('--shared-convergence')
const workspace = join(dataDir, 'workspace')
const workspaceFile = join(workspace, 'sample.txt')
const screenshotDir = process.env.ALPHA1A_SCREENSHOT_DIR || ''

async function launchDesktop() {
  return electron.launch({
    executablePath: join(desktopDir, 'node_modules', '.bin', 'electron'),
    args: [join(desktopDir, 'dist-electron', 'main.js')],
    cwd: desktopDir,
    env: {
      ...process.env,
      GHOST_BOT_DATA_DIR: dataDir,
      GHOST_BOT_RUNTIME_MODE: 'mock',
      GHOST_BOT_SMOKE_EXIT: '0',
    },
  })
}

async function getBotOrder(page) {
  return page.locator('.gb-bot-list [data-bot-id]').evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-bot-id')),
  )
}

let chiefSessionId
let researcherSessionId
let teamId

try {
  // Launch 1: Provider labels, pinning/ordering, team creation+pin, multi-conversation, unread/read, screenshots
  const app1 = await launchDesktop()
  try {
    const page = await app1.firstWindow()
    page.setDefaultTimeout(8000)
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.waitForSelector('text=Chief of Staff')

    // 1. Sidebar rows show provider label ('Mock') and NEVER model/effort
    const botRowsText = await page.locator('.gb-bot-list .gb-bot-status').allTextContents()
    assert.ok(botRowsText.length >= 5)
    for (const label of botRowsText) {
      assert.equal(label.trim(), 'Mock')
    }
    const sidebarFullText = await page.locator('.gb-bot-list').textContent()
    assert.ok(!sidebarFullText?.includes('gpt-6.2-mock'))
    assert.ok(!sidebarFullText?.includes('codex-mock'))

    let previousGrant
    if (combined) {
      await mkdir(workspace)
      await writeFile(workspaceFile, 'Shared baseline fixture\n')
      await page.evaluate((workspacePath) => window.ghostBot.updateBot({
        id: 'chief', patch: { workspacePath, permission: 'read-only' },
      }), workspace)
      await page.reload()
      await page.getByRole('complementary', { name: 'Bot workspace panel' }).waitFor()
      await page.getByTestId('workspace-tab-files').click()
      await app1.evaluate(({ dialog }, chosen) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] })
      }, workspace)
      await page.getByRole('button', { name: 'Allow read access', exact: true }).click()
      await page.getByTestId('workspace-tree-entry-sample.txt').click()
      const editor = page.getByTestId('workspace-editor-textarea')
      assert.equal(await editor.inputValue(), 'Shared baseline fixture\n')
      assert.equal(await editor.getAttribute('readonly'), '')
      previousGrant = await page.evaluate(async () => {
        const context = await window.ghostBot.resolveWorkspaceContext({ botId: 'chief' })
        if (!context.authorized) throw new Error('Missing workspace authorization')
        return { botId: 'chief', workspaceId: context.workspaceId, authGeneration: context.authGeneration, relativePath: 'sample.txt' }
      })
      const { revision } = await page.evaluate((target) => window.ghostBot.readWorkspaceFile(target), previousGrant)
      await assert.rejects(page.evaluate(({ target, revision }) => window.ghostBot.saveWorkspaceFile({
        ...target, expectedRevision: revision, content: 'Must not be written',
      }), { target: previousGrant, revision }), /saving is disabled/i)
      assert.equal(await readFile(workspaceFile, 'utf8'), 'Shared baseline fixture\n')
    }

    // 2. Verify all 12 avatar presets remain intact in Edit bot
    await page.getByRole('button', { name: 'Edit bot' }).click()
    const presetCount = await page.locator('[aria-label^="Shape "]').count()
    assert.equal(presetCount, 12)

    // Change Chief of Staff runtime to Claude API -> sidebar provider label immediately updates to 'Claude'
    await page.getByTestId('bot-runtime-select').selectOption('claude-api')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await page.getByRole('dialog', { name: 'Edit bot' }).waitFor({ state: 'hidden' }).catch(async (error) => {
      const details = await page.getByRole('dialog', { name: 'Edit bot' }).getByRole('alert').allTextContents()
      throw new Error(details.join(' ') || error.message)
    })
    await page.waitForSelector('.gb-bot-list [data-bot-id="chief"] .gb-bot-status:has-text("Claude")')

    if (combined) {
      await assert.rejects(page.evaluate((target) => window.ghostBot.readWorkspaceFile(target), previousGrant), /authorization changed/i)
      await page.getByTestId('workspace-files-unavailable').waitFor()
      assert.equal(await page.getByTestId('workspace-editor-textarea').count(), 0)
    }

    // Revert Chief of Staff back to mock-offline so we can run mock conversations on it too
    await page.getByRole('button', { name: 'Edit bot' }).click()
    await page.getByTestId('bot-runtime-select').selectOption('mock-offline')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await page.waitForSelector('.gb-bot-list [data-bot-id="chief"] .gb-bot-status:has-text("Mock")')

    if (combined) {
      await page.getByRole('button', { name: 'Allow read access', exact: true }).click()
      await page.getByTestId('workspace-tree-entry-sample.txt').waitFor()
    }

    // Change Developer runtime to claude-api so we verify persisted provider label across restart
    await page.locator('.gb-bot-list [data-bot-id="developer"] [role="option"]').click()
    await page.getByRole('button', { name: 'Edit bot' }).click()
    await page.getByTestId('bot-runtime-select').selectOption('claude-api')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await page.waitForSelector('.gb-bot-list [data-bot-id="developer"] .gb-bot-status:has-text("Claude")')

    // 3. Pin Researcher -> moves to top of bot list
    await page.locator('.gb-bot-list [data-bot-id="researcher"]').hover()
    await page.getByRole('button', { name: 'Pin Researcher' }).click()
    await page.waitForFunction(() => {
      const first = document.querySelector('.gb-bot-list [data-bot-id]')
      return first?.getAttribute('data-bot-id') === 'researcher'
    })

    // Pin Chief of Staff and move it above Researcher
    await page.locator('.gb-bot-list [data-bot-id="chief"]').hover()
    await page.getByRole('button', { name: 'Pin Chief of Staff' }).click()
    await page.getByRole('button', { name: 'Move Chief of Staff down' }).click()
    await page.waitForFunction(() => document.querySelector('.gb-bot-list [data-bot-id]')?.getAttribute('data-bot-id') === 'researcher')
    await page.getByRole('button', { name: 'Move Chief of Staff up' }).click()
    await page.waitForFunction(() => {
      const els = [...document.querySelectorAll('.gb-bot-list [data-bot-id]')]
      return (
        els[0]?.getAttribute('data-bot-id') === 'chief' &&
        els[1]?.getAttribute('data-bot-id') === 'researcher'
      )
    })

    // Create a Team and pin it
    await page.getByRole('button', { name: 'Create team' }).click()
    await page.getByPlaceholder('e.g. Research & Verification Squad').fill('Alpha Review Team')
    await page.getByRole('button', { name: 'Create team' }).last().click()
    await page.waitForSelector('.gb-left-sidebar >> text=Alpha Review Team')
    const pinTeam = page.getByRole('button', { name: 'Pin Alpha Review Team' })
    await pinTeam.focus()
    await page.keyboard.press('Enter')
    const teamRow = page.locator('[data-team-id]').filter({ hasText: 'Alpha Review Team' })
    teamId = await teamRow.getAttribute('data-team-id')
    await teamRow.getByRole('button', { name: 'Unpin Alpha Review Team' }).waitFor()

    if (combined) {
      await page.getByRole('complementary', { name: 'Team workspace panel' }).waitFor()
      await page.getByText('Group workspace requires an authorized task scope', { exact: false }).waitFor()
      await page.getByTestId('workspace-tab-overview').click()
      await page.getByLabel('Team activity panel').waitFor()
      await page.getByTestId('workspace-tab-files').click()
      await page.getByText('Group workspace requires an authorized task scope', { exact: false }).waitFor()
    }

    // Search filters both bots and teams
    await page.getByLabel('Search bots').fill('Alpha Review')
    assert.equal(await page.locator('.gb-bot-list [data-bot-id]').count(), 0)
    assert.equal(await page.locator('[data-team-id]').count(), 1)
    await page.getByLabel('Search bots').fill('')
    assert.ok((await page.locator('.gb-bot-list [data-bot-id]').count()) >= 5)

    // 4. Multi-conversation management under Chief of Staff
    await page.locator('.gb-bot-list [data-bot-id="chief"] [role="option"]').click()
    await page.waitForSelector('header >> text=Chief of Staff')

    const initialSessId = await page.getByLabel('Conversation session').inputValue()
    chiefSessionId = initialSessId
    await page.getByRole('button', { name: 'New conversation' }).click()
    await page.waitForFunction(
      (oldId) => {
        const sel = document.querySelector('select[aria-label="Conversation session"]')
        return sel && sel.value && sel.value !== oldId
      },
      initialSessId,
    )
    const secondSessId = await page.getByLabel('Conversation session').inputValue()
    assert.notEqual(secondSessId, initialSessId)

    // Rename second conversation in Manage conversations popover
    await page.getByRole('button', { name: 'Manage conversations' }).click()
    await page.waitForSelector('[role="dialog"][aria-label="Conversations"]')
    await page.locator(`[data-session-id="${secondSessId}"]`).getByRole('button', { name: /Rename/ }).click()
    await page.getByLabel('Rename conversation title').fill('Architecture Thread')
    await page.getByRole('button', { name: 'Save conversation title' }).click()
    await page.waitForSelector('[role="dialog"][aria-label="Conversations"] >> text=Architecture Thread')

    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true })
      await page.screenshot({ path: join(screenshotDir, 'alpha1a-popover-dark.png') })
    }

    if (combined) {
      await page.keyboard.press('Escape')
      await page.getByLabel('Conversation session').selectOption(initialSessId)
      const composer = page.getByPlaceholder('Message Chief of Staff...')
      await composer.fill('early-cancel conversation switch fixture')
      await page.getByRole('button', { name: 'Send message' }).click()
      await page.getByRole('button', { name: 'Stop generation' }).waitFor()
      await page.getByLabel('Conversation session').selectOption(secondSessId)
      await page.getByRole('button', { name: 'Send message' }).waitFor()
      await page.waitForFunction(async ({ first, second }) => {
        const bridge = window.ghostBot
        const { messages } = await bridge.listMessages({ sessionId: first })
        const other = await bridge.listMessages({ sessionId: second })
        return other.messages.length === 0 && messages.some((message) =>
          message.role === 'assistant' && message.status === 'complete' &&
          message.text.includes('conversation switch fixture'))
      }, { first: initialSessId, second: secondSessId })
      await page.getByRole('button', { name: 'Manage conversations' }).click()
    }

    // Archive the renamed conversation and verify active session switches cleanly
    await page.locator(`[data-session-id="${secondSessId}"]`).getByRole('button', { name: /Archive/ }).click()
    await page.waitForFunction(
      (archivedId) => {
        const sel = document.querySelector('select[aria-label="Conversation session"]')
        return sel && sel.value && sel.value !== archivedId
      },
      secondSessId,
    )
    // Close popover
    await page.keyboard.press('Escape')

    // 5. Unread/completion indicator when switching away during a run
    await page.getByPlaceholder('Message Chief of Staff...').fill('Background task prompt')
    await page.getByRole('button', { name: 'Send message' }).click()
    // Switch to Researcher immediately while Chief's mock run completes in background
    await page.locator('.gb-bot-list [data-bot-id="researcher"] [role="option"]').click()
    await page.waitForSelector('header >> text=Researcher')
    // Wait for Chief of Staff's unread pill to appear in sidebar
    await page.waitForSelector('.gb-bot-list [data-bot-id="chief"] .gb-unread-pill', {
      timeout: 10000,
    })

    const researcherConversation = page.getByLabel('Conversation session')
    const firstResearcherSession = await researcherConversation.inputValue()
    await page.getByRole('button', { name: 'New conversation' }).click()
    await page.waitForFunction((previous) => {
      const select = document.querySelector('select[aria-label="Conversation session"]')
      return select?.value && select.value !== previous
    }, firstResearcherSession)
    researcherSessionId = await researcherConversation.inputValue()
    if (combined) {
      await page.waitForFunction(async (sessionId) => {
        const { messages } = await window.ghostBot.listMessages({ sessionId })
        return messages.some((message) => message.role === 'assistant' && message.status === 'complete' &&
          message.text.includes('Background task prompt'))
      }, chiefSessionId)
      const context = await page.evaluate(() => window.ghostBot.resolveWorkspaceContext({ botId: 'chief' }))
      assert.equal(context.authorized, true)
    }
    const histories = await page.evaluate(async (ids) => {
      return Promise.all(ids.map(async (sessionId) => window.ghostBot.listMessages({ sessionId })))
    }, [chiefSessionId, researcherSessionId])
    assert.match(histories[0].messages.find((message) => message.role === 'assistant' && message.text.includes('Background task prompt'))?.text ?? '', /Received your request:.*Background task prompt/)
    assert.equal(histories[1].messages.length, 0)
    assert.equal(await page.getByText(/Received your request:.*Background task prompt/).count(), 0)

    if (screenshotDir) {
      await page.screenshot({ path: join(screenshotDir, 'alpha1a-dark.png') })
      // Also capture light theme screenshot
      await page.getByRole('button', { name: 'Open Settings' }).click()
      await page.getByRole('button', { name: 'Appearance' }).click()
      await page.getByLabel('Theme').selectOption('light')
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
      await page.getByRole('button', { name: 'Close settings' }).click()
      await page.screenshot({ path: join(screenshotDir, 'alpha1a-light.png') })
      // Restore dark theme
      await page.getByRole('button', { name: 'Open Settings' }).click()
      await page.getByRole('button', { name: 'Appearance' }).click()
      await page.getByLabel('Theme').selectOption('dark')
      await page.getByRole('button', { name: 'Close settings' }).click()
    }
  } finally {
    await app1.close()
  }

  // Launch 2: Verify pin order, Developer -> Claude provider label, and Chief unread badge survive restart!
  const app2 = await launchDesktop()
  try {
    const page = await app2.firstWindow()
    page.setDefaultTimeout(8000)
    await page.waitForSelector('text=Chief of Staff')

    if (combined) {
      await page.waitForSelector('[data-active-tab="files"]')
      const context = await page.evaluate(() => window.ghostBot.resolveWorkspaceContext({ botId: 'chief' }))
      assert.equal(context.authorized, false)
      assert.equal(context.authGeneration, null)
    }

    const order = await getBotOrder(page)
    assert.equal(order[0], 'chief')
    assert.equal(order[1], 'researcher')

    const devProvider = await page
      .locator('.gb-bot-list [data-bot-id="developer"] .gb-bot-status')
      .textContent()
    assert.equal(devProvider?.trim(), 'Claude')

    await page.waitForFunction((expected) => {
      return document.querySelector('select[aria-label="Conversation session"]')?.value === expected
    }, researcherSessionId)
    await page.getByRole('button', { name: 'Unpin Alpha Review Team' }).waitFor()

    // Chief of Staff still shows unread pill after restart until visited
    await page.waitForSelector('.gb-bot-list [data-bot-id="chief"] .gb-unread-pill')
    await page.locator('.gb-bot-list [data-bot-id="chief"] [role="option"]').click()
    await page.waitForSelector('header >> text=Chief of Staff')
    // Selecting Chief's active session marks it read
    await page.waitForFunction(
      () => !document.querySelector('.gb-bot-list [data-bot-id="chief"] .gb-unread-pill'),
    )
    await page.getByText(/Received your request:.*Background task prompt/).waitFor()

    const researcherRow = page.locator('[data-bot-id="researcher"]')
    await researcherRow.getByRole('button', { name: 'Unpin Researcher' }).press('Enter')
    await researcherRow.getByRole('button', { name: 'Pin Researcher', exact: true }).press('Enter')
    await researcherRow.getByRole('button', { name: 'Unpin Researcher' }).waitFor()
    await researcherRow.getByRole('option').click()
    await page.getByRole('button', { name: 'Edit bot' }).click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm delete', exact: true }).click()
    await researcherRow.waitFor({ state: 'detached' })

    await page.locator(`[data-team-id="${teamId}"]`).getByText('Alpha Review Team').click()
    await page.getByRole('button', { name: 'Edit team' }).click()
    await page.getByRole('button', { name: 'Archive team' }).click()
    await page.getByRole('button', { name: 'Confirm archive' }).click()
    await page.locator(`[data-team-id="${teamId}"]`).waitFor({ state: 'detached' })
    const saved = await page.evaluate(() => window.ghostBot.getSidebarOrganization())
    assert.ok(!saved.pinnedBotIds.includes('researcher'))
    assert.ok(!saved.botOrder.includes('researcher'))
    assert.ok(!saved.pinnedTeamIds.includes(teamId))
    assert.ok(!saved.teamOrder.includes(teamId))

  } finally {
    await app2.close()
  }

  console.log(JSON.stringify({ alpha1aElectronE2E: 'passed', launches: 2, combined }))
} finally {
  await rm(dataDir, { recursive: true, force: true })
}
