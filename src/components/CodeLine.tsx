/** 单行代码渲染：把 Shiki token 转成带颜色的 span，支持叠加词内查找高亮。 */

import React from "react";
import type { LineTokens } from "../highlighter";

export interface CodeHighlightRange {
  start: number;
  end: number;
  active?: boolean;
}

interface Props {
  tokens: LineTokens | null;
  fallback: string;
  highlights?: CodeHighlightRange[];
}

const FONT_ITALIC = 1;
const FONT_BOLD = 2;
const FONT_UNDERLINE = 4;

function renderHighlightedSegment(
  text: string,
  segStart: number,
  highlights: CodeHighlightRange[] | undefined,
  style: React.CSSProperties | undefined,
  keyPrefix: string | number,
): React.ReactNode {
  if (!highlights || highlights.length === 0) {
    return style ? (
      <span key={keyPrefix} style={style}>
        {text}
      </span>
    ) : (
      <span key={keyPrefix}>{text}</span>
    );
  }

  const segEnd = segStart + text.length;
  const parts: React.ReactNode[] = [];
  let cursor = segStart;

  for (let idx = 0; idx < highlights.length; idx++) {
    const h = highlights[idx];
    if (h.end <= cursor) continue;
    if (h.start >= segEnd) break;

    const ovStart = Math.max(cursor, h.start);
    const ovEnd = Math.min(segEnd, h.end);

    if (ovStart > cursor) {
      parts.push(
        <span key={`${keyPrefix}-p-${idx}`} style={style}>
          {text.slice(cursor - segStart, ovStart - segStart)}
        </span>,
      );
    }

    if (ovEnd > ovStart) {
      parts.push(
        <span
          key={`${keyPrefix}-m-${idx}`}
          data-active-match={h.active ? "true" : undefined}
          style={style}
          className={
            h.active
              ? "rounded-[2px] bg-[#9e6a03]/85 ring-1 ring-[#f8c555]/90"
              : "rounded-[2px] bg-[#613214]/90"
          }
        >
          {text.slice(ovStart - segStart, ovEnd - segStart)}
        </span>,
      );
    }

    cursor = ovEnd;
  }

  if (cursor < segEnd) {
    parts.push(
      <span key={`${keyPrefix}-t`} style={style}>
        {text.slice(cursor - segStart)}
      </span>,
    );
  }

  return <React.Fragment key={keyPrefix}>{parts}</React.Fragment>;
}

export const CodeLine = React.memo(function CodeLine({
  tokens,
  fallback,
  highlights,
}: Props) {
  if (!tokens) {
    const text = fallback || " ";
    if (!highlights || highlights.length === 0) {
      return <>{text}</>;
    }
    return <>{renderHighlightedSegment(text, 0, highlights, undefined, "plain")}</>;
  }

  if (tokens.length === 0) {
    return <> </>;
  }

  let cursor = 0;
  return (
    <>
      {tokens.map((t, i) => {
        const segStart = cursor;
        cursor += t.content.length;

        const hasStyle = Boolean(t.color || t.fontStyle);
        let style: React.CSSProperties | undefined;
        if (hasStyle) {
          style = {};
          if (t.color) style.color = t.color;
          if (t.fontStyle) {
            if (t.fontStyle & FONT_ITALIC) style.fontStyle = "italic";
            if (t.fontStyle & FONT_BOLD) style.fontWeight = "bold";
            if (t.fontStyle & FONT_UNDERLINE) style.textDecoration = "underline";
          }
        }

        if (!highlights || highlights.length === 0) {
          if (!style) return <span key={i}>{t.content}</span>;
          return (
            <span key={i} style={style}>
              {t.content}
            </span>
          );
        }

        return renderHighlightedSegment(t.content, segStart, highlights, style, i);
      })}
    </>
  );
});
