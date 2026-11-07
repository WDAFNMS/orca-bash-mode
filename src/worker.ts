// Bash Mode for Orca: puts a "bash" mode into the structured chat composer.
//
// Orca gives plugins no way to touch the chat page, so this worker reaches it the only way left:
//   1. SIGUSR1 to its parent (the Orca main process) makes Node open the inspector on 127.0.0.1:9229;
//   2. it connects, and from the main process runs `webContents.executeJavaScript(page-script.js)`;
//   3. it asks the main process to re-inject after every page load, then closes the inspector again.
// The inspector is open for about a second. Nothing on disk is modified and no start-up flag is needed.
import type { OrcaWorkerApi } from 'orca/worker'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PORT = 9229
const STATUS_ID = 'status'
const RETRY_MS = [4_000, 12_000, 30_000, 60_000]
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

type Target = { title?: string; webSocketDebuggerUrl: string }
type State = 'working' | 'ok' | 'failed' | 'removed'

const pageScript = () => readFileSync(fileURLToPath(new URL('./page-script.js', import.meta.url)), 'utf8')

// The worker is forked by the main process, so its parent must be that app's own main executable (on macOS the
// helper binary running this worker lives in the same .app bundle; the Node-mode children of the main process
// run with `-e` and are not it). If not (another packaging, a wrapper), do not signal anything.
function parentIsOrcaMain(): string | null {
  const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(process.ppid)]).toString().trim()
  const bundle = process.execPath.split('.app/')[0]
  const isMain = process.platform === 'darwin' && process.execPath.includes('.app/')
    ? cmd.startsWith(`${bundle}.app/Contents/MacOS/`) && !cmd.includes(' -e ')
    : cmd === process.execPath
  return isMain ? null : `parent process is not the Orca main process (parent=${cmd.slice(0, 80)})`
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

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  // A stray rejection must never take the worker down: log it and carry on.
  process.on('unhandledRejection', e => orca.log(`unhandled rejection: ${e instanceof Error ? e.message : String(e)}`))
  process.on('uncaughtException', e => orca.log(`uncaught exception: ${e.message}`))
  let busy = false
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const show = (state: State, tooltip: string) => {
    const text = { working: 'bash …', ok: 'bash ✓', failed: 'bash ✗', removed: 'bash –' }[state]
    void orca.host.call('statusBar.update', { id: STATUS_ID, text, tooltip }).catch(() => undefined)
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

  async function inject(): Promise<void> {
    if (busy) return
    busy = true
    clearTimeout(timer)
    show('working', 'Injecting bash mode into the chat page…')
    let err: string | null
    try { err = await run(injectExpression, 'ok') } catch (e) { err = e instanceof Error ? e.message : String(e) }
    busy = false
    if (!err) { attempt = 0; show('ok', 'Bash mode is active. Click to inject again. Toggle it in the chat box with Ctrl+Shift+B.'); return }
    orca.log(`inject failed: ${err}`)
    const delay = RETRY_MS[attempt++]
    show('failed', `Bash mode is not active: ${err}${delay ? ' (retrying)' : ''}. Click to try again.`)
    if (delay) timer = setTimeout(() => void inject(), delay)
  }

  orca.commands.register('bash-mode.inject', async () => { attempt = 0; await inject(); return 'done' })
  orca.commands.register('bash-mode.remove', async () => {
    clearTimeout(timer); busy = true
    try { const err = await run(() => removeExpression, 'removed'); show('removed', 'Bash mode is removed from the chat page until you inject it again.'); return err ?? 'removed' }
    finally { busy = false }
  })

  void inject()
}
