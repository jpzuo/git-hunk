// 验证界面上的 hunk 级暂存与提交按钮真实生效。
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
  if (r.exceptionDetails)
    return `[JS ERROR] ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`;
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("=== 操作前状态 ===");
console.log(await evaluate(`
  JSON.stringify({
    groups: [...document.querySelectorAll('.sc-group')].map(g => ({
      t: g.querySelector('.sc-group-title')?.textContent,
      c: g.querySelector('.sc-group-count')?.textContent,
    })),
  })
`));

console.log("\n=== 点击 diff 里的「暂存」按钮（hunk 级）===");
console.log(await evaluate(`
  (() => {
    const btns = [...document.querySelectorAll('.hunk-actions button')];
    const b = btns.find(x => x.textContent.trim() === '暂存');
    if (!b) return 'no stage button; found=' + btns.map(x=>x.textContent).join(',');
    b.click();
    return 'clicked 暂存';
  })()
`));
await sleep(2000);

console.log("\n=== 暂存后状态 ===");
console.log(await evaluate(`
  JSON.stringify({
    groups: [...document.querySelectorAll('.sc-group')].map(g => ({
      t: g.querySelector('.sc-group-title')?.textContent,
      c: g.querySelector('.sc-group-count')?.textContent,
      files: [...g.querySelectorAll('.file-row')].map(r => r.innerText.replace(/\\n/g,' ')),
    })),
    toast: document.querySelector('.toast')?.textContent ?? null,
  }, null, 2)
`));

console.log("\n=== 填写提交信息并点「提交」===");
console.log(await evaluate(`
  (() => {
    const ta = document.querySelector('.commit-input');
    if (!ta) return 'no commit input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, 'feat: hunk staging via UI');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed: ' + ta.value;
  })()
`));
await sleep(600);

console.log(await evaluate(`
  (() => {
    const btns = [...document.querySelectorAll('.commit-actions button')];
    const b = btns.find(x => x.textContent.includes('提交'));
    if (!b) return 'no commit button';
    if (b.disabled) return 'commit button disabled';
    b.click();
    return 'clicked 提交';
  })()
`));
await sleep(2500);

console.log("\n=== 提交后状态 ===");
console.log(await evaluate(`
  JSON.stringify({
    groups: [...document.querySelectorAll('.sc-group')].map(g => ({
      t: g.querySelector('.sc-group-title')?.textContent,
      c: g.querySelector('.sc-group-count')?.textContent,
    })),
    toast: document.querySelector('.toast')?.textContent ?? null,
    statusbar: document.querySelector('.statusbar')?.innerText?.replace(/\\n/g,' | ') ?? null,
  }, null, 2)
`));

ws.close();