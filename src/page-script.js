// 在 Orca 聊天窗口页面里运行的脚本（由 worker 经主进程注入）。必须是一个可求值的表达式，且可重复执行（幂等）。
(() => {
  if (window.__bashMode && window.__bashMode.version >= 6) { window.__bashMode.log('already injected'); return 'already'; }

  if (window.__bashMode && window.__bashMode.destroy) { try { window.__bashMode.destroy(); } catch (e) {} }   // 先卸载旧版本

  // ---- 清理早期版本残留 ----
  document.getElementById('__bm-pill')?.remove();
  document.querySelectorAll('style').forEach(s => { if (s.textContent.includes('data-bm-box')) s.remove(); });
  document.querySelectorAll('[data-bm-box]').forEach(e => e.removeAttribute('data-bm-box'));

  // ---- 可调参数 ----
  const COLOR = '#fd5db1';                       // 终端版 bash 模式的粉色
  const HOTKEY = e => e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyB';   // Ctrl+Shift+B 切换
  const EDITOR_SEL = '.ProseMirror[contenteditable="true"]';
  const BOX_SEL = '[class*="group/composer"]';
  const LOG = [];
  const log = (...a) => { LOG.push(new Date().toTimeString().slice(0, 8) + ' ' + a.map(String).join(' ')); if (LOG.length > 300) LOG.shift(); };

  const on = new WeakSet();                      // 处于 bash 模式的编辑器元素
  let redispatching = false;

  // ---- 样式 ----
  const style = document.createElement('style');
  style.id = '__bm2-style';
  style.textContent = `
    [data-bm2="1"] { border-color: ${COLOR} !important; box-shadow: 0 0 0 2px ${COLOR}55 !important; }
    [data-bm2="1"] .ProseMirror { caret-color: ${COLOR}; }
    #__bm2-pill { position: fixed; z-index: 2147483000; display: none; box-sizing: border-box; height: 24px; padding: 0 8px;
      font-family: var(--bm-family, inherit); font-size: var(--bm-size, 13px); font-weight: var(--bm-weight, 500); line-height: 22px; letter-spacing: var(--bm-ls, normal);
      border-radius: 6px; border: 1px solid transparent; color: var(--bm-fg, #9aa0aa); background: transparent;
      cursor: pointer; user-select: none; transition: background-color .12s, color .12s, border-color .12s; }
    #__bm2-pill:hover { background: color-mix(in srgb, currentColor 12%, transparent); }
    #__bm2-pill[data-on="1"] { color: ${COLOR}; background: color-mix(in srgb, ${COLOR} 16%, transparent); border-color: color-mix(in srgb, ${COLOR} 50%, transparent); }
  `;
  document.documentElement.appendChild(style);

  const pill = document.createElement('div');
  pill.id = '__bm2-pill'; pill.title = 'bash 模式 (Ctrl+Shift+B)'; pill.textContent = 'bash';
  document.documentElement.appendChild(pill);

  // ---- 找编辑器 / 外框 ----
  const editors = () => [...document.querySelectorAll(EDITOR_SEL)].filter(e => e.getBoundingClientRect().height > 0);
  const activeEditor = () => {
    const a = document.activeElement;
    const f = a && a.closest && a.closest(EDITOR_SEL);
    if (f) return f;
    const all = editors();
    return all[all.length - 1] || null;
  };
  const boxOf = ed => ed.closest(BOX_SEL) || ed.parentElement;
  const setMode = (ed, v) => {
    const box = boxOf(ed);
    if (v) { on.add(ed); box.setAttribute('data-bm2', '1'); } else { on.delete(ed); box.removeAttribute('data-bm2'); }
    log('mode', v ? 'ON' : 'OFF');
    place();
  };
  const toggle = ed => ed && setMode(ed, !on.has(ed));

  // ---- 按钮位置跟随当前编辑器 ----
  function place() {
    const ed = activeEditor();
    if (!ed) { pill.style.display = 'none'; return; }
    const box = boxOf(ed), br = box.getBoundingClientRect();
    // 锚点：工具栏里的“权限/完全访问”按钮；找不到就退回到第二个按钮，再不行就放在输入框右上角
    const btns = [...box.querySelectorAll('button')];
    const anchor = btns.find(b => /^(权限|permission)/i.test((b.getAttribute('aria-label') || '').trim())) || btns[1];
    pill.style.display = 'block';
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      pill.style.left = Math.round(r.right + 8) + 'px';
      pill.style.top = Math.round(r.top + (r.height - 24) / 2) + 'px';
    } else {
      pill.style.left = Math.max(4, br.right - 58) + 'px';
      pill.style.top = Math.max(4, br.top - 28) + 'px';
    }
    // 配色和字体：照搬工具栏里“模型”按钮（文字色是中性的），主题变化时跟着变
    const ref = btns.find(b => /^(模型|model)/i.test((b.getAttribute('aria-label') || '').trim())) || anchor;
    if (ref) {
      const cs = getComputedStyle(ref);
      pill.style.setProperty('--bm-fg', cs.color);
      pill.style.setProperty('--bm-family', cs.fontFamily);
      pill.style.setProperty('--bm-size', cs.fontSize);
      pill.style.setProperty('--bm-weight', cs.fontWeight);
      pill.style.setProperty('--bm-ls', cs.letterSpacing);
    }
    pill.dataset.on = on.has(ed) ? '1' : '0';
  }
  const timer = setInterval(place, 250);
  pill.addEventListener('mousedown', e => e.preventDefault());            // 不抢走输入框焦点
  pill.addEventListener('click', () => toggle(activeEditor()));

  // ---- 补 "!" ----
  const text = ed => (ed.editor && ed.editor.getText ? ed.editor.getText() : (ed.innerText || '')).replace(/\u200b/g, '');
  const needsBang = ed => { const t = text(ed).trim(); return t.length > 0 && !/^[!！]/.test(t); };
  function insertBang(ed) {
    const tt = ed.editor;
    if (tt && tt.commands && tt.commands.insertContentAt) { tt.commands.insertContentAt(1, '!'); return 'tiptap'; }
    const sel = getSelection(), keep = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const r = document.createRange(); r.setStart(ed, 0); r.collapse(true); sel.removeAllRanges(); sel.addRange(r);
    document.execCommand('insertText', false, '!');
    if (keep) { sel.removeAllRanges(); sel.addRange(keep); }
    return 'execCommand';
  }
  // 斜杠 / @ 补全弹窗：新插入的 fixed listbox，里面是 option 按钮（侧栏那个常驻 listbox 不算）
  const popupOpen = () => !!document.querySelector('[role="listbox"].fixed button[role="option"]');

  const sendButton = ed => [...boxOf(ed).querySelectorAll('button')].find(b => /^(发送|send)$/i.test((b.getAttribute('aria-label') || b.title || b.textContent || '').trim()));

  // ---- 拦截发送：先补 "!"，稍等 React 状态同步，再把原事件补发一次 ----
  function guardedSend(ed, replay, via) {
    if (redispatching) return false;
    if (!on.has(ed)) return false;
    if (popupOpen()) { log(via, 'skip: autocomplete popup open'); return false; }
    if (!needsBang(ed)) {
      log(via, 'skip: empty or already prefixed; draft=' + JSON.stringify(text(ed).slice(0, 40)));
      if (text(ed).trim()) setTimeout(() => setMode(ed, false), 60);          // 已自带 !，照常发送，发完退出 bash 模式
      return false;
    }
    const how = insertBang(ed);
    log(via, 'prefixed via', how, '-> draft=' + JSON.stringify(text(ed).slice(0, 40)));
    setTimeout(() => { redispatching = true; try { replay(); } finally { redispatching = false; } log(via, 'replayed'); setTimeout(() => setMode(ed, false), 60); }, 40);   // 发送后自动回到普通模式
    return true;
  }

  const onKey = e => {
    if (HOTKEY(e)) { e.preventDefault(); e.stopPropagation(); toggle(activeEditor()); return; }
    const ed = e.target && e.target.closest && e.target.closest(EDITOR_SEL);
    if (!ed || !on.has(ed)) return;
    if (e.isComposing || e.keyCode === 229) return;                         // 输入法组合中，别碰
    if (e.key === 'Backspace' && text(ed).trim() === '') { setMode(ed, false); return; }   // 空输入框退格退出，同终端版
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      const replay = () => {
        const btn = sendButton(ed);
        if (btn && !btn.disabled) { log('enter: clicking send button'); btn.click(); return; }
        log('enter: no send button, replaying Enter');
        ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      };
      if (guardedSend(ed, replay, 'enter')) { e.preventDefault(); e.stopImmediatePropagation(); }
    }
  };
  const onClick = e => {
    const btn = e.target && e.target.closest && e.target.closest('button');
    if (!btn || redispatching) return;
    const ed = editors().find(x => on.has(x) && boxOf(x).contains(btn));
    if (!ed) return;
    const label = (btn.getAttribute('aria-label') || btn.title || btn.textContent || '').trim();
    if (!/^(发送|send)$/i.test(label)) return;                              // 实测发送按钮的标签就是“发送”
    if (guardedSend(ed, () => btn.click(), 'click')) { e.preventDefault(); e.stopImmediatePropagation(); }
  };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('click', onClick, true);

  const destroy = () => {
    clearInterval(timer); document.removeEventListener('keydown', onKey, true); document.removeEventListener('click', onClick, true);
    pill.remove(); style.remove(); document.querySelectorAll('[data-bm2]').forEach(e => e.removeAttribute('data-bm2')); delete window.__bashMode;
  };
  window.__bashMode = { version: 6, log, dump: () => LOG.slice(), toggle: () => toggle(activeEditor()), destroy,
    _test: ed => ({ needs: needsBang(ed), popup: popupOpen(), box: boxOf(ed).className.slice(0, 30) }) };
  log('injected v6');
  return 'injected v6';
})()
