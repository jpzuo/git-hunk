// 在浏览器环境验证高亮真实渲染：用 vite dev server 的页面 + puppeteer 式 CDP 太复杂，
// 改为直接检查 Vite 能否正确编译并解析 highlighter 模块的所有语言导入。
import { createServer } from "vite";

const server = await createServer({
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
});

let failed = 0;
let passed = 0;

try {
  // 1. 模块能被正确加载（说明所有静态 import 都能解析）
  const mod = await server.ssrLoadModule("/src/highlighter.ts");
  console.log("=== 模块加载 ===");
  console.log("  highlighter.ts 加载成功");
  passed++;

  // 2. 逐语言验证：真实调用 highlightLines，确认每种语言都能出 token
  console.log("\n=== 逐语言高亮验证 ===");
  const samples = {
    typescript: "const x: number = 1; // comment",
    tsx: "const A = () => <div className=\"x\">hi</div>;",
    javascript: "function f() { return 42; }",
    jsx: "const A = () => <div>hi</div>;",
    vue: "<template><div>{{ msg }}</div></template>",
    svelte: "<script>let x = 1;</script>",
    html: "<div class=\"box\">hello</div>",
    css: ".box { color: red; }",
    scss: "$c: red;\n.box { color: $c; }",
    sass: ".box\n  color: red",
    less: "@c: red;\n.box { color: @c; }",
    rust: "fn main() { let x = 1; }",
    go: "func main() { x := 1 }",
    java: "public class A { int x = 1; }",
    kotlin: "fun main() { val x = 1 }",
    scala: "object A { val x = 1 }",
    swift: "let x = 1",
    c: "int main() { return 0; }",
    cpp: "int main() { return 0; }",
    csharp: "class A { int x = 1; }",
    php: "<?php $x = 1; ?>",
    ruby: "def f; 1; end",
    python: "def f():\n    return 1",
    lua: "local x = 1",
    perl: "my $x = 1;",
    r: "x <- 1",
    dart: "void main() { var x = 1; }",
    elixir: "defmodule A do\nend",
    erlang: "-module(a).",
    haskell: "main = putStrLn \"hi\"",
    clojure: "(def x 1)",
    shellscript: "echo \"hello\"",
    powershell: "Write-Host 'hi'",
    bat: "@echo off",
    json: "{\"a\": 1}",
    jsonc: "{ // c\n \"a\": 1 }",
    yaml: "key: value",
    toml: "[section]\nkey = 1",
    ini: "[s]\nk=1",
    xml: "<root><a/></root>",
    sql: "SELECT * FROM t;",
    graphql: "query { user { id } }",
    proto: "message A { int32 x = 1; }",
    markdown: "# Title\n\n**bold**",
    rst: "Title\n=====",
    latex: "\\section{A}",
    diff: "@@ -1 +1 @@\n-a\n+b",
    dockerfile: "FROM alpine\nRUN echo hi",
    make: "all:\n\techo hi",
    cmake: "project(A)",
    groovy: "def x = 1",
    terraform: "resource \"a\" \"b\" {}",
    hcl: "key = \"value\"",
    nix: "{ pkgs }: pkgs.hello",
    zig: "const x: i32 = 1;",
    nim: "let x = 1",
    viml: "let g:x = 1",
    dotenv: "KEY=value",
  };

  for (const [lang, code] of Object.entries(samples)) {
    const tokens = await mod.highlightLines(code, lang);
    if (tokens === null) {
      console.log(`  FAIL ${lang.padEnd(14)} 返回 null（语言未加载？）`);
      failed++;
    } else if (tokens.length === 0) {
      console.log(`  FAIL ${lang.padEnd(14)} 0 行`);
      failed++;
    } else {
      const colored = tokens.flat().filter((t) => t.color).length;
      const total = tokens.flat().length;
      if (colored === 0) {
        console.log(`  WARN ${lang.padEnd(14)} ${total} tokens 但无着色`);
        failed++;
      } else {
        console.log(`  OK   ${lang.padEnd(14)} ${tokens.length} 行, ${total} tokens, ${colored} 有色`);
        passed++;
      }
    }
  }

  console.log(`\n=== 汇总: ${passed} 通过, ${failed} 失败 ===`);
} catch (e) {
  console.error("验证异常:", e.message);
  failed++;
} finally {
  await server.close();
}

process.exit(failed > 0 ? 1 : 0);