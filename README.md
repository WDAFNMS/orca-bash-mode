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

## How it works

Orca gives plugins no way to touch the chat page. This plugin's worker (a Node process Orca forks) gets there like this:

1. It sends `SIGUSR1` to its parent, the Orca main process. Node then opens its inspector on `127.0.0.1:9229`.
2. It connects, and from the main process runs `webContents.executeJavaScript(...)` with `src/page-script.js`.
3. It leaves a listener in the main process that injects again after each page load, then **closes the inspector**.

So the inspector is open for about a second. No file of Orca is modified, and no start-up flag is needed: after an Orca update restarts the app, the worker starts with it and injects again.

The status bar shows the state: `bash ✓` injected, `bash ✗` failed (it retries a few times; click to try again).
Two commands are in the command palette: *inject into the chat page* and *remove from the chat page*.

## Security: read this

- Orca asks you to approve this plugin because a worker runs **with your user account's full access**. This one does not use any Orca capability; what it does outside Orca's API is:
  - send `SIGUSR1` to the Orca main process, which opens the Node inspector on port 9229;
  - run script in the main process through that inspector.
- While the inspector is open (about a second per start-up), **any program on this machine can connect to it and run code as Orca**. The worker closes it right after injecting. If something else already uses port 9229, the worker does not touch it and reports it in the status bar.
- It checks that its parent is Orca's own main executable before it sends any signal.
- The commands you send with `!` are run by claude-bang-shell **without a permission prompt and outside the sandbox**, exactly like `!` in the terminal. Rules like "never `git commit`" in your `CLAUDE.md` only bind the model, not you.
- Nothing is sent anywhere; the plugin does not use the network except `127.0.0.1:9229`.

## Limits and not verified

- It depends on Orca's page structure (the composer's class names and the Chinese or English button labels `权限`, `模型`, `发送`). An Orca update can break it. The fix is in `src/page-script.js`.
- A newer Orca may give workers a permission sandbox, or stop honouring `SIGUSR1`. Then this approach stops working.
- Not checked: how it behaves after a real Orca self-update and restart, and whether the page script is re-applied after a manual page reload (it is designed to be).

## Uninstall

```
orca plugin uninstall bash-mode
```

Restart Orca to drop the script that is already running in the page (or run *remove from the chat page* first).

## 中文说明

给 Orca 聊天输入框加一个 **bash 模式**，等价于 Claude Code 终端里按 `!`。打开后输入框变粉，不用自己打 `!`，发送时自动补上，发完自动退出。命令由配套的 Claude 插件 [claude-bang-shell](https://github.com/WDAFNMS/claude-bang-shell) 执行。

实现方式：worker 给 Orca 主进程发 `SIGUSR1`，临时打开 9229 调试器，把页面脚本注入后立刻关闭。开启期间本机任何程序都能连上它，所以请先读上面的 Security 一节。

## License

MIT
