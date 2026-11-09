// Bash Mode for Orca: puts a "bash" mode into the structured chat composer.
//
// Orca gives plugins no way to touch the chat page, so this worker reaches it the only way left:
//   1. SIGUSR1 to its parent (the Orca main process) makes Node open the inspector on 127.0.0.1:9229;
//   2. it connects, and from the main process runs `webContents.executeJavaScript(page-script.js)`;
//   3. it asks the main process to re-inject after every page load, then closes the inspector again.
// The inspector is open for about a second. Nothing on disk is modified and no start-up flag is needed.
import type { OrcaWorkerApi } from 'orca/worker'
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as claude from './claude.ts'
import { isOrcaMainCommand } from './guard.ts'

const PORT = 9229
const STATUS_ID = 'status'
const RETRY_MS = [4_000, 12_000, 30_000, 60_000]
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

type Target = { title?: string; webSocketDebuggerUrl: string }
type State = 'working' | 'ok' | 'failed' | 'removed'

const pageScript = () => readFileSync(fileURLToPath(new URL('./page-script.js', import.meta.url)), 'utf8')

// The worker is forked by the main process, so its parent must be that app's own main executable (see guard.ts).
function parentIsOrcaMain(): string | null {
  const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(process.ppid)]).toString().trim()
  return isOrcaMainCommand(cmd, process.execPath, process.platform) ? null : `parent process is not the Orca main process (parent=${cmd.slice(0, 80)})`
}

async function targets(): Promise<Target[] | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1500) })
    return (await res.json()) as Target[]
  } catch {
    return null
  }
}

/** Evaluates `expression` in the main process through the inspector. With `wait`, resolves with the result value;
 *  without it, fires the expression and hangs up (used to close the inspector, which never answers). */
async function evaluateInMain(url: string, expression: string, wait = true): Promise<unknown> {
  const ws = new WebSocket(url)
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('inspector connection failed')) })
  const params = { expression, returnByValue: true, awaitPromise: true }
  if (!wait) {
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params }))
    await sleep(300)
    ws.close()
    return undefined
  }
  try {
    return await new Promise<unknown>((res, rej) => {
      const timer = setTimeout(() => rej(new Error('inspector did not answer')), 10_000)
      ws.onmessage = m => {
        const d = JSON.parse(String(m.data))
        if (d.id !== 1) return
        clearTimeout(timer)
        if (d.error || d.result?.exceptionDetails) rej(new Error(d.result?.exceptionDetails?.exception?.description ?? JSON.stringify(d.error)))
        else res(d.result?.result?.value)
      }
      ws.onclose = () => { clearTimeout(timer); rej(new Error('inspector closed before answering')) }
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params }))
    })
  } finally {
    ws.close()
  }
}

// Runs in the main process. Re-runnable: the second run only swaps the script the listeners use.
const injectExpression = (script: string) => `(() => {
  const { webContents, app } = process.mainModule.require('electron');
  const st = (globalThis.__orcaBashMode ||= { hooked: new WeakSet(), enabled: true });
  st.enabled = true; st.script = ${JSON.stringify(script)};
  const run = wc => (wc.isDestroyed() || wc.getType() !== 'window' || !st.enabled) ? undefined : wc.executeJavaScript(st.script).catch(e => 'error: ' + e);
  const hook = wc => { if (st.hooked.has(wc)) return; st.hooked.add(wc); wc.on('did-finish-load', () => run(wc)); };
  if (!st.listening) { st.listening = true; app.on('web-contents-created', (_e, wc) => hook(wc)); }
  const all = webContents.getAllWebContents().filter(wc => wc.getType() === 'window');
  all.forEach(hook);
  return Promise.all(all.map(run));
})()`

const removeExpression = `(() => {
  const { webContents } = process.mainModule.require('electron');
  const st = globalThis.__orcaBashMode; if (st) st.enabled = false;
  return Promise.all(webContents.getAllWebContents().filter(wc => wc.getType() === 'window')
    .map(wc => wc.executeJavaScript('window.__bashMode && window.__bashMode.destroy && window.__bashMode.destroy(); "removed"').catch(e => 'error: ' + e)));
})()`

let stop: (() => void) | undefined

