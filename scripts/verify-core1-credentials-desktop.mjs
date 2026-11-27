import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const tempRoot = mkdtempSync(join(tmpdir(), 'ghost-core1-e2e-'))
chmodSync(tempRoot, 0o700)
const dataDir = join(tempRoot, 'data')
const fixtureDir = join(tempRoot, 'fixture')
mkdtempSync(join(tempRoot, 'unused'))
const ns = `core1-e2e-${randomUUID().slice(0, 8)}`
const fixtureScript = join(tempRoot, 'mcp-e2e-fixture.mjs')

writeFileSync(
  fixtureScript,
  `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'core1-e2e-fixture', version: '1.0.0' }
      }
    }) + '\\n');
    return;
  }
  if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools: [{ name: 'ping_secret', description: 'Checks env', inputSchema: { type: 'object', properties: {} } }] }
    }) + '\\n');
    return;
  }
  if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
  }
});
`,
  'utf8',
)
chmodSync(fixtureScript, 0o700)
chmodSync(tempRoot, 0o700)

const app = await electron.launch({
  args: [resolve('apps/desktop/dist-electron/main.js'), '--no-sandbox'],
  env: {
    ...process.env,
    GHOST_BOT_DATA_DIR: dataDir,
    GHOST_BOT_RUNTIME_MODE: 'mock',
    GHOST_SECRET_NAMESPACE: ns,
  },
})

try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  await win.getByRole('button', { name: /Settings/i }).click()
  const settings = win.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: /^Tools & MCP$/i }).click()

  await settings.getByTestId('mcp-keyring-status').waitFor({ timeout: 10_000 })
  const keyringText = await settings.getByTestId('mcp-keyring-status').innerText()
  assert.match(keyringText, /Available \(linux-secret-service\)/i)

  await settings.getByTestId('mcp-enabled-toggle').check()
  await settings.getByTestId('mcp-name-input').fill('Core1 Secret Server')
  await settings.getByTestId('mcp-exec-input').fill(process.execPath)
  await settings.getByTestId('mcp-cwd-input').fill(tempRoot)
  await settings.getByTestId('mcp-args-input').fill(fixtureScript)
  await settings.getByTestId('mcp-register-btn').click()

  const credBtn = settings.locator('[data-testid^="mcp-manage-secrets-"]').first()
  await credBtn.waitFor({ timeout: 10_000 })
  await credBtn.click()

  await settings.getByTestId('mcp-credentials-panel').waitFor({ timeout: 10_000 })
  await settings.getByTestId('mcp-secret-env-input').fill('MCP_FIXTURE_API_KEY')
  await settings.getByTestId('mcp-secret-refid-input').fill('gh-pat-1')
  await settings.getByTestId('mcp-secret-label-input').fill('Synthetic E2E PAT')
  await settings.getByTestId('mcp-secret-value-input').fill('syn_e2e_secret_value_1')
  await settings.getByTestId('mcp-secret-save-btn').click()

  try {
    await settings.getByTestId('mcp-secret-ref-gh-pat-1').waitFor({ timeout: 5_000 })
  } catch (err) {
    const banner = await settings.getByTestId('mcp-error-banner').innerText().catch(() => '(no error banner)')
    throw new Error(`Secret ref did not appear. Banner: ${banner}`, { cause: err })
  }
  const refText = await settings.getByTestId('mcp-secret-ref-gh-pat-1').innerText()
  assert.match(refText, /stored in keyring/i)
  assert.ok(!refText.includes('syn_e2e_secret_value_1'), 'Secret value must never appear in UI')

  // Replace credential
  await settings.getByTestId('mcp-secret-replace-gh-pat-1').click()
  await settings.getByTestId('mcp-secret-value-input').fill('syn_e2e_secret_value_2')
  await settings.getByTestId('mcp-secret-save-btn').click()
  await settings.getByText(/Saved secret reference "gh-pat-1"/i).waitFor({ timeout: 10_000 })

  // Approve trust, enable, connect with real OS keyring secret injection
  await settings.locator('[data-testid^="mcp-approve-trust-"]').first().click()
  await settings.locator('[data-testid^="mcp-toggle-enabled-"]').first().waitFor({ timeout: 10_000 })
  await settings.locator('[data-testid^="mcp-toggle-enabled-"]').first().click()
  await settings.locator('[data-testid^="mcp-connect-"]').first().click()
  await settings.locator('[data-testid^="mcp-conn-"]').first().getByText('ready').waitFor({ timeout: 10_000 })

  // Delete credential with confirmation
  await settings.getByTestId('mcp-secret-delete-gh-pat-1').click()
  await settings.getByTestId('mcp-secret-confirm-delete-gh-pat-1').click()
  await settings.getByText(/Deleted secret reference "gh-pat-1"/i).waitFor({ timeout: 10_000 })

  console.log('CORE1_ELECTRON_CREDENTIALS_E2E_PASSED')
} finally {
  await app.close()
  rmSync(tempRoot, { recursive: true, force: true })
}
