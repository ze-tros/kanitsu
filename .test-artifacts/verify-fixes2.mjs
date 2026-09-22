const list = await fetch('http://127.0.0.1:9222/json/list').then(r => r.json());
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params={}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({id:i, method, params})); });
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail='') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`); };

ws.onopen = async () => {
  // where are we?
  const where = await evalJs(`JSON.stringify({
    settings: !!document.querySelector('.m-settings-screen'),
    tools: [...document.querySelectorAll('button')].some(b => b.textContent.includes('导入图包')),
    dockTools: [...document.querySelectorAll('.m-dock-button')].some(b => b.textContent.includes('工具'))
  })`);
  const w = JSON.parse(where);
  if (!w.settings) {
    if (w.tools) {
      await evalJs(`[...document.querySelectorAll('button')].filter(b => b.textContent.includes('设置'))[0]?.click()`);
      await sleep(600);
    } else if (w.dockTools) {
      await evalJs(`[...document.querySelectorAll('.m-dock-button')].find(b => b.textContent.includes('工具'))?.click()`);
      await sleep(500);
      await evalJs(`[...document.querySelectorAll('button')].filter(b => b.textContent.includes('设置'))[0]?.click()`);
      await sleep(600);
    }
  }
  check('nav: settings screen open', await evalJs(`String(!!document.querySelector('.m-settings-screen'))`) === 'true');

  const st = JSON.parse(await evalJs(`(() => {
    const seg = [...document.querySelectorAll('.m-theme-segment')].find(s => s.getAttribute('aria-label') === '日志等级');
    return JSON.stringify({
      selectCount: document.querySelectorAll('select').length,
      segExists: !!seg,
      segLabels: seg ? [...seg.querySelectorAll('button')].map(b => b.textContent.trim()) : [],
      segActive: seg ? seg.querySelector('button.is-active')?.textContent?.trim() : null
    });
  })()`));
  check('1b no <select> anywhere', st.selectCount === 0, `selectCount=${st.selectCount}`);
  check('1b log-level segment exists', st.segExists === true);
  check('1b segment options', st.segLabels?.join(',') === '调试,信息,警告,仅错误', st.segLabels?.join(','));
  check('1b current level active', st.segActive === '信息', st.segActive);

  // Fix 3: switch to dark through the real segmented control
  await evalJs(`[...document.querySelectorAll('.m-theme-segment')].find(s => s.getAttribute('aria-label') === '界面主题')?.querySelectorAll('button')?.[2]?.click()`);
  await sleep(400);
  const theme = await evalJs(`document.documentElement.getAttribute('data-theme')`);
  check('3 in-app dark applied', theme === 'dark', `data-theme=${theme}`);
  console.log(results.join('\n'));
  process.exit(0);
};
setTimeout(() => { console.log(results.join('\n')); console.log('TIMEOUT'); process.exit(1); }, 15000);
