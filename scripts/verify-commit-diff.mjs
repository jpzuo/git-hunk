// 验证：点击提交详情里的文件，能打开该提交的 diff。
const port = process.argv[2] ?? "9222";
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error("ws connect failed"));
});
let id = 0;
const pending = new Map();
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
ws.addEventListener("message", (ev) => {
  const data = JSON.parse(ev.data);
  if (data.id && pending.has(data.id)) {
    const { resolve, reject } = pending.get(data.id);
    pending.delete(data.id);
    data.error ? reject(new Error(JSON.stringify(data.error))) : resolve(data.result);
  }
});
await call("Runtime.enable");
const evaluate = async (expr) => {
  const r = await call("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails)
    return `[JSERR] ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`;
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("=== 点击提交详情里的文件 ===");
console.log(
  await evaluate(`
  (() => {
    const row = document.querySelector('.detail-file-row');
    if (!row) return 'no file row';
    row.click();
    return 'clicked: ' + row.innerText.replace(/\\n/g, ' ');
  })()
`)
);
await sleep(2000);

console.log("\n=== 历史提交 diff 渲染 ===");
console.log(
  await evaluate(`
  JSON.stringify({
    diffRendered: !!document.querySelector('.diff-body'),
    path: document.querySelector('.diff-path')?.textContent?.trim(),
    hunks: document.querySelectorAll('.hunk').length,
    header: document.querySelector('.hunk-header')?.innerText?.replace(/\\n/g, ' '),
    preview: document.querySelector('.diff-body')?.innerText?.slice(0, 250),
    hasStageButtons: document.querySelectorAll('.hunk-actions button').length,
  }, null, 2)
`)
);

console.log("\n=== 切换到「工作区变更」视图 ===");
console.log(
  await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('.nav-btn')].find(x =>
      x.querySelector('.nav-label')?.textContent === '工作区变更');
    if (!b) return 'not found';
    b.click();
    return 'clicked';
  })()
`)
);
await sleep(1500);
console.log(
  await evaluate(`
  JSON.stringify({
    sourceControl: !!document.querySelector('.sc'),
    groups: [...document.querySelectorAll('.sc-group-title')].map(t => t.textContent),
  }, null, 2)
`)
);

console.log("\n=== 切回提交历史 ===");
console.log(
  await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('.nav-btn')].find(x =>
      x.querySelector('.nav-label')?.textContent === '提交历史');
    b.click();
    return 'clicked';
  })()
`)
);
await sleep(1200);
console.log(
  await evaluate(`
  JSON.stringify({
    graphBack: !!document.querySelector('.commit-graph'),
    rows: document.querySelectorAll('.graph-row').length,
  })
`)
);

ws.close();