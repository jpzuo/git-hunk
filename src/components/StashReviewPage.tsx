/**
 * Stash 储藏审查页（VS Code Dark Modern 100% 原子化实现）
 */

import type { StashInfo } from "../types";
import type { CommitDetail, FilePair } from "../historyTypes";
import { Archive, ArchiveRestore, Check, GitBranch, Trash2 } from "lucide-react";
import { FileTree } from "./FileTree";
import { SideBySideDiff } from "./SideBySideDiff";
import { IconButton } from "./IconButton";

interface Props {
  stash: StashInfo | null;
  detail: CommitDetail | null;
  detailLoading: boolean;
  pair: FilePair | null;
  pairLoading: boolean;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  onPop: (index: number) => void;
  onApply: (index: number) => void;
  onDrop: (stash: StashInfo) => void;
  onBranch: (stash: StashInfo) => void;
}

function formatDate(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function StashReviewPage({
  stash,
  detail,
  detailLoading,
  pair,
  pairLoading,
  selectedPath,
  onSelectFile,
  onPop,
  onApply,
  onDrop,
  onBranch,
}: Props) {
  if (!stash) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 h-full bg-[#1f1f1f] text-[#868686] px-6 text-center">
        <Archive size={48} strokeWidth={1.2} className="text-[#868686] opacity-75 mb-3" />
        <h3 className="m-0 mb-1.5 text-[16px] font-semibold text-[#cccccc]">
          查看 Stash 储藏内容与差异
        </h3>
        <p className="m-0 text-[13px] text-[#868686] max-w-[420px]">
          点击左侧 Stash 列表中的任意储藏记录，即可在此预览其变更文件树与详细代码 Diff。
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-[#1f1f1f]">
      <header className="flex items-center justify-between gap-4 px-4 py-2.5 bg-[#181818] border-b border-[#2b2b2b] shrink-0 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="px-2 py-0.5 rounded-[3px] bg-[#252526] text-[#cccccc] border border-[#3c3c3c] font-mono text-[11.5px] font-semibold shrink-0">
              stash@{`{${stash.index}}`}
            </span>
            <span className="text-[14px] font-semibold text-white truncate">
              {stash.message || "（未提供说明）"}
            </span>
            <span
              className="font-mono text-[11.5px] text-[#868686] shrink-0"
              title="储藏对应 Commit OID"
            >
              {stash.oid.slice(0, 7)}
            </span>
          </div>

          <div className="flex items-center gap-3 mt-1 text-[11.5px] text-[#868686] flex-wrap">
            {detailLoading && !detail ? (
              <span>正在读取储藏文件差异…</span>
            ) : detail ? (
              <>
                <span>{formatDate(stash.timestamp)}</span>
                <span>{detail.file_count} 个修改文件</span>
                {detail.additions > 0 && (
                  <span className="font-mono text-[#73c991]">+{detail.additions}</span>
                )}
                {detail.deletions > 0 && (
                  <span className="font-mono text-[#c74e39]">-{detail.deletions}</span>
                )}
              </>
            ) : (
              <span>{formatDate(stash.timestamp)}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <IconButton
            tooltip="应用并删除储藏 (git stash pop)"
            icon={<ArchiveRestore size={13} strokeWidth={1.85} />}
            onClick={() => onPop(stash.index)}
          />
          <IconButton
            tooltip="仅应用储藏 (git stash apply)"
            icon={<Check size={13} strokeWidth={2} />}
            onClick={() => onApply(stash.index)}
          />
          <IconButton
            tooltip="基于储藏新建分支 (git stash branch)"
            icon={<GitBranch size={13} strokeWidth={1.75} />}
            onClick={() => onBranch(stash)}
          />
          <IconButton
            tooltip="永久丢弃此储藏 (git stash drop)"
            variant="danger"
            align="right"
            icon={<Trash2 size={13} strokeWidth={1.75} />}
            onClick={() => onDrop(stash)}
          />
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        <aside className="w-[272px] min-w-[200px] shrink-0 border-r border-[#2b2b2b] bg-[#181818] flex flex-col min-h-0">
          <FileTree
            files={detail?.files ?? []}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
            title="储藏的文件修改"
          />
        </aside>
        <section className="flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden">
          {detail && detail.files.length === 0 ? (
            <div className="flex items-center justify-center flex-1 text-[#868686] text-[13px]">
              该储藏中没有检测到文件变更
            </div>
          ) : (
            <SideBySideDiff pair={pair} loading={pairLoading} />
          )}
        </section>
      </div>
    </div>
  );
}
