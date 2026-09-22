const list = await fetch('http://127.0.0.1:9222/json/list').then(r => r.json());
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params={}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({id:i, method, params})); });
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
ws.onopen = async () => {
  await evalJs(`[...document.querySelectorAll('.m-theme-segment')].find(s => s.getAttribute('aria-label') === '界面主题')?.querySelectorAll('button')?.[0]?.click()`);
  await sleep(400);
  const theme = await evalJs(`document.documentElement.getAttribute('data-theme')`);
  // 返回图库根页
  await evalJs(`document.querySelector('.m-settings-screen .m-icon-button[aria-label*="返回"], .m-settings-screen button[aria-label*="返回"]')?.click()`);
  await sleep(400);
  await evalJs(`[...document.querySelectorAll('.m-icon-button')].find(b => (b.getAttribute('aria-label') || '').includes('返回图库'))?.click()`);
  await sleep(400);
  console.log('restored data-theme:', theme);
  process.exit(0);
};
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 10000);
