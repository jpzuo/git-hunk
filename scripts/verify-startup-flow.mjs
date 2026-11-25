// 走应用自身的「启动恢复最近仓库」路径验证完整链路。
// App.tsx 启动时读取 localStorage['git-hunk.recent-repo'] 并自动打开该仓库，
// 这与用户实际操作走的是同一条代码路径。
const repoPath = process.argv[2] ?? "E:/tmp/git-hunk-demo";
const port = process.argv[3] ?? "9222";

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
  if (r.exceptionDetails) {
    return `[JS ERROR] ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`;
  }
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. 写入最近仓库，然后让页面自行重新加载（模拟下次启动）
await evaluate(`
  localStorage.setItem('git-hunk.recent-repo', ${JSON.stringify(repoPath)});
  'set';
`);
await call("Page.enable");
await call("Page.reload");
await sleep(4000);

console.log("=== 启动后自动恢复仓库 ===");
console.log(
  await evaluate(`
  JSON.stringify({
    url: location.href,
    scRendered: !!document.querySelector('.sc'),
    branch: document.querySelector('.branch-name')?.textContent ?? null,
    groups: [...document.querySelectorAll('.sc-group')].map(g => ({
      title: g.querySelector('.sc-group-title')?.textContent,
      count: g.querySelector('.sc-group-count')?.textContent,
      files: [...g.querySelectorAll('.file-row')].map(r => r.innerText.replace(/\\n/g,' ')),
    })),
    statusbar: document.querySelector('.statusbar')?.innerText?.replace(/\\n/g,' | ') ?? null,
  }, null, 2)
`)
);

console.log("\n=== 点击 app.rs 打开 diff ===");
console.log(
  await evaluate(`
  (() => {
    const rows = [...document.querySelectorAll('.file-row')];
    const t = rows.find(r => r.innerText.includes('app.rs'));
    if (!t) return 'not found: ' + rows.map(r=>r.innerText).join(' / ');
    t.click();
    return 'clicked';
  })()
`)
);
await sleep(1500);

console.log("\n=== diff 视图 ===");
console.log(
  await evaluate(`
  JSON.stringify({
    diffBody: !!document.querySelector('.diff-body'),
    path: document.querySelector('.diff-path')?.textContent?.trim() ?? null,
    hunkCount: document.querySelectorAll('.hunk').length,
    header: document.querySelector('.hunk-header')?.innerText?.replace(/\\n/g,' ') ?? null,
    actions: [...document.querySelectorAll('.hunk-actions button')].map(b => b.textContent),
    preview: document.querySelector('.diff-body')?.innerText?.slice(0, 400) ?? null,
  }, null, 2)
`)
);

console.log("\n=== 命令面板（Ctrl+Shift+P）===");
await call("Input.dispatchKeyEvent", {
  type: "keyDown",
  modifiers: 2 | 8, // Ctrl + Shift
  key: "P",
  code: "KeyP",
  windowsVirtualKeyCode: 80,
});
await call("Input.dispatchKeyEvent", {
  type: "keyUp",
  modifiers: 2 | 8,
  key: "P",
  code: "KeyP",
  windowsVirtualKeyCode: 80,
});
await sleep(1000);

console.log(
  await evaluate(`
  JSON.stringify({
    paletteOpen: !!document.querySelector('.palette'),
    items: [...document.querySelectorAll('.palette-item-title')].map(e => e.textContent),
  }, null, 2)
`)
);

ws.close();