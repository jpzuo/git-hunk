// 验证提交关系图在真实界面中的渲染效果。
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

// 写入最近仓库并重载，走应用自身的恢复路径
await evaluate(`localStorage.setItem('git-hunk.recent-repo', ${JSON.stringify(repoPath)}); 'ok'`);
await call("Page.reload");
await sleep(5000);

console.log("=== 页面标题 ===");
console.log(await evaluate("document.title"));

console.log("\n=== 左栏导航 ===");
console.log(
  await evaluate(`
  JSON.stringify([...document.querySelectorAll('.nav-btn')].map(b => ({
    label: b.querySelector('.nav-label')?.textContent,
    active: b.classList.contains('active'),
    disabled: b.classList.contains('disabled'),
  })), null, 2)
`)
);

console.log("\n=== 提交图渲染 ===");
console.log(
  await evaluate(`
  JSON.stringify({
    graphRendered: !!document.querySelector('.commit-graph'),
    rowCount: document.querySelectorAll('.graph-row').length,
    laneSvgCount: document.querySelectorAll('.lane-svg').length,
    lineCount: document.querySelectorAll('.lane-svg line').length,
    pathCount: document.querySelectorAll('.lane-svg path').length,
    nodeCount: document.querySelectorAll('.node-svg circle').length,
    firstRows: [...document.querySelectorAll('.graph-row')].slice(0, 5).map(r => {
      const refs = [...r.querySelectorAll('.ref-badge')].map(x => x.textContent);
      return {
        refs,
        summary: r.querySelector('.commit-summary')?.textContent,
        author: r.querySelector('.commit-author')?.textContent,
        hash: r.querySelector('.commit-hash')?.textContent,
      };
    }),
  }, null, 2)
`)
);

console.log("\n=== 分支 chip 与状态栏 ===");
console.log(
  await evaluate(`
  JSON.stringify({
    branchChip: document.querySelector('.branch-chip')?.textContent?.trim(),
    repoName: document.querySelector('.repo-name')?.textContent,
    statusbar: document.querySelector('.statusbar')?.innerText?.replace(/\\n/g,' | '),
  }, null, 2)
`)
);

console.log("\n=== 点击第 1 个提交，验证详情 ===");
console.log(
  await evaluate(`
  (() => {
    const row = document.querySelector('.graph-row');
    if (!row) return 'no row';
    row.click();
    return 'clicked: ' + row.querySelector('.commit-summary')?.textContent;
  })()
`)
);
await sleep(2000);

console.log(
  await evaluate(`
  JSON.stringify({
    detailRendered: !!document.querySelector('.commit-detail'),
    summary: document.querySelector('.detail-summary')?.textContent,
    hash: document.querySelector('.detail-hash')?.textContent,
    meta: document.querySelector('.detail-meta')?.innerText?.replace(/\\n/g,' | '),
    stats: document.querySelector('.detail-stats')?.innerText?.replace(/\\n/g,' | '),
    files: [...document.querySelectorAll('.detail-file-row')].map(r => r.innerText.replace(/\\n/g,' ')),
    isMerge: !!document.querySelector('.merge-badge'),
  }, null, 2)
`)
);

ws.close();