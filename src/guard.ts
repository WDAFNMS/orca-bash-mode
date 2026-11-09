// "Is this process command line the Orca main process?" The worker signals its parent only if this says yes.
// The main process runs the app's own executable with nothing but `--flags`; its Node-mode children run
// `-e script` or a script path, and are not it. On macOS the helper binary running a worker lives in the same
// .app bundle as the main executable.
const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function isOrcaMainCommand(cmd: string, execPath: string, platform: string): boolean {
  const mac = platform === 'darwin' && execPath.includes('.app/')
  const main = mac
    ? new RegExp(`^${escape(execPath.split('.app/')[0])}\\.app/Contents/MacOS/[^/ ]+( --\\S+)*$`)
    : new RegExp(`^${escape(execPath)}( --\\S+)*$`)
  return main.test(cmd.trim())
}
