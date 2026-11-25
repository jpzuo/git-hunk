/**
 * 语法高亮：基于 Shiki 的按行 token 化。
 *
 * 为什么用 Shiki：
 * - 用 TextMate 语法（VS Code 同款），语言覆盖与着色准确度都是业界最好
 * - `codeToTokensBase` 返回 `ThemedToken[][]`（**按行**组织的 token 数组），
 *   正好匹配我们左右对齐的行结构，不需要自己切分 token
 *
 * 为什么用 JavaScript 正则引擎而不是 Oniguruma(WASM)：
 * - 免去 WASM 资源加载，Tauri 打包更简单
 * - 对本项目的常见语言足够，性能也可接受
 *
 * 性能策略：
 * - highlighter 单例，语言按需懒加载（只有真正遇到该语言才加载语法）
 * - 按「文件内容」缓存 token 结果，切换文件时不会重复解析同一份内容
 * - 超过阈值的大文件直接降级为纯文本，避免卡死 UI
 */

import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

/** 使用的主题：100% 复刻 VS Code Dark+ / Dark Modern 语法配色。 */
const THEME = "dark-plus";

/** 单个文件超过此字符数则不做高亮（降级为纯文本渲染，保护主线程响应度）。
 * 80,000 字符约合 2,000~2,500 行，超过此规模走纯文本极速渲染。 */
const MAX_HIGHLIGHT_CHARS = 80_000;

/** 一个 token：文本 + 颜色 + 字体样式。 */
export interface Token {
  content: string;
  color?: string;
  fontStyle?: number;
}

/** 按行组织的 token 结果；null 表示该行无需特殊着色。 */
export type LineTokens = Token[];

/**
 * 扩展名 → Shiki 语言 id。
 *
 * 只映射常用语言；未命中的扩展名会返回 undefined，此时走纯文本渲染。
 * 值必须与 Shiki 的 BundledLanguage 一致。
 */
const EXT_TO_LANG: Record<string, string> = {
  // 前端
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  vue: "vue",
  svelte: "svelte",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",

  // 系统 / 后端
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  py: "python",
  lua: "lua",
  pl: "perl",
  r: "r",
  dart: "dart",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  clj: "clojure",

  // 脚本 / 配置
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  ps1: "powershell",
  psm1: "powershell",
  bat: "bat",
  cmd: "bat",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  proto: "proto",

  // 文档 / 其他
  md: "markdown",
  markdown: "markdown",
  rst: "rst",
  tex: "latex",
  diff: "diff",
  patch: "diff",
  dockerfile: "dockerfile",
  makefile: "make",
  mk: "make",
  cmake: "cmake",
  gradle: "groovy",
  groovy: "groovy",
  tf: "terraform",
  hcl: "hcl",
  nix: "nix",
  zig: "zig",
  nim: "nim",
  vim: "viml",
};

/** 无扩展名但可识别的文件名。 */
const FILENAME_TO_LANG: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "make",
  gnumakefile: "make",
  cmakelists_txt: "cmake",
  ".env": "dotenv",
  "cargo.lock": "toml",
  "package-lock.json": "json",
  "pnpm-lock.yaml": "yaml",
};

/**
 * 根据文件路径推断语言。
 *
 * 返回 `null` 表示无法识别，调用方应回退到纯文本渲染。
 */
export function detectLanguage(path: string): string | null {
  const clean = path.replace(/\\/g, "/");
  const name = (clean.split("/").pop() ?? "").toLowerCase();

  // 先看完整文件名（Dockerfile / Makefile 这类没有扩展名）
  if (FILENAME_TO_LANG[name]) return FILENAME_TO_LANG[name];

  // 再看扩展名
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = name.slice(dot + 1);
  return EXT_TO_LANG[ext] ?? null;
}

// ---------------------------------------------------------------------------
// highlighter 单例
// ---------------------------------------------------------------------------

let highlighterPromise: Promise<HighlighterCore> | null = null;
/** 已加载语法的语言集合，避免重复 loadLanguage。 */
const loadedLangs = new Set<string>();

/**
 * 懒加载 highlighter。
 *
 * 首次调用会初始化 Shiki 核心并加载主题；语言在 `highlightLines` 里按需加载。
 * 初始化失败时返回 null，调用方降级为纯文本（不影响 diff 基本可用性）。
 */
