/** 终端日志降噪过滤器：过滤警告类、信息类、调试及冗余提示输出，保留核心结果、URL 与真实报错。 */

import type { ScriptLogLine } from "../types";

const ANSI_STRIP_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const ERROR_KEEP_RE =
  /(?:\b(?:error|failed|fatal|exception|panic)\b|npm\s+err!|\bTS\d{4,5}:|error\[E\d+\]|[✖✘×]\s)/i;

const WARNING_START_RE =
  /^\s*(?:⚠|▲|\(!\)|\[(?:warn(?:ing)?)\]|(?:npm|pnpm|yarn|bun)\s+warn\b|WARN(?:\b|[\s: ])|WARNING(?:\b|[:\s])|Warning:|warning(?:\[[^\]]+\])?:|Deprecation\s*Warning\b|DEPRECATION\s+WARNING\b)/i;

const WARNING_ANYWHERE_RE =
  /(?:DeprecationWarning:|ExperimentalWarning:|Browserslist:\s*caniuse-lite is outdated|\brepetitive deprecation warnings? omitted\b|To silence this warning|\(Use [`'"]?node --trace-|\bMore info:\s*https?:\/\/)/i;

const WARNING_BLOCK_CONTINUATION_RE =
  /^\s*(?:(?:\d+\s*)?[╷│╵├└╭╰]|[\^~]+\s*$|-->\s+\S+|=\s*(?:note|help):|root stylesheet\s*$|\S+\.(?:scss|sass|css|less|styl|vue|ts|tsx|js|jsx|rs)\s+\d+:\d+)/;

const INFO_OR_DEBUG_RE =
  /^\s*(?:ℹ|\[(?:info|debug|trace|verbose|log|notice)\]|INFO(?:\b|[:\s])|DEBUG(?:\b|[:\s])|TRACE(?:\b|[:\s])|VERBOSE(?:\b|[:\s])|NOTICE(?:\b|[:\s])|info:|info\s{2,}|npm\s+notice\b|notice:|verbose:|debug:|hint:|note:|help:|\[vite\]\s+(?:connecting|connected|hmr|page reload|server restarted)\b)/i;

export function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_STRIP_RE, "");
}

export interface LogFilterOutput {
  lines: ScriptLogLine[];
  hiddenCount: number;
}

/** 过滤终端日志中的警告类与信息类噪声，同时保护真实报错、服务地址与核心构建摘要。 */
export function filterTerminalNoiseLines(lines: ScriptLogLine[]): LogFilterOutput {
  const kept: ScriptLogLine[] = [];
  let hiddenCount = 0;
  let inWarningBlock = false;

  for (const line of lines) {
    if (line.stream === "system") {
      hiddenCount++;
      continue;
    }

    const plain = stripAnsiCodes(line.text);
    const trimmed = plain.trim();

    if (trimmed.length === 0) {
      if (inWarningBlock) {
        hiddenCount++;
        continue;
      }
      kept.push(line);
      continue;
    }

    if (ERROR_KEEP_RE.test(plain)) {
      inWarningBlock = false;
      kept.push(line);
      continue;
    }

    if (WARNING_START_RE.test(plain) || WARNING_ANYWHERE_RE.test(plain)) {
      inWarningBlock = true;
      hiddenCount++;
      continue;
    }

    if (inWarningBlock) {
      if (WARNING_BLOCK_CONTINUATION_RE.test(plain)) {
        hiddenCount++;
        continue;
      }
      inWarningBlock = false;
    }

    if (INFO_OR_DEBUG_RE.test(plain)) {
      hiddenCount++;
      continue;
    }

    kept.push(line);
  }

  return { lines: kept, hiddenCount };
}
