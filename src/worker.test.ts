// The commands of the worker, run against a mock host. The test never signals a real Orca: the parent check
// refuses (the test runner's parent is not an Orca main process), and CLAUDE_CONFIG_DIR points at a scratch dir,
// so `claude plugin ...` never touches the real ~/.claude.
import { test, assert, mountWorker } from 'orca/testing'
import * as worker from './worker.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findClaude, isEnabled } from './claude.ts'

const scratch = mkdtempSync(join(tmpdir(), 'bash-mode-test-'))
process.env.CLAUDE_CONFIG_DIR = scratch

test('without a safe parent the worker injects nothing and says why', async () => {
  const w = await mountWorker(worker)
  const out = String(await w.command('bash-mode.inject'))
  assert.match(out, /Bash mode is not active: parent process is not the Orca main process/)
  assert.match(out, /Claude plugin bang-shell: NOT installed/)
  await w.deactivate()
})

test('removing from the page is refused the same way, not attempted', async () => {
  const w = await mountWorker(worker)
  assert.match(String(await w.command('bash-mode.remove')), /Could not remove it: parent process is not the Orca main process/)
  await w.deactivate()
})

test('uninstall only describes itself on the first call and changes nothing', async () => {
  const w = await mountWorker(worker)
  const first = String(await w.command('bash-mode.uninstall'))
  assert.match(first, /Run this command again within 60 seconds to confirm/)
  assert.match(first, /leaves the Claude plugin bang-shell alone: this plugin did not install it/)
  await w.deactivate()
})

test('install asks first, and changes nothing until it is asked twice', async () => {
  const w = await mountWorker(worker)
  const first = String(await w.command('bash-mode.install-claude-plugin'))
  assert.match(first, /Run this command again within 60 seconds to confirm/)
  assert.match(first, /without a permission prompt/)
  assert.equal(isEnabled(), false)
  await w.deactivate()
})

test('asked twice, install really installs into the scratch config and remembers that it did', async () => {
  if (!findClaude()) return                       // nothing to run it with on this machine
  const w = await mountWorker(worker)
  await w.command('bash-mode.install-claude-plugin')
  const done = String(await w.command('bash-mode.install-claude-plugin'))
  assert.match(done, /^Installed\./)
  assert.equal(isEnabled(), true)
  // uninstall now knows the Claude plugin is ours (only its first, harmless call is run here: the second would uninstall for real)
  assert.match(String(await w.command('bash-mode.uninstall')), /uninstalls the Claude plugin bang-shell that this plugin installed/)
  assert.match(String(await w.command('bash-mode.install-claude-plugin')), /already installed/)
  await w.deactivate()
})

test('cleanup', () => { rmSync(scratch, { recursive: true, force: true }) })