/** Called by Orca before it stops the worker (disable, uninstall, update). */
export function deactivate(): void { stop?.() }

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  // A stray rejection must never take the worker down: log it and carry on.
  process.on('unhandledRejection', e => orca.log(`unhandled rejection: ${e instanceof Error ? e.message : String(e)}`))
  process.on('uncaughtException', e => orca.log(`uncaught exception: ${e.message}`))

  let busy = false
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let inj: { state: State; detail: string } = { state: 'working', detail: '' }

  /** The status bar item: how injecting went, and whether the Claude plugin that runs `!command` is there. */
  const render = () => {
    const bang = claude.isEnabled()
    let text: string
    let tip: string
    if (inj.state === 'working') { text = 'bash …'; tip = 'Injecting bash mode into the chat page…' }
    else if (inj.state === 'failed') { text = 'bash ✗'; tip = `Bash mode is not active: ${inj.detail}. Click to try again.` }
    else if (inj.state === 'removed') { text = 'bash –'; tip = 'Bash mode is removed from the chat page. Click to inject it again.' }
    else if (bang === false) {
      text = 'bash ⚠'
      tip = 'Bash mode is active, but the Claude plugin that runs `!command` is not installed, so commands will not run. Run "Bash Mode: install the Claude plugin" from the command palette.'
    } else { text = 'bash ✓'; tip = 'Bash mode is active. Toggle it in the chat box with Ctrl+Shift+B. Click to inject again.' }
    void orca.host.call('statusBar.update', { id: STATUS_ID, text, tooltip: tip }).catch(() => undefined)
  }
  const setInj = (state: State, detail = '') => { inj = { state, detail }; render() }
  const tick = setInterval(render, 60_000)   // the Claude plugin can be installed or removed from outside
  tick.unref()
  stop = () => { clearInterval(tick); clearTimeout(timer) }

  // Commands that change things outside Orca ask twice: the first call only says what it would do.
  const asked = new Map<string, number>()
  const confirmed = (key: string): boolean => {
    const t = asked.get(key)
    if (t !== undefined && Date.now() - t < 60_000) { asked.delete(key); return true }
    asked.set(key, Date.now())
    return false
  }

  /** One pass through the five steps above. Returns an error message, or null on success. */
  async function run(expression: (script: string) => string, doneState: State): Promise<string | null> {
    if (process.platform === 'win32') return 'Windows has no SIGUSR1; this plugin supports macOS and Linux only'
    const bad = parentIsOrcaMain()
    if (bad) return bad
    const wasOpen = (await targets()) !== null
    let list = await targets()
    if (list && !list.some(t => /browser_init/.test(t.title ?? ''))) return `port ${PORT} is used by another program, not by the Orca main process`
    if (!list) {
      process.kill(process.ppid, 'SIGUSR1')
      for (let i = 0; i < 20 && !list; i++) { await sleep(250); list = await targets() }
      if (!list) return `the Orca main process did not open the inspector on port ${PORT} (something else may hold it)`
    }
    try {
      const out = (await evaluateInMain(list[0].webSocketDebuggerUrl, expression(pageScript()))) as unknown[]
      if (!Array.isArray(out) || out.length === 0) return 'no Orca window to inject into yet'
      const bad = out.find(v => typeof v === 'string' && v.startsWith('error'))
      if (bad) return String(bad)
      orca.log(`${doneState}: ${JSON.stringify(out)}`)
      return null
    } finally {
      // Close it again, unless somebody else had it open before we came.
      if (!wasOpen) await evaluateInMain(list[0].webSocketDebuggerUrl, 'process._debugEnd(), 1', false).catch(() => undefined)
    }
  }

  async function inject(): Promise<string | null> {
    if (busy) return 'already busy'
    busy = true
    clearTimeout(timer)
    setInj('working')
    let err: string | null
    try { err = await run(injectExpression, 'ok') } catch (e) { err = e instanceof Error ? e.message : String(e) }
    busy = false
    if (!err) { attempt = 0; setInj('ok'); return null }
    orca.log(`inject failed: ${err}`)
    const delay = RETRY_MS[attempt++]
    setInj('failed', `${err}${delay ? ' (retrying)' : ''}`)
    if (delay) { timer = setTimeout(() => void inject(), delay); timer.unref() }
    return err
  }

  async function removeFromPage(): Promise<string | null> {
    clearTimeout(timer); busy = true
    try { const err = await run(() => removeExpression, 'removed'); if (!err) setInj('removed'); return err } finally { busy = false }
  }

  const claudeLine = () => {
    const on = claude.isEnabled()
    return on === true ? 'Claude plugin bang-shell: installed.' : on === false ? 'Claude plugin bang-shell: NOT installed, so `!command` will not run.' : 'Claude plugin bang-shell: could not read ~/.claude/settings.json.'
  }

  orca.commands.register('bash-mode.inject', async () => {
    attempt = 0
    const err = await inject()
    return `${err ? `Bash mode is not active: ${err}.` : 'Bash mode is active.'}\n${claudeLine()}`
  })

  orca.commands.register('bash-mode.remove', async () => {
    const err = await removeFromPage()
    return err ? `Could not remove it: ${err}` : 'Removed from the chat page. Use "inject into the chat page" to bring it back.'
  })

  orca.commands.register('bash-mode.install-claude-plugin', async () => {
    if (claude.isEnabled() === true) return 'The Claude plugin bang-shell is already installed.'
    if (!confirmed('install')) {
      return 'This runs `claude plugin marketplace add WDAFNMS/claude-bang-shell` and `claude plugin install bang-shell@claude-bang-shell`. '
        + 'It changes your Claude Code settings (~/.claude/settings.json), and the plugin runs `!command` lines without a permission prompt. '
        + 'Run this command again within 60 seconds to confirm. Chats that are already open need to be restarted to load it.'
    }
    try {
      const msg = await claude.install()
      await orca.storage.set('installedClaudePlugin', true)
      render()
      return `Installed. ${msg}\nChats that are already open need to be restarted to load it.`
    } catch (e) {
      return `Install failed: ${e instanceof Error ? e.message : String(e)}`
    }
  })

  orca.commands.register('bash-mode.uninstall', async () => {
    const ours = (await orca.storage.get('installedClaudePlugin')) === true
    if (!confirmed('uninstall')) {
      return `This removes bash mode from the chat page${ours ? ', uninstalls the Claude plugin bang-shell that this plugin installed (and its marketplace)' : ' (it leaves the Claude plugin bang-shell alone: this plugin did not install it)'}, and then uninstalls this plugin. Run this command again within 60 seconds to confirm.`
    }
    const report: string[] = []
    const pageErr = await removeFromPage()
    report.push(pageErr ? `Chat page: not cleaned (${pageErr}); restart Orca to drop it.` : 'Chat page: bash mode removed.')
    if (ours) {
      try { await claude.uninstall(); await orca.storage.delete('installedClaudePlugin'); report.push('Claude plugin bang-shell: uninstalled.') }
      catch (e) { report.push(`Claude plugin bang-shell: NOT uninstalled (${e instanceof Error ? e.message : String(e)}).`) }
    }
    // Uninstalling stops this very worker, so hand the last step to a detached process.
    try {
      const orcaBin = process.platform === 'darwin' && process.execPath.includes('.app/') ? `${process.execPath.split('.app/')[0]}.app/Contents/Resources/bin/orca` : 'orca'
      const keys = execFileSync(orcaBin, ['plugin', 'list']).toString().split('\n').map(l => l.match(/^(\S+\.bash-mode)\s/)?.[1]).filter((k): k is string => !!k)
      if (keys.length === 1) {
        spawn('sh', ['-c', 'sleep 2; exec "$0" plugin uninstall "$1"', orcaBin, keys[0]], { detached: true, stdio: 'ignore' }).unref()
        report.push(`This plugin (${keys[0]}): uninstalling in a moment.`)
      } else report.push(`This plugin: run \`orca plugin uninstall <key>\` yourself (found ${keys.length} candidates: ${keys.join(', ') || 'none'}).`)
    } catch (e) { report.push(`This plugin: run \`orca plugin uninstall <key>\` yourself (${e instanceof Error ? e.message : String(e)}).`) }
    return report.join('\n')
  })

  void inject()
}
