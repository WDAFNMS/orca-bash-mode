// The Claude Code side of the pair: the `bang-shell` plugin that actually runs `!command`.
// Everything here takes an optional config dir / binary so it can be tested against a throwaway CLAUDE_CONFIG_DIR.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

export const MARKETPLACE_SOURCE = 'WDAFNMS/claude-bang-shell'
export const MARKETPLACE = 'claude-bang-shell'
export const PLUGIN = 'bang-shell'

export type Opts = { configDir?: string; bin?: string }

export const configDirOf = (o: Opts = {}) => o.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')

/** True/false when `settings.json` says bang-shell is enabled or not; null when it cannot be read. */
export function isEnabled(o: Opts = {}): boolean | null {
  try {
    const settings = JSON.parse(readFileSync(join(configDirOf(o), 'settings.json'), 'utf8')) as { enabledPlugins?: Record<string, unknown> }
    return Object.entries(settings.enabledPlugins ?? {}).some(([key, on]) => key.startsWith(`${PLUGIN}@`) && on !== false)
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? false : null
  }
}

/** The `claude` executable: an explicit one, else the usual install places, else PATH. */
export function findClaude(o: Opts = {}): string | null {
  const home = homedir()
  const candidates = [o.bin, join(home, '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude',
    ...(process.env.PATH ?? '').split(delimiter).map(d => join(d, 'claude'))]
  return candidates.find(c => c && existsSync(c)) ?? null
}

type Ran = { code: number; out: string }

function run(bin: string, args: string[], o: Opts): Promise<Ran> {
  const env = { ...process.env, ...(o.configDir ? { CLAUDE_CONFIG_DIR: o.configDir } : {}) }
  return new Promise(resolve => {
    execFile(bin, args, { env, timeout: 120_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0
      resolve({ code, out: `${stdout}${stderr}`.trim() })
    })
  })
}

/** Adds the marketplace and installs bang-shell. Resolves with a short report; rejects with the reason. */
export async function install(o: Opts = {}): Promise<string> {
  const bin = findClaude(o)
  if (!bin) throw new Error('the `claude` command was not found (looked in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin and PATH)')
  const add = await run(bin, ['plugin', 'marketplace', 'add', MARKETPLACE_SOURCE], o)
  if (add.code !== 0 && !/already/i.test(add.out)) throw new Error(`claude plugin marketplace add failed: ${add.out.slice(0, 300)}`)
  const inst = await run(bin, ['plugin', 'install', `${PLUGIN}@${MARKETPLACE}`], o)
  if (inst.code !== 0) throw new Error(`claude plugin install failed: ${inst.out.slice(0, 300)}`)
  return inst.out.split('\n').slice(-2).join(' ').slice(0, 200) || 'installed'
}

/** Uninstalls bang-shell and removes the marketplace this plugin added. */
export async function uninstall(o: Opts = {}): Promise<string> {
  const bin = findClaude(o)
  if (!bin) throw new Error('the `claude` command was not found')
  const un = await run(bin, ['plugin', 'uninstall', `${PLUGIN}@${MARKETPLACE}`], o)
  if (un.code !== 0 && !/not (installed|found)/i.test(un.out)) throw new Error(`claude plugin uninstall failed: ${un.out.slice(0, 300)}`)
  const rm = await run(bin, ['plugin', 'marketplace', 'remove', MARKETPLACE], o)
  if (rm.code !== 0 && !/not (installed|found|configured)/i.test(rm.out)) throw new Error(`claude plugin marketplace remove failed: ${rm.out.slice(0, 300)}`)
  return 'uninstalled'
}
