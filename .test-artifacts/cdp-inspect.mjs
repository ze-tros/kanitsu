const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/0169C4ED5EF2DA5BC54E3982D39BD0C4');
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params={}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({id:i, method, params})); });
ws.onopen = async () => {
  const expr = `(() => {
    const inputs = [...document.querySelectorAll('input')].filter(el => el.offsetParent !== null && el.type === 'text');
    const el = inputs[0];
    if (!el) return JSON.stringify({err:'no visible text input', total: document.querySelectorAll('input').length});
    el.focus();
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return JSON.stringify({
      count: inputs.length, cls: el.className,
      border: cs.borderWidth + ' ' + cs.borderColor,
      background: cs.backgroundColor,
      outline: cs.outlineWidth + ' ' + cs.outlineStyle + ' ' + cs.outlineColor,
      boxShadow: cs.boxShadow, appearance: cs.appearance,
      focused: document.activeElement === el,
      rect: Math.round(rect.x) + ',' + Math.round(rect.y) + ' ' + Math.round(rect.width) + 'x' + Math.round(rect.height)
    });
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log('RESULT:', r.result?.result?.value ?? JSON.stringify(r.result));
  process.exit(0);
};
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 8000);
