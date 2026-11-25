// 验证扩展 Git 能力模块与组件
import { createServer } from "vite";

const server = await createServer({
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
});

let passed = 0;
let failed = 0;

async function checkModule(path, name) {
  try {
    const mod = await server.ssrLoadModule(path);
    console.log(`  OK   ${name} 模块加载成功`);
    passed++;
    return mod;
  } catch (e) {
    console.error(`  FAIL ${name} 模块加载失败:`, e);
    failed++;
  }
}

console.log("=== 验证前端新增 Git 能力模块 ===");
await checkModule("/src/api.ts", "api.ts");
await checkModule("/src/types.ts", "types.ts");
await checkModule("/src/commands/builtin.ts", "builtin.ts");
await checkModule("/src/components/BranchQuickPick.tsx", "BranchQuickPick.tsx");
await checkModule("/src/components/BranchesPanel.tsx", "BranchesPanel.tsx");
await checkModule("/src/components/StashPanel.tsx", "StashPanel.tsx");
await checkModule("/src/components/TagsPanel.tsx", "TagsPanel.tsx");
await checkModule("/src/components/RemotesPanel.tsx", "RemotesPanel.tsx");
await checkModule("/src/App.tsx", "App.tsx");

console.log(`\n=== 汇总: ${passed} 通过, ${failed} 失败 ===`);

await server.close();

if (failed > 0) {
  process.exit(1);
}
