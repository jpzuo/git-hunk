/** 轻量级零依赖 ANSI SGR 终端配色与链接切分器（对齐 VS Code Dark Modern 终端色板）。 */

export interface AnsiStyle {
  fg?: string;
  bold?: boolean;
  dim?: boolean;
  underline?: boolean;
}

export interface AnsiSegment {
  text: string;
  style: AnsiStyle;
  url?: string;
}

const STANDARD_COLORS: Record<number, string> = {
  30: "#666666",
  31: "#f14c4c",
  32: "#73c991",
  33: "#e2c08d",
  34: "#3794ff",
  35: "#c586c0",
  36: "#4ec9b0",
  37: "#cccccc",
  90: "#868686",
  91: "#f48771",
  92: "#89d185",
  93: "#cca700",
  94: "#75beff",
  95: "#d670d6",
  96: "#29b8db",
  97: "#ffffff",
};

const ANSI_SGR_OR_CONTROL_RE =
  /\x1b\[([0-9;]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const URL_FIND_RE = /https?:\/\/[^\s<>"'`]+/g;

function trimTrailingUrlPunctuation(raw: string): string {
  return raw.replace(/[),.;:!?\]}>]+$/, "");
}

function collectPlainUrls(plain: string): Array<{ start: number; end: number; url: string }> {
  const hits: Array<{ start: number; end: number; url: string }> = [];
  if (!plain) return hits;
  URL_FIND_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_FIND_RE.exec(plain)) !== null) {
    const cleaned = trimTrailingUrlPunctuation(m[0]);
    if (cleaned.length > 0) {
      hits.push({
        start: m.index,
        end: m.index + cleaned.length,
        url: cleaned,
      });
    }
  }
  return hits;
}

/**
 * 将一行带 ANSI 转义序列的日志文本拆分为保留颜色、样式与完整 URL 链接的片段列表。
 * 先还原完整纯文本匹配 URL（如 Vite 会在端口处插入加粗 ANSI 码 `\x1b[1m8889\x1b[22m`），
 * 再按位置叠加回各样式片段，确保协议、域名、端口与路径识别为完整可点击链接。
 */
export function parseAnsiLine(line: string): AnsiSegment[] {
  const rawSpans: Array<{ text: string; style: AnsiStyle }> = [];
  let currentStyle: AnsiStyle = {};
  let lastIdx = 0;
  ANSI_SGR_OR_CONTROL_RE.lastIndex = 0;

  let m: RegExpExecArray | null;
  while ((m = ANSI_SGR_OR_CONTROL_RE.exec(line)) !== null) {
    if (m.index > lastIdx) {
      rawSpans.push({
        text: line.slice(lastIdx, m.index),
        style: currentStyle,
      });
    }

    const paramsRaw = m[1];
    const cmd = m[2];
    if (cmd === "m") {
      const codes =
        paramsRaw === ""
          ? [0]
          : paramsRaw.split(";").map((s) => parseInt(s, 10) || 0);
      const next = { ...currentStyle };
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        if (c === 0) {
          next.fg = undefined;
          next.bold = false;
          next.dim = false;
          next.underline = false;
        } else if (c === 1) {
          next.bold = true;
        } else if (c === 2) {
          next.dim = true;
        } else if (c === 4) {
          next.underline = true;
        } else if (c === 22) {
          next.bold = false;
          next.dim = false;
        } else if (c === 24) {
          next.underline = false;
        } else if (c === 39) {
          next.fg = undefined;
        } else if (STANDARD_COLORS[c]) {
          next.fg = STANDARD_COLORS[c];
        } else if (c === 38 && codes[i + 1] === 2 && i + 4 < codes.length) {
          next.fg = `rgb(${codes[i + 2]}, ${codes[i + 3]}, ${codes[i + 4]})`;
          i += 4;
        } else if (c === 38 && codes[i + 1] === 5 && i + 2 < codes.length) {
          i += 2;
        }
      }
      currentStyle = next;
    }

    lastIdx = m.index + m[0].length;
  }

  if (lastIdx < line.length) {
    rawSpans.push({
      text: line.slice(lastIdx),
      style: currentStyle,
    });
  }

  if (rawSpans.length === 0) {
    return [];
  }

  const plainText = rawSpans.map((s) => s.text).join("");
  const urls = collectPlainUrls(plainText);
  if (urls.length === 0) {
    return rawSpans;
  }

  const out: AnsiSegment[] = [];
  let cursor = 0;
  for (const span of rawSpans) {
    const spanStart = cursor;
    const spanEnd = cursor + span.text.length;
    cursor = spanEnd;

    let pos = spanStart;
    for (const u of urls) {
      if (u.end <= pos) continue;
      if (u.start >= spanEnd) break;

      const ovStart = Math.max(pos, u.start);
      const ovEnd = Math.min(spanEnd, u.end);

      if (ovStart > pos) {
        out.push({
          text: span.text.slice(pos - spanStart, ovStart - spanStart),
          style: span.style,
        });
      }
      if (ovEnd > ovStart) {
        out.push({
          text: span.text.slice(ovStart - spanStart, ovEnd - spanStart),
          style: { ...span.style, underline: true },
          url: u.url,
        });
      }
      pos = ovEnd;
    }

    if (pos < spanEnd) {
      out.push({
        text: span.text.slice(pos - spanStart),
        style: span.style,
      });
    }
  }

  return out;
}