async function getHighlighter(): Promise<HighlighterCore | null> {
  if (highlighterPromise) {
    try {
      return await highlighterPromise;
    } catch {
      return null;
    }
  }

  highlighterPromise = (async () => {
    const hl = await createHighlighterCore({
      themes: [import("shiki/themes/dark-plus.mjs")],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
    return hl;
  })();

  try {
    return await highlighterPromise;
  } catch {
    return null;
  }
}

/**
 * 语言 id → 加载函数的静态映射。
 *
 * 为什么不用 `import(\`shiki/langs/${lang}.mjs\`)` 这种动态模板：
 * Vite 在构建时无法静态分析它，会给出 import-analysis 警告，且生产构建可能
 * 无法正确打包这些模块。用显式映射表，Vite 能静态解析、按需切分 chunk。
 *
 * 只收录上面 EXT_TO_LANG / FILENAME_TO_LANG 里用到的语言，避免打包无关语法。
 */
const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  sass: () => import("shiki/langs/sass.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  scala: () => import("shiki/langs/scala.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  perl: () => import("shiki/langs/perl.mjs"),
  r: () => import("shiki/langs/r.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  elixir: () => import("shiki/langs/elixir.mjs"),
  erlang: () => import("shiki/langs/erlang.mjs"),
  haskell: () => import("shiki/langs/haskell.mjs"),
  clojure: () => import("shiki/langs/clojure.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  bat: () => import("shiki/langs/bat.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  proto: () => import("shiki/langs/proto.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  rst: () => import("shiki/langs/rst.mjs"),
  latex: () => import("shiki/langs/latex.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  make: () => import("shiki/langs/make.mjs"),
  cmake: () => import("shiki/langs/cmake.mjs"),
  groovy: () => import("shiki/langs/groovy.mjs"),
  terraform: () => import("shiki/langs/terraform.mjs"),
  hcl: () => import("shiki/langs/hcl.mjs"),
  nix: () => import("shiki/langs/nix.mjs"),
  zig: () => import("shiki/langs/zig.mjs"),
  nim: () => import("shiki/langs/nim.mjs"),
  viml: () => import("shiki/langs/viml.mjs"),
  dotenv: () => import("shiki/langs/dotenv.mjs"),
};

/**
 * 按语言动态加载语法。
 *
 * 用静态映射表而非模板字符串动态 import，保证 Vite 能正确分析并按需打包。
 */
async function ensureLanguage(hl: HighlighterCore, lang: string): Promise<boolean> {
  if (loadedLangs.has(lang)) return true;

  const loader = LANG_LOADERS[lang];
  if (!loader) return false;

  try {
    const mod = (await loader()) as { default?: unknown };
    await hl.loadLanguage((mod.default ?? mod) as never);
    loadedLangs.add(lang);
    return true;
  } catch {
    // 该语言加载失败：调用方降级为纯文本
    return false;
  }
}

/** 内容 → 行 token 的缓存，避免重复解析同一份文本。 */
const tokenCache = new Map<string, LineTokens[]>();
const MAX_CACHE_ENTRIES = 100;

function cacheKey(lang: string, content: string): string {
  // 用长度 + 前 200 字符 + 后 200 字符做轻量指纹，避免把整份内容当 key
  return `${lang}:${content.length}:${content.slice(0, 200)}:${content.slice(-200)}`;
}

function putCache(key: string, value: LineTokens[]): void {
  if (tokenCache.size >= MAX_CACHE_ENTRIES) {
    // 简单 FIFO 淘汰
    const first = tokenCache.keys().next().value;
    if (first !== undefined) tokenCache.delete(first);
  }
  tokenCache.set(key, value);
}

/**
 * 把源码按行 token 化。
 *
 * 返回的数组长度与 `splitLines(content)` 一致（末尾换行不产生额外行），
 * 这样调用方可以直接用行号索引，与左右对齐行一一对应。
 *
 * 任何失败（语言不支持、内容过大、初始化失败）都返回 `null`，
 * 调用方应回退到纯文本渲染。
 */
export async function highlightLines(
  content: string,
  lang: string | null,
): Promise<LineTokens[] | null> {
  if (!lang) return null;
  if (content.length > MAX_HIGHLIGHT_CHARS) return null;

  const key = cacheKey(lang, content);
  const cached = tokenCache.get(key);
  if (cached) return cached;

  const hl = await getHighlighter();
  if (!hl) return null;

  const ok = await ensureLanguage(hl, lang);
  if (!ok) return null;

  try {
    const lines = hl.codeToTokensBase(content, {
      lang,
      theme: THEME,
    });

    const result: LineTokens[] = lines.map((tokens) =>
      tokens.map((t) => ({
        content: t.content,
        color: t.color,
        fontStyle: t.fontStyle,
      })),
    );

    // Shiki 对空内容会返回 [ [] ]，这里统一为 0 行，与 splitLines 语义一致
    const normalized = content === "" ? [] : result;

    putCache(key, normalized);
    return normalized;
  } catch {
    return null;
  }
}

/**
 * 判断某个语言是否可用（不实际加载）。
 *
 * 用于 UI 提前决定是否显示「高亮不可用」提示；失败静默返回 false。
 */
export function isKnownLanguage(lang: string | null): boolean {
  return lang !== null;
}