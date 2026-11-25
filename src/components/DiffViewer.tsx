/**
 * 双栏 / 内联 diff 查看器（M0 轻量实现）。
 */

import { memo, useMemo, type ReactNode } from "react";
import { Plus, Minus, Undo2 } from "lucide-react";
import type { FileDiff, Hunk, HunkLine } from "../types";
import { IconButton } from "./IconButton";

interface Props {
  diff: FileDiff | null;
  loading: boolean;
  onStageHunk?: (hunkIndex: number) => void;
  onUnstageHunk?: (hunkIndex: number) => void;
  onDiscardHunk?: (hunkIndex: number) => void;
}

function lineBgClass(kind: HunkLine["kind"]): string {
  if (kind === "addition") return "bg-[rgba(155,185,85,0.16)]";
  if (kind === "deletion") return "bg-[rgba(255,0,0,0.16)]";
  return "bg-[#1f1f1f]";
}

function gutter(n: number | null): string {
  return n === null ? "" : String(n);
}

interface SplitRow {
  left: HunkLine | null;
  right: HunkLine | null;
}

function toSplitRows(hunk: Hunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let pendingDeletions: HunkLine[] = [];

  const flush = (next: HunkLine | null) => {
    const dels = pendingDeletions;
    pendingDeletions = [];
    const max = Math.max(dels.length, next ? 1 : 0);
    for (let i = 0; i < max; i++) {
      rows.push({ left: dels[i] ?? null, right: i === 0 ? next : null });
    }
  };

  for (const line of hunk.lines) {
    if (line.kind === "deletion") {
      pendingDeletions.push(line);
    } else if (line.kind === "addition") {
      const dels = pendingDeletions;
      pendingDeletions = [];
      const consumed = dels.shift();
      if (consumed) rows.push({ left: consumed, right: line });
      else rows.push({ left: null, right: line });
      if (dels.length) rows.push(...dels.map((d) => ({ left: d, right: null })));
    } else {
      flush(line);
    }
  }
  if (pendingDeletions.length) {
    rows.push(...pendingDeletions.map((d) => ({ left: d, right: null })));
  }
  return rows;
}

function HunkHeader({
  hunk,
  actions,
}: {
  hunk: Hunk;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-1 bg-[#181818] border-y border-[#2b2b2b] text-[11.5px]">
      <span className="font-mono text-[#9d9d9d]">{hunk.header}</span>
      <span className="flex items-center gap-1.5 font-mono">
        {hunk.additions > 0 && <span className="text-[#73c991]">+{hunk.additions}</span>}
        {hunk.deletions > 0 && <span className="text-[#c74e39]">-{hunk.deletions}</span>}
      </span>
      {actions && <span className="flex items-center gap-1.5 ml-auto">{actions}</span>}
    </div>
  );
}

export const DiffViewer = memo(function DiffViewer({
  diff,
  loading,
  onStageHunk,
  onUnstageHunk,
  onDiscardHunk,
}: Props) {
  const canStage = diff?.area === "unstaged" && !!onStageHunk;
  const canUnstage = diff?.area === "staged" && !!onUnstageHunk;
  const canDiscard = diff?.area === "unstaged" && !!onDiscardHunk && diff.status !== "untracked";

  const header = useMemo(() => {
    if (!diff) return "";
    return `${diff.path}  +${diff.additions} -${diff.deletions}`;
  }, [diff]);

  if (loading) {
    return (
      <div className="flex items-center justify-center flex-1 h-full bg-[#1f1f1f] text-[#868686] text-[13px]">
        加载中…
      </div>
    );
  }

  if (!diff) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 h-full bg-[#1f1f1f] text-[#868686] text-[13px] gap-1">
        <p className="m-0 text-[#cccccc]">选择一个变更文件查看 diff</p>
        <p className="m-0 text-[12px] text-[#868686]">在左侧 Source Control 中点击文件名</p>
      </div>
    );
  }

  if (diff.binary) {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-[#1f1f1f]">
        <div className="flex items-center justify-between px-3 py-1.5 bg-[#181818] border-b border-[#2b2b2b] text-[12px]">
          <span className="font-mono text-[#cccccc] truncate">{diff.path}</span>
          <span className="px-1.5 py-0.5 text-[10.5px] rounded-[3px] bg-[#252526] border border-[#3c3c3c] text-[#9d9d9d]">
            二进制文件
          </span>
        </div>
        <div className="flex items-center justify-center flex-1 text-[#868686] text-[13px]">
          二进制文件无法以文本方式预览
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-[#1f1f1f]">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#181818] border-b border-[#2b2b2b] shrink-0">
        <span className="font-mono text-[12px] text-[#cccccc] truncate" title={diff.path}>
          {header}
        </span>
      </div>

      {diff.hunks.length === 0 ? (
        <div className="flex items-center justify-center flex-1 text-[#868686] text-[13px]">
          {diff.status === "untracked" ? "未跟踪的新文件" : "没有文本差异"}
        </div>
      ) : (
        <div className="flex-1 overflow-auto min-h-0 font-mono text-[12.5px] leading-[20px]">
          {diff.hunks.map((hunk) => {
            const actions = (
              <>
                {canStage && (
                  <IconButton
                    size="xs"
                    tooltip="暂存该变更块"
                    icon={<Plus size={12} strokeWidth={2} />}
                    onClick={() => onStageHunk?.(hunk.index)}
                  />
                )}
                {canUnstage && (
                  <IconButton
                    size="xs"
                    tooltip="取消暂存该变更块"
                    icon={<Minus size={12} strokeWidth={2} />}
                    onClick={() => onUnstageHunk?.(hunk.index)}
                  />
                )}
                {canDiscard && (
                  <IconButton
                    size="xs"
                    variant="danger"
                    align="right"
                    tooltip="放弃该变更块"
                    icon={<Undo2 size={11.5} strokeWidth={1.85} />}
                    onClick={() => onDiscardHunk?.(hunk.index)}
                  />
                )}
              </>
            );

            const rows = toSplitRows(hunk);
            return (
              <div key={hunk.index}>
                <HunkHeader hunk={hunk} actions={actions} />
                <div>
                  {rows.map((row, i) => (
                    <div className="grid grid-cols-2 min-h-[20px]" key={i}>
                      <div
                        className={`flex min-w-0 border-r border-[#2b2b2b] ${
                          row.left ? lineBgClass(row.left.kind) : "bg-diff-hatch"
                        }`}
                      >
                        <span className="w-[46px] shrink-0 text-right pr-2.5 text-[#6e7681] select-none text-[11.5px]">
                          {gutter(row.left?.old_lineno ?? null)}
                        </span>
                        <span className="flex-1 whitespace-pre px-2 text-[#cccccc] overflow-hidden">
                          {row.left?.content ?? ""}
                        </span>
                      </div>
                      <div
                        className={`flex min-w-0 ${
                          row.right ? lineBgClass(row.right.kind) : "bg-diff-hatch"
                        }`}
                      >
                        <span className="w-[46px] shrink-0 text-right pr-2.5 text-[#6e7681] select-none text-[11.5px]">
                          {gutter(row.right?.new_lineno ?? null)}
                        </span>
                        <span className="flex-1 whitespace-pre px-2 text-[#cccccc] overflow-hidden">
                          {row.right?.content ?? ""}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
