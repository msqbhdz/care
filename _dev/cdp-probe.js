/*
 * 探针:用 Edge 的远程调试协议(CDP)在页面里执行 JS 并取回结果。
 * 用途:验证网页版弹窗的逻辑(卡片数量、名字替换、随机位置等)。
 *
 * 用法: node cdp-probe.js <file:///... 或 https://...> --expr "<js 表达式>"
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const url = process.argv[2];

/* 表达式优先从文件读(长表达式经命令行容易被 shell 转义截断) */
let expression = '1+1';
const exprFileIndex = process.argv.indexOf('--expr-file');
if (exprFileIndex > 0 && process.argv[exprFileIndex + 1]) {
  expression = fs.readFileSync(process.argv[exprFileIndex + 1], 'utf8');
} else {
  const exprIndex = process.argv.indexOf('--expr');
  if (exprIndex > 0) expression = process.argv[exprIndex + 1];
}

const port = 9411 + Math.floor(Math.random() * 200);
const profile = path.join(process.env.TEMP, 'edge-cdp-' + Date.now());

/* 页面就绪的判定表达式,可用 --ready "<js>" 覆盖 */
let readyExpr = '(document.readyState === "complete") && (typeof window.__care !== "undefined")';
const readyIndex = process.argv.indexOf('--ready');
if (readyIndex > 0 && process.argv[readyIndex + 1]) {
  readyExpr = process.argv[readyIndex + 1];
}

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname, timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, url
  ], { stdio: 'ignore', detached: false });

  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      targets = await getJson('/json/list');
      if (targets && targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl)) break;
    } catch (e) { /* 继续等 */ }
  }
  const target = (targets || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) {
    console.error('PROBE_ERROR: 调试端口未就绪');
    child.kill();
    process.exit(2);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('求值超时')), 30000);
    let phase = 'wait';
    const ask = () => {
      ws.send(JSON.stringify({
        id: phase === 'wait' ? 100 : 1,
        method: 'Runtime.evaluate',
        params: {
          expression: phase === 'wait'
            ? readyExpr
            : expression,
          returnByValue: true,
          awaitPromise: true
        }
      }));
    };
    ws.onopen = () => ask();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === 100) {
        /* 页面还没就绪,等一会再问 */
        if (msg.result && msg.result.result && msg.result.result.value === true) {
          phase = 'eval';
          ask();
        } else {
          setTimeout(ask, 250);
        }
        return;
      }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      if (msg.result && msg.result.exceptionDetails) {
        reject(new Error('页面异常: ' + JSON.stringify(msg.result.exceptionDetails.exception)));
      } else {
        resolve(msg.result.result.value);
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket 出错')); };
  });

  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  ws.close();
  child.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  process.exit(0);
})().catch((e) => {
  console.error('PROBE_ERROR: ' + e.message);
  process.exit(1);
});
