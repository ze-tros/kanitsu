const list = await fetch('http://127.0.0.1:9222/json/list').then(r => r.json());
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params={}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({id:i, method, params})); });
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
ws.onopen = async () => {
  const open = await evalJs(`(() => { const b = document.querySelector('.m-search-launch'); if (!b) return 'no-launcher'; b.click(); return 'clicked'; })()`);
  await new Promise(r => setTimeout(r, 600));
  const probe = await evalJs(`(() => {
    const el = document.querySelector('.m-search-field input');
    if (!el) return JSON.stringify({err:'no search input', open});
    const cs = getComputedStyle(el);
    const field = getComputedStyle(el.closest('.m-search-field'));
    return JSON.stringify({
      open, inputCls: el.className || '(no class)',
      inputBorder: cs.borderWidth + ' ' + cs.borderColor,
      inputBg: cs.backgroundColor,
      inputBoxShadow: cs.boxShadow,
      fieldBorder: field.borderWidth + ' ' + field.borderColor,
      fieldBg: field.backgroundColor,
      fieldRadius: field.borderRadius,
      focused: document.activeElement === el
    });
  })()`);
  console.log('PROBE:', probe);
  await evalJs(`document.querySelector('.m-icon-button[aria-label="关闭搜索"]')?.click()`);
  process.exit(0);
};
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 10000);
