/*
 * 用 CDP 在页面里先执行一段 JS,再截图保存。
 * 这样能捕捉到 canvas 内容(命令行 --screenshot 有时抓不到)。
 *
 * 用法: node cdp-shot.js <url> <输出png> --expr "<先执行的 js>"
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2];
const outPath = process.argv[3];

/* 表达式优先从文件读,避免命令行转义问题;没有文件就用 --expr */
let expression = '1';
const exprFileIndex = process.argv.indexOf('--expr-file');
if (exprFileIndex > 0 && process.argv[exprFileIndex + 1]) {
  expression = fs.readFileSync(process.argv[exprFileIndex + 1], 'utf8');
} else {
  const exprIndex = process.argv.indexOf('--expr');
  if (exprIndex > 0) expression = process.argv[exprIndex + 1];
}

const port = 9600 + Math.floor(Math.random() * 300);
const profile = path.join(process.env.TEMP, 'edge-shot-' + Date.now());

/* 窗口尺寸可以用 --size 宽x高 指定,默认按普通手机 */
let winSize = '420,860';
const sizeIndex = process.argv.indexOf('--size');
if (sizeIndex > 0 && process.argv[sizeIndex + 1]) {
  winSize = process.argv[sizeIndex + 1].replace('x', ',');
}

/*
 * 缩放系数。headless Edge 的窗口有最小宽度(约 500px),
 * 想模拟更窄的手机就得靠这个:窗口 500px + 缩放 1.3 -> CSS 视口约 385px。
 */
let dsf = null;
const dsfIndex = process.argv.indexOf('--dsf');
if (dsfIndex > 0 && process.argv[dsfIndex + 1]) {
  dsf = process.argv[dsfIndex + 1];
}

function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, timeout: 3000 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-features=msEdgeSyncPromo,msSyncPromo',
    '--hide-scrollbars', `--window-size=${winSize}`,
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, url
  ];
  if (dsf) args.splice(4, 0, `--force-device-scale-factor=${dsf}`);
  const child = spawn(EDGE, args, { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      targets = await getJson('/json/list');
      if (targets && targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl)) break;
    } catch (e) { /* 继续等 */ }
  }
  const target = (targets || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) { console.error('SHOT_ERROR: 调试端口未就绪'); child.kill(); process.exit(2); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();

  const send = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
  });

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };

  await new Promise((resolve) => { ws.onopen = resolve; });

  /* 等页面就绪,并等页面自己的调试出口挂上 */
  for (let i = 0; i < 60; i++) {
    const r = await send('Runtime.evaluate', {
      expression: '(document.readyState === "complete") && (typeof window.__care !== "undefined")',
      returnByValue: true
    });
    if (r.result && r.result.value === true) break;
    await sleep(250);
  }

  /* 先执行注入的 JS */
  if (expression !== '1') {
    const r = await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) {
      console.error('SHOT_ERROR: 页面异常 ' + JSON.stringify(r.exceptionDetails.exception));
    }
  }

  await sleep(600);

  /* 再截图 */
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
  console.log('已保存 ' + outPath + '  (' + fs.statSync(outPath).size + ' bytes)');

  ws.close();
  child.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  process.exit(0);
})().catch((e) => {
  console.error('SHOT_ERROR: ' + e.message);
  process.exit(1);
});
