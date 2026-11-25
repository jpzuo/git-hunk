/**
 * 文件内 / 差异对比内悬浮查找框（100% 对标 VS Code Find Widget，Tailwind v4 + Dark Modern）。
 */

import React, { useEffect, useRef } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { IconButton } from "./IconButton";
import type { FindQueryOptions } from "../utils/inFileSearch";

interface Props {
  open: boolean;
  options: FindQueryOptions;
  onOptionsChange: (next: FindQueryOptions) => void;
  totalMatches: number;
  activeIndex: number;
  regexError: string | null;
  focusNonce: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}

export const FindWidget = React.memo(function FindWidget({
  open,
  options,
  onOptionsChange,
  totalMatches,
  activeIndex,
  regexError,
  focusNonce,
  onNext,
  onPrev,
  onClose,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (el.value) {
      el.select();
    }
  }, [open, focusNonce]);

  if (!open) return null;

  const hasQuery = options.query.length > 0;
  const noMatches = hasQuery && !regexError && totalMatches === 0;
  const counterText = !hasQuery
    ? "无结果"
    : regexError
      ? "正则错误"
      : totalMatches === 0
        ? "无结果"
        : `${activeIndex + 1} / ${totalMatches}`;

  return (
    <div
      className="absolute right-5 top-1.5 z-30 flex flex-col rounded-[4px] border border-[#454545] border-l-2 border-l-[#0078d4] bg-[#252526] px-2 py-1.5 text-[#cccccc] shadow-[0_6px_22px_rgba(0,0,0,0.6)]"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1.5">
        <div
          className={`flex h-[26px] w-[248px] items-center rounded-[2px] border bg-[#313131] pl-2 pr-1 ${
            regexError
              ? "border-[#be1100]"
              : "border-[#3c3c3c] focus-within:border-[#0078d4]"
          }`}
        >
          <input
            ref={inputRef}
            type="text"
            value={options.query}
            onChange={(e) => onOptionsChange({ ...options, query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                if (e.shiftKey) onPrev();
                else onNext();
              } else if (e.key === "F3") {
                e.preventDefault();
                e.stopPropagation();
                if (e.shiftKey) onPrev();
                else onNext();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onClose();
              } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "f") {
                e.preventDefault();
                e.stopPropagation();
                inputRef.current?.select();
              }
            }}
            placeholder="查找 (Enter 下一个 · Shift+Enter 上一个)…"
            className="min-w-0 flex-1 border-none bg-transparent text-[12px] text-[#cccccc] placeholder-[#868686] outline-none"
          />

          <div className="flex shrink-0 items-center gap-0.5 pl-1">
            <button
              type="button"
              title="区分大小写 (Aa)"
              aria-pressed={options.caseSensitive}
              className={`flex h-[20px] min-w-[20px] cursor-pointer items-center justify-center rounded-[2px] px-1 font-mono text-[10.5px] font-semibold transition-colors ${
                options.caseSensitive
                  ? "border border-[#0078d4] bg-[#0078d4]/25 text-[#75beff]"
                  : "border border-transparent bg-transparent text-[#868686] hover:bg-[#3c3c3c] hover:text-white"
              }`}
              onClick={() =>
                onOptionsChange({ ...options, caseSensitive: !options.caseSensitive })
              }
            >
              Aa
            </button>
            <button
              type="button"
              title="全词匹配 (ab)"
              aria-pressed={options.wholeWord}
              className={`flex h-[20px] min-w-[20px] cursor-pointer items-center justify-center rounded-[2px] px-1 font-mono text-[10.5px] font-semibold underline decoration-1 underline-offset-2 transition-colors ${
                options.wholeWord
                  ? "border border-[#0078d4] bg-[#0078d4]/25 text-[#75beff]"
                  : "border border-transparent bg-transparent text-[#868686] hover:bg-[#3c3c3c] hover:text-white"
              }`}
              onClick={() => onOptionsChange({ ...options, wholeWord: !options.wholeWord })}
            >
              ab
            </button>
            <button
              type="button"
              title="使用正则表达式 (.*)"
              aria-pressed={options.useRegex}
              className={`flex h-[20px] min-w-[20px] cursor-pointer items-center justify-center rounded-[2px] px-1 font-mono text-[10.5px] font-semibold transition-colors ${
                options.useRegex
                  ? "border border-[#0078d4] bg-[#0078d4]/25 text-[#75beff]"
                  : "border border-transparent bg-transparent text-[#868686] hover:bg-[#3c3c3c] hover:text-white"
              }`}
              onClick={() => onOptionsChange({ ...options, useRegex: !options.useRegex })}
            >
              .*
            </button>
          </div>
        </div>

        <span
          className={`min-w-[54px] select-none px-1 text-center text-[11px] tabular-nums ${
            noMatches || regexError ? "text-[#f48771]" : "text-[#9d9d9d]"
          }`}
        >
          {hasQuery ? counterText : ""}
        </span>

        <div className="flex items-center gap-0.5">
          <IconButton
            tooltip="上一个匹配项 (Shift+Enter / Shift+F3)"
            size="xs"
            disabled={totalMatches === 0}
            icon={<ArrowUp size={13} />}
            onClick={onPrev}
          />
          <IconButton
            tooltip="下一个匹配项 (Enter / F3)"
            size="xs"
            disabled={totalMatches === 0}
            icon={<ArrowDown size={13} />}
            onClick={onNext}
          />
          <IconButton
            tooltip="关闭 (Esc)"
            size="xs"
            align="right"
            icon={<X size={13} />}
            onClick={onClose}
          />
        </div>
      </div>

      {regexError && (
        <div className="mt-1 max-w-[380px] truncate rounded-[2px] bg-[#5a1d1d] px-2 py-0.5 text-[11px] text-[#f48771]">
          {regexError}
        </div>
      )}
    </div>
  );
});
