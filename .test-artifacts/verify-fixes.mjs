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
  // ---- Fix 1a: sort picker ----
  const pick = await evalJs(`(() => {
    const toolbar = document.querySelector('.m-directory-toolbar');
    const btn = document.querySelector('.m-directory-toolbar .m-sort-picker');
    return JSON.stringify({
      selectCount: toolbar ? toolbar.querySelectorAll('select').length : -1,
      tag: btn?.tagName, label: btn?.textContent?.trim()
    });
  })()`);
  const p1 = JSON.parse(pick);
  check('1a toolbar has no <select>', p1.selectCount === 0, `selectCount=${p1.selectCount}`);
  check('1a trigger is button', p1.tag === 'BUTTON', `tag=${p1.tag}`);
  p1.label && check('1a trigger label', p1.label.includes('默认顺序'), p1.label);

  await evalJs(`document.querySelector('.m-directory-toolbar .m-sort-picker').click()`);
  await sleep(350);
  const sheet = JSON.parse(await evalJs(`(() => {
    const panel = document.querySelector('.m-sheet-panel');
    if (!panel) return JSON.stringify({panel:false});
    const rows = [...panel.querySelectorAll('.m-sheet-action')];
    const checked = panel.querySelector('.m-sheet-action-check')?.closest('button')?.textContent?.trim();
    return JSON.stringify({panel:true, title: panel.querySelector('.m-sheet-header strong')?.textContent,
      labels: rows.map(r => r.textContent.trim()), checked,
      checkStyle: getComputedStyle(panel.querySelector('.m-sheet-action-check')).color});
  })()`));
  check('1a sheet opens with title', sheet.panel && sheet.title === '排序方式', `title=${sheet.title}`);
  check('1a four options', Array.isArray(sheet.labels) && sheet.labels.join(',') === '默认顺序,按名称,按日期,按大小', sheet.labels?.join(','));
  check('1a checked marker on 默认顺序', sheet.checked === '默认顺序', `checked=${sheet.checked}`);
  check('1a check mark uses accent', typeof sheet.checkStyle === 'string' && sheet.checkStyle.length > 0, sheet.checkStyle);

  await evalJs(`[...document.querySelectorAll('.m-sheet-action')].find(b => b.textContent.includes('按名称'))?.click()`);
  await sleep(400);
  const after = await evalJs(`(() => {
    const btn = document.querySelector('.m-directory-toolbar .m-sort-picker');
    return JSON.stringify({ label: btn?.textContent?.trim(), sheetGone: !document.querySelector('.m-sheet-panel'),
      dirBtn: document.querySelector('.m-sort-direction')?.textContent?.trim(),
      dirDisabled: document.querySelector('.m-sort-direction')?.disabled });
  })()`);
  const a1 = JSON.parse(after);
  check('1a selecting updates trigger', a1.label === '📐按名称' || a1.label?.includes('按名称'), a1.label);
  check('1a direction enabled after 按名称', a1.dirDisabled === false && a1.dirBtn?.includes('升序'), `${a1.dirBtn}/${a1.dirDisabled}`);

  // restore 默认顺序
  await evalJs(`document.querySelector('.m-directory-toolbar .m-sort-picker').click()`);
  await sleep(350);
  await evalJs(`[...document.querySelectorAll('.m-sheet-action')].find(b => b.textContent.includes('默认顺序'))?.click()`);
  await sleep(400);

  // ---- Fix 2: search field focus ----
  await evalJs(`document.querySelector('.m-search-launch')?.click()`);
  await sleep(350);
  const s = JSON.parse(await evalJs(`(() => {
    const inp = document.querySelector('.m-search-field input');
    if (!inp) return JSON.stringify({err:'no input'});
    const cs = getComputedStyle(inp);
    const f = getComputedStyle(inp.closest('.m-search-field'));
    return JSON.stringify({ boxShadow: cs.boxShadow, inputBg: cs.backgroundColor,
      fieldBorder: f.borderColor, fieldRadius: f.borderRadius,
      restBg: 'color-mix-3.5%', focused: document.activeElement === inp });
  })()`));
  if (s.err) { check('2 search input exists', false, s.err); }
  else {
    check('2 no inner halo on focused input', s.boxShadow === 'none', `boxShadow=${s.boxShadow}`);
    check('2 focused', s.focused === true);
    check('2 field radius = 9px token', s.fieldRadius === '9px', s.fieldRadius);
    const accentBorder = /196,\s*84,\s*68|255,\s*120,\s*94/.test(s.fieldBorder);
    check('2 field border is accent-line', accentBorder, s.fieldBorder);
  }
  await evalJs(`document.querySelector('.m-icon-button[aria-label="关闭搜索"]')?.click()`);
  await sleep(300);

  // ---- Fix 4: gesture bar ----
  const gb = await evalJs(`String(document.querySelector('.m-gesture-bar'))`);
  check('4 gesture bar removed', gb === 'null', gb);

  // ---- Fix 3 wiring: bridge method ----
  const bridge = await evalJs(`String(typeof window.kanitsuAndroid?.setSystemTheme)`);
  check('3 bridge setSystemTheme exposed', bridge === 'function', bridge);

  // ---- Fix 1b + theme navigation: go to settings ----
  await evalJs(`[...document.querySelectorAll('.m-dock-button')].find(b => b.textContent.includes('工具'))?.click()`);
  await sleep(500);
  await evalJs(`[...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '设置')[0]?.click()`);
  await sleep(600);
  const st = JSON.parse(await evalJs(`(() => {
    const seg = [...document.querySelectorAll('.m-theme-segment')].find(s => s.getAttribute('aria-label') === '日志等级');
    return JSON.stringify({
      selectCount: document.querySelectorAll('select').length,
      segExists: !!seg,
      segLabels: seg ? [...seg.querySelectorAll('button')].map(b => b.textContent.trim()) : [],
      segActive: seg ? seg.querySelector('button.is-active')?.textContent?.trim() : null,
      themeSegActive: [...document.querySelectorAll('.m-theme-segment')].find(s => s.getAttribute('aria-label') === '界面主题')?.querySelector('button.is-active')?.textContent?.trim()
    });
  })()`));
  check('1b no <select> anywhere', st.selectCount === 0, `selectCount=${st.selectCount}`);
  check('1b log-level segment exists', st.segExists === true);
  check('1b segment options', st.segLabels?.join(',') === '调试,信息,警告,仅错误', st.segLabels?.join(','));
  check('1b current level active', st.segActive === '信息', st.segActive);

  // ---- Fix 3: switch to dark via real UI, leave dark for native check ----
  await evalJs(`[...document.querySelectorAll('.m-theme-segment')].find(s => s.getAttribute('aria-label') === '界面主题')?.querySelectorAll('button')?.[2]?.click()`);
  await sleep(400);
  const theme = await evalJs(`document.documentElement.getAttribute('data-theme')`);
  check('3 in-app dark applied', theme === 'dark', `data-theme=${theme}`);

  console.log(results.join('\n'));
  process.exit(0);
};
setTimeout(() => { console.log(results.join('\n')); console.log('TIMEOUT'); process.exit(1); }, 15000);
