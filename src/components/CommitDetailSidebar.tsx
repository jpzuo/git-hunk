/**
 * 提交详情侧栏面板 (CommitDetailSidebar) —— VS Code Dark Modern 100% 原子化实现
 */

import React from "react";
import { GitCommitHorizontal, Tag } from "lucide-react";
import type { CommitDetail } from "../historyTypes";
import { FileTree } from "./FileTree";
import { IconButton } from "./IconButton";

interface Props {
  detail: CommitDetail | null;
  loading: boolean;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  onCreateTag?: (oid: string) => void;
}

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export const CommitDetailSidebar = React.memo(function CommitDetailSidebar({
  detail,
  loading,
  selectedPath,
  onSelectFile,
  onCreateTag,
}: Props) {
  return (
    <div className="flex flex-col h-full min-h-0 bg-[#181818]">
      <div className="flex items-center justify-between px-3 h-[35px] border-b border-[#2b2b2b] shrink-0">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#cccccc]">
          <GitCommitHorizontal size={14} className="text-[#9d9d9d]" />
          <span>提交详情</span>
          {detail && (
            <span className="font-mono text-[11px] px-1.5 py-0.5 rounded-[3px] bg-[#252526] text-[#cccccc] border border-[#3c3c3c] normal-case">
              {detail.short_oid}
            </span>
          )}
        </div>
        {detail && onCreateTag && (
          <div className="flex items-center gap-0.5">
            <IconButton
              tooltip={`在 ${detail.short_oid} 上新建标签`}
              align="right"
              icon={<Tag size={13} />}
              onClick={() => onCreateTag(detail.oid)}
            />
          </div>
        )}
      </div>

      {loading && !detail ? (
        <div className="py-7 px-4 text-center text-[#868686] text-[12px]">正在加载提交详情…</div>
      ) : detail ? (
        <>
          <div className="px-3 py-2.5 border-b border-[#2b2b2b] bg-[#202020] shrink-0">
            <div className="text-[12.5px] font-semibold text-white leading-snug mb-1.5 break-words" title={detail.message}>
              {detail.summary || "(无提交信息)"}
            </div>
            <div className="flex items-center flex-wrap gap-2 text-[11px] text-[#868686]">
              <span className="text-[#cccccc]">{detail.author_name}</span>
              <span>{formatDate(detail.timestamp)}</span>
              {detail.parents.length > 1 && (
                <span className="px-1.5 py-0.5 text-[10px] rounded-[3px] bg-[#252526] text-[#9d9d9d] border border-[#3c3c3c] font-medium">
                  合并 · {detail.parents.length} 父
                </span>
              )}
            </div>
          </div>

          <div className="flex-1 min-h-0 flex flex-col">
            <FileTree
              files={detail.files}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
              title="本提交变更"
            />
          </div>
        </>
      ) : (
        <div className="py-7 px-4 text-center text-[#868686] text-[12px]">暂无提交记录</div>
      )}
    </div>
  );
});
