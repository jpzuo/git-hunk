/**
 * 提交审查页（备用组件，VS Code Dark Modern 100% 原子化实现）
 */

import type { CommitDetail, FilePair } from "../historyTypes";
import { ArrowLeft, Tag } from "lucide-react";
import { FileTree } from "./FileTree";
import { SideBySideDiff } from "./SideBySideDiff";
import { IconButton } from "./IconButton";

interface Props {
  detail: CommitDetail | null;
  detailLoading: boolean;
  pair: FilePair | null;
  pairLoading: boolean;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  onBack: () => void;
  onCreateTag?: (oid: string) => void;
}

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function CommitReviewPage({
  detail,
  detailLoading,
  pair,
  pairLoading,
  selectedPath,
  onSelectFile,
  onBack,
  onCreateTag,
}: Props) {
  return (
    <div className="flex flex-col h-full min-h-0 bg-[#1f1f1f]">
      <header className="flex items-center gap-3.5 px-3.5 py-2.5 bg-[#181818] border-b border-[#2b2b2b] shrink-0">
        <IconButton
          tooltip="返回提交图 (Esc)"
          variant="surface"
          icon={<ArrowLeft size={13} strokeWidth={1.75} />}
          onClick={onBack}
        />
        <div className="flex-1 min-w-0">
          {detailLoading && !detail ? (
            <span className="text-[#868686] text-[12px]">加载提交信息…</span>
          ) : detail ? (
            <>
              <div className="flex items-baseline gap-2.5 min-w-0">
                <span className="text-[14px] font-semibold text-white truncate">{detail.summary}</span>
                <span className="font-mono text-[11.5px] text-[#868686] shrink-0">{detail.short_oid}</span>
                {onCreateTag && (
                  <IconButton
                    size="xs"
                    variant="surface"
                    tooltip={`在此提交 (${detail.short_oid}) 上新建标签`}
                    icon={<Tag size={12} strokeWidth={1.75} />}
                    onClick={() => onCreateTag(detail.oid)}
                  />
                )}
                {detail.parents.length > 1 && (
                  <span className="px-1.5 py-0.5 text-[10px] rounded-[3px] bg-[#252526] text-[#9d9d9d] border border-[#3c3c3c]">
                    合并提交 · {detail.parents.length} 个父
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 mt-1 text-[11.5px] text-[#cccccc] flex-wrap">
                <span>{detail.author_name}</span>
                <span className="text-[#868686]">{formatDate(detail.timestamp)}</span>
                <span className="text-[#868686]">{detail.file_count} 个文件变更</span>
                {detail.additions > 0 && (
                  <span className="font-mono text-[#73c991]">+{detail.additions}</span>
                )}
                {detail.deletions > 0 && (
                  <span className="font-mono text-[#c74e39]">-{detail.deletions}</span>
                )}
              </div>
            </>
          ) : (
            <span className="text-[#868686] text-[12px]">未选择提交</span>
          )}
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        <aside className="w-[272px] min-w-[200px] shrink-0 border-r border-[#2b2b2b] bg-[#181818] flex flex-col min-h-0">
          <FileTree
            files={detail?.files ?? []}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
            title="本提交变更"
          />
        </aside>
        <section className="flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden">
          {detail && detail.files.length === 0 ? (
            <div className="flex flex-col items-center justify-center flex-1 text-[#868686] text-[13px] gap-1">
              <p className="m-0 text-[#cccccc]">该提交没有文件变更</p>
              <p className="m-0 text-[12px]">例如空提交或仅修改了提交信息</p>
            </div>
          ) : (
            <SideBySideDiff pair={pair} loading={pairLoading} />
          )}
        </section>
      </div>
    </div>
  );
}
