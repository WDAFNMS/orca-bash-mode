# Bash Mode for Orca

A **bash mode** for Orca's structured chat box, like pressing `!` in the Claude Code terminal UI.

Turn it on, type `pwd`, press Enter. The chat sends `!pwd`, and the command runs in the session's working directory. Claude sees the output and can answer it.

- A small `bash` button sits in the composer toolbar, next to the permission button. `Ctrl+Shift+B` toggles it as well.
- While it is on, the box is tinted pink (like the terminal UI) and you do **not** type the `!`: it is added when you send.
- After a send it switches itself off. Backspace in an empty box leaves the mode too.

> This plugin only draws the mode. **Running the command** is done by the Claude Code plugin
> [claude-bang-shell](https://github.com/WDAFNMS/claude-bang-shell), which understands `!command` sent as plain text.
> Install both.

## Install

```
orca plugin install WDAFNMS/orca-bash-mode
```

Orca lists what the plugin is granted and asks for an approval (see **Security** below).

Needs Orca 1.4.248 or later, on macOS or Linux (Windows has no `SIGUSR1`, so it is not supported).

The command that runs `!command` is the Claude Code plugin [claude-bang-shell](https://github.com/WDAFNMS/claude-bang-shell).
If you do not have it yet, the status bar says so (`bash ⚠`), and the command palette has
**Bash Mode: install the Claude plugin (bang-shell)**, which runs for you:

```
claude plugin marketplace add WDAFNMS/claude-bang-shell
claude plugin install bang-shell@claude-bang-shell
```

You can run those two lines yourself instead. Chats that are already open must be restarted to load the Claude plugin.

## How it works

Orca gives plugins no way to touch the chat page. This plugin's worker (a Node process Orca forks) gets there like this:

1. It sends `SIGUSR1` to its parent, the Orca main process. Node then opens its inspector on `127.0.0.1:9229`.
2. It connects, and from the main process runs `webContents.executeJavaScript(...)` with `src/page-script.js`.
3. It leaves a listener in the main process that injects again after each page load, then **closes the inspector**.

So the inspector is open for about a second. No file of Orca is modified, and no start-up flag is needed: after an Orca update restarts the app, the worker starts with it and injects again.

The status bar shows the state:

| Status bar | Meaning |
|---|---|
| `bash ✓` | injected, and the Claude plugin bang-shell is installed |
| `bash ⚠` | injected, but bang-shell is **not** installed, so `!command` would not run |
| `bash ✗` | injection failed (it retries a few times; click to try again; the tooltip says why) |
| `bash –` | removed from the chat page |

Commands in the command palette:

| Command | What it does |
|---|---|
| Bash Mode: inject into the chat page | inject again, and report the state of both parts |
| Bash Mode: remove from the chat page | take the button and the listeners away until you inject again |
| Bash Mode: install the Claude plugin (bang-shell) | the two `claude plugin ...` lines above |
| Bash Mode: uninstall everything | see **Uninstall** |

The two commands that change things outside Orca ask twice: the first run only says what it would do, and nothing
happens unless you run it again within 60 seconds.

## Security: read this

- Orca asks you to approve this plugin because a worker runs **with your user account's full access**. This one does not use any Orca capability; what it does outside Orca's API is:
  - send `SIGUSR1` to the Orca main process, which opens the Node inspector on port 9229;
  - run script in the main process through that inspector.
- While the inspector is open (about a second per start-up), **any program on this machine can connect to it and run code as Orca**. The worker closes it right after injecting. If something else already uses port 9229, the worker does not touch it and reports it in the status bar.
- It checks that its parent is Orca's own main executable before it sends any signal.
- The commands you send with `!` are run by claude-bang-shell **without a permission prompt and outside the sandbox**, exactly like `!` in the terminal. Rules like "never `git commit`" in your `CLAUDE.md` only bind the model, not you.
- **Install the Claude plugin** runs the `claude` command (found in `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` or `PATH`)
  and changes your Claude Code settings (`~/.claude/settings.json`, or `CLAUDE_CONFIG_DIR`). The downloaded plugin comes from
  `github.com/WDAFNMS/claude-bang-shell`; `claude` itself fetches it, this plugin does not.
- This plugin keeps one value in its own storage: whether **it** installed the Claude plugin. Uninstall removes the
  Claude plugin only if that is true.
- Nothing is sent anywhere by this plugin; it does not use the network except `127.0.0.1:9229`.

## Limits and not verified

- It depends on Orca's page structure (the composer's class names and the Chinese or English button labels `权限`, `模型`, `发送`). An Orca update can break it. The fix is in `src/page-script.js`.
- A newer Orca may give workers a permission sandbox, or stop honouring `SIGUSR1`. Then this approach stops working.
- Not checked: how it behaves after a real Orca self-update (a plain restart was checked), whether the page script is re-applied after a manual page reload (it is designed to be), the `bash ⚠` state in a live Orca, and the last step of **uninstall everything** (the plugin removing itself).
- The Claude plugin is found through `~/.claude/settings.json` only; a bang-shell enabled in a project's settings is not seen.

## Uninstall

Run **Bash Mode: uninstall everything** from the command palette (run it twice within 60 seconds). It:

1. removes the button and listeners from the chat page, so you do not even have to restart Orca;
2. uninstalls the Claude plugin bang-shell and its marketplace, **only if this plugin installed them**
   (if you installed bang-shell yourself, it is left alone);
3. uninstalls this plugin, a moment later, through `orca plugin uninstall`.

Or by hand:

```
orca plugin uninstall <key>        # `orca plugin list` shows it, e.g. wdafnms.bash-mode
claude plugin uninstall bang-shell@claude-bang-shell
claude plugin marketplace remove claude-bang-shell
```

Without step 1, the script already running in the page stays until Orca is restarted.

## 中文说明

给 Orca 聊天输入框加一个 **bash 模式**，等价于 Claude Code 终端里按 `!`。打开后输入框变粉，不用自己打 `!`，发送时自动补上，发完自动退出。命令由配套的 Claude 插件 [claude-bang-shell](https://github.com/WDAFNMS/claude-bang-shell) 执行。

实现方式：worker 给 Orca 主进程发 `SIGUSR1`，临时打开 9229 调试器，把页面脚本注入后立刻关闭。开启期间本机任何程序都能连上它，所以请先读上面的 Security 一节。

状态栏会提示配套的 Claude 插件有没有装（`bash ⚠` 表示没装，`!命令` 不会执行）；命令面板里有"安装 Claude 插件"和"卸载全部"，两者都要在 60 秒内连续运行两次才会真正执行。卸载只会移除由本插件装上的 Claude 插件。

## License

MIT
