/** 文件内 / Diff 内查找共用正则编译与行匹配工具（对齐 VS Code Find 行为）。 */

export interface FindQueryOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
}

export const DEFAULT_FIND_OPTIONS: FindQueryOptions = {
  query: "",
  caseSensitive: false,
  wholeWord: false,
  useRegex: false,
};

export interface LineMatchSpan {
  start: number;
  end: number;
}

const MAX_MATCHES_PER_LINE = 200;

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAsciiWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

/** 将查找配置编译为全局 RegExp；非法正则返回可读错误且不抛异常。 */
export function compileFindRegex(opts: FindQueryOptions): {
  regex: RegExp | null;
  error: string | null;
} {
  if (!opts.query) {
    return { regex: null, error: null };
  }

  let pattern = opts.useRegex ? opts.query : escapeRegExp(opts.query);
  if (opts.wholeWord) {
    if (opts.useRegex) {
      pattern = `\\b(?:${pattern})\\b`;
    } else {
      const first = opts.query[0] ?? "";
      const last = opts.query[opts.query.length - 1] ?? "";
      const prefix = isAsciiWordChar(first) ? "\\b" : "";
      const suffix = isAsciiWordChar(last) ? "\\b" : "";
      pattern = `${prefix}${pattern}${suffix}`;
    }
  }

  try {
    return {
      regex: new RegExp(pattern, opts.caseSensitive ? "g" : "gi"),
      error: null,
    };
  } catch (e) {
    return {
      regex: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 检索单行中全部非零宽匹配片段（UTF-16 字符索引）。 */
export function findMatchesInLine(lineText: string, re: RegExp | null): LineMatchSpan[] {
  if (!re || !lineText) return [];
  re.lastIndex = 0;
  const spans: LineMatchSpan[] = [];
  let m: RegExpExecArray | null;
  let guard = 0;

  while ((m = re.exec(lineText)) !== null && guard < MAX_MATCHES_PER_LINE) {
    guard++;
    const matched = m[0];
    if (matched.length === 0) {
      re.lastIndex += 1;
      continue;
    }
    spans.push({
      start: m.index,
      end: m.index + matched.length,
    });
  }

  return spans;
}

/** 获取当前页面内的单行文本选中内容，用于 Ctrl+F 自动预填（对标 VS Code）。 */
export function extractSingleLineSelection(): string {
  const sel = window.getSelection()?.toString() ?? "";
  if (!sel || sel.includes("\n") || sel.includes("\r") || sel.length > 120) {
    return "";
  }
  return sel;
}
