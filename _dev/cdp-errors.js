/*
 * 抓页面的控制台错误。
 * 用法: node cdp-errors.js <url>
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2];
const port = 9700 + Math.floor(Math.random() * 200);
const profile = path.join(process.env.TEMP, 'edge-err-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, timeout: 3000 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

(async () => {
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-features=msEdgeSyncPromo,msSyncPromo',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, url
  ], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      targets = await getJson('/json/list');
      if (targets && targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl)) break;
    } catch (e) { /* 等 */ }
  }
  const t = (targets || []).find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
  if (!t) { console.error('拿不到调试目标'); child.kill(); process.exit(2); }

  const ws = new WebSocket(t.webSocketDebuggerUrl);
  const logs = [];
  let id = 0;
  const send = (method, params) => ws.send(JSON.stringify({ id: ++id, method, params: params || {} }));

  await new Promise((r) => { ws.onopen = r; });

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push('[异常] ' + (d.exception && d.exception.description ? d.exception.description : d.text));
      if (d.url) logs.push('       位置: ' + d.url + ':' + (d.lineNumber + 1));
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const parts = (m.params.args || []).map((a) => a.value !== undefined ? a.value : (a.description || a.type));
      logs.push('[console.' + m.params.type + '] ' + parts.join(' '));
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error') logs.push('[日志错误] ' + e.text + (e.url ? '  @' + e.url : ''));
    }
  };

  send('Runtime.enable');
  send('Log.enable');
  send('Page.enable');

  /* 重新加载一次,确保抓到加载期的错误 */
  send('Page.reload', { ignoreCache: true });
  await sleep(4000);

  if (logs.length === 0) console.log('  没有捕获到错误');
  else logs.slice(0, 20).forEach((l) => console.log('  ' + l));

  ws.close();
  child.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})().catch((e) => { console.error('出错: ' + e.message); process.exit(1); });
