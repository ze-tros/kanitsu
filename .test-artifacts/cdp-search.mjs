const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/0169C4ED5EF2DA5BC54E3982D39BD0C4');
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params={}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({id:i, method, params})); });
ws.onopen = async () => {
  const expr = `(() => {
    const el = document.querySelector('.m-search-field input');
    if (!el) return JSON.stringify({err:'search input not in DOM', url: location.href, firstInput: document.querySelector('input')?.className || null});
    const cs = getComputedStyle(el);
    const field = getComputedStyle(el.closest('.m-search-field'));
    return JSON.stringify({
      cls: el.className || '(none)',
      border: cs.borderWidth + ' ' + cs.borderColor,
      background: cs.backgroundColor,
      outline: cs.outlineWidth + ' ' + cs.outlineStyle,
      boxShadow: cs.boxShadow,
      fieldBorder: field.borderWidth + ' ' + field.borderColor,
      fieldBg: field.backgroundColor,
      focused: document.activeElement === el
    });
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log('RESULT:', r.result?.result?.value ?? JSON.stringify(r.result));
  process.exit(0);
};
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 8000);
