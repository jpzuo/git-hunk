// 验证：审查页只保留双栏、无折叠条、代码全量展开。
const commitKeyword = process.argv[2] ?? "修改长文件两处";
const fileName = process.argv[3] ?? "long.ts";
const port = process.argv[4] ?? "9222";

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

await evaluate(`(() => { const b = document.querySelector('.review-back'); if (b) b.click(); return 1; })()`);
await sleep(1000);

console.log(`=== 1. 点击提交「${commitKeyword}」===`);
console.log(
  await evaluate(`
  (() => {
    const rows = [...document.querySelectorAll('.graph-row')];
    const t = rows.find(r => r.innerText.includes(${JSON.stringify(commitKeyword)}));
    if (!t) return 'not found';
    t.click();
    return 'clicked';
  })()
`),
);
await sleep(2500);

console.log(`\n=== 2. 选中「${fileName}」===`);
console.log(
  await evaluate(`
  (() => {
    const rows = [...document.querySelectorAll('.tree-row.file')];
    const t = rows.find(r => r.innerText.includes(${JSON.stringify(fileName)}));
    if (!t) return 'not found; available=' + rows.map(r=>r.innerText).join(' / ');
    t.click();
    return 'clicked';
  })()
`),
);
await sleep(2500);

console.log("\n=== 3. 检查：只双栏、无折叠、全量展开 ===");
console.log(
  await evaluate(`
  JSON.stringify({
    // 双栏检查
    hasSegmented: !!document.querySelector('.review-header .segmented'),
    headCells: document.querySelectorAll('.sbs-head-cell').length,
    headLabels: [...document.querySelectorAll('.sbs-label')].map(e => e.textContent),
    // 折叠检查
    collapseBars: document.querySelectorAll('.diff-collapse-bar').length,
    // 全量展开检查（40 行文件应全部渲染）
    totalRows: document.querySelectorAll('.sbs-row').length,
    // 染色检查
    ctxCells: document.querySelectorAll('.sbs-cell.ctx').length,
    addCells: document.querySelectorAll('.sbs-cell.add').length,
    delCells: document.querySelectorAll('.sbs-cell.del').length,
    emptyCells: document.querySelectorAll('.sbs-cell.empty').length,
  }, null, 2)
`),
);

console.log("\n=== 4. 首尾行确认全量（应含 line 1 到 line 40）===");
console.log(
  await evaluate(`
  (() => {
    const rows = [...document.querySelectorAll('.sbs-row')];
    const first = rows[0]?.innerText?.replace(/\\n/g,' | ');
    const last = rows[rows.length-1]?.innerText?.replace(/\\n/g,' | ');
    return JSON.stringify({ first, last, count: rows.length }, null, 2);
  })()
`),
);

ws.close();