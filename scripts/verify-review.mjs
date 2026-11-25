// 验证提交审查页：点击提交 → 左侧文件树 + 右侧全文对比。
const repoPath = process.argv[2] ?? "E:/tmp/git-hunk-graph-demo";
const port = process.argv[3] ?? "9222";

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target");
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
await call("Page.enable");

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

await evaluate(`localStorage.setItem('git-hunk.recent-repo', ${JSON.stringify(repoPath)}); 'ok'`);
await call("Page.reload");
await sleep(5000);

console.log("=== 1. 初始：提交图 ===");
console.log(
  await evaluate(`
  JSON.stringify({
    graph: !!document.querySelector('.commit-graph'),
    rows: document.querySelectorAll('.graph-row').length,
    reviewPage: !!document.querySelector('.review-page'),
  })
`)
);

console.log("\n=== 2. 点击一个含多文件变更的提交 ===");
console.log(
  await evaluate(`
  (() => {
    const rows = [...document.querySelectorAll('.graph-row')];
    // 选「merge: 合并登录功能到 main」，它通常有 2 个文件
    const target = rows.find(r => r.innerText.includes('合并登录功能')) ?? rows[3] ?? rows[0];
    target.click();
    return 'clicked: ' + target.querySelector('.commit-summary')?.textContent;
  })()
`)
);
await sleep(3000);

console.log("\n=== 3. 审查页结构 ===");
console.log(
  await evaluate(`
  JSON.stringify({
    reviewPage: !!document.querySelector('.review-page'),
    backButton: !!document.querySelector('.review-back'),
    summary: document.querySelector('.review-summary')?.textContent,
    hash: document.querySelector('.review-hash')?.textContent,
    meta: document.querySelector('.review-meta')?.innerText?.replace(/\\n/g,' | '),
    treeRendered: !!document.querySelector('.file-tree'),
    treeNodes: document.querySelectorAll('.tree-row').length,
    treeFiles: document.querySelectorAll('.tree-row.file').length,
    treeDirs: document.querySelectorAll('.tree-row.dir').length,
    selectedFile: document.querySelector('.tree-row.file.selected')?.innerText?.replace(/\\n/g,' '),
  }, null, 2)
`)
);

console.log("\n=== 4. 全文对比渲染 ===");
console.log(
  await evaluate(`
  JSON.stringify({
    sbsRendered: !!document.querySelector('.sbs-diff'),
    headLabels: [...document.querySelectorAll('.sbs-label')].map(e => e.textContent),
    headPaths: [...document.querySelectorAll('.sbs-path')].map(e => e.textContent?.trim()),
    totalRows: document.querySelectorAll('.sbs-row').length,
    ctxRows: document.querySelectorAll('.sbs-cell.ctx').length,
    addCells: document.querySelectorAll('.sbs-cell.add').length,
    delCells: document.querySelectorAll('.sbs-cell.del').length,
    emptyCells: document.querySelectorAll('.sbs-cell.empty').length,
    collapseBars: [...document.querySelectorAll('.diff-collapse-bar')].map(b => b.textContent?.trim()),
    firstLines: [...document.querySelectorAll('.sbs-row')].slice(0, 6).map(r => r.innerText.replace(/\\n/g,' | ')),
  }, null, 2)
`)
);

ws.close();