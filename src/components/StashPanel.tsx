/**
 * Stash 工作区储藏面板（VS Code Dark Modern 100% 原子化实现）
 */

import { memo, useMemo, useState } from "react";
import { Archive, RefreshCw, Trash2, X } from "lucide-react";
import type { StashInfo } from "../types";

interface Props {
  stashes: StashInfo[];
  selectedStashOid: string | null;
  loading: boolean;
  hasChanges: boolean;
  onRefresh: () => Promise<void>;
  onSelectStash: (stash: StashInfo) => void;
  onSave: (
    message: string,
    includeUntracked: boolean,
    keepIndex: boolean,
  ) => Promise<void>;
  onClear: () => Promise<void>;
}

function formatDate(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export const StashPanel = memo(function StashPanel({
  stashes,
  selectedStashOid,
  loading,
  hasChanges,
  onRefresh,
  onSelectStash,
  onSave,
  onClear,
}: Props) {
  const [filter, setFilter] = useState("");
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [keepIndex, setKeepIndex] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearingAll, setClearingAll] = useState(false);

  const filteredStashes = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return stashes;
    return stashes.filter(
      (s) =>
        s.message.toLowerCase().includes(q) ||
        `stash@{${s.index}}`.includes(q) ||
        String(s.index) === q ||
        formatDate(s.timestamp).toLowerCase().includes(q),
    );
  }, [stashes, filter]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave(message.trim(), includeUntracked, keepIndex);
      setMessage("");
    } finally {
      setSaving(false);
    }
  };

  const handleClearConfirm = async () => {
    setClearingAll(false);
    await onClear();
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#181818]">
      <div className="flex items-center justify-between px-3 h-[35px] border-b border-[#2b2b2b] shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[#cccccc]">
            Stash 储藏
          </span>
          <span className="px-1.5 py-0.5 rounded-full bg-[#313131] text-[#cccccc] text-[10px] leading-none font-semibold">
            {stashes.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {stashes.length > 0 && (
            <button
              type="button"
              className="inline-flex items-center gap-1 h-[22px] px-2 text-[11px] rounded-[2px] bg-transparent border border-transparent text-[#f14c4c] hover:bg-[#f14c4c]/15 cursor-pointer"
              title="清空所有储藏记录 (Clear All)"
              onClick={() => setClearingAll(true)}
            >
              <Trash2 size={12} strokeWidth={1.75} />
              <span>清空</span>
            </button>
          )}
          <button
            type="button"
            className="flex items-center justify-center w-[22px] h-[22px] rounded-[4px] border-none bg-transparent text-[#cccccc] hover:bg-[#2a2d2e] hover:text-white cursor-pointer p-0"
            title="刷新 Stash 列表"
            disabled={loading}
            onClick={() => void onRefresh()}
          >
            <RefreshCw size={12} strokeWidth={1.75} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      <div className="px-2.5 py-1.5 border-b border-[#2b2b2b] bg-[#181818] shrink-0">
        <div className="flex items-center bg-[#313131] border border-[#3c3c3c] focus-within:border-[#0078d4] rounded-[2px] px-2 h-[26px]">
          <input
            type="text"
            className="border-none bg-transparent text-[#cccccc] placeholder-[#868686] text-[12px] w-full outline-none"
            placeholder="过滤储藏说明、索引或时间..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {filter && (
            <button
              type="button"
              className="flex items-center justify-center border-none bg-transparent text-[#9d9d9d] hover:text-white p-0.5 cursor-pointer"
              onClick={() => setFilter("")}
            >
              <X size={12} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>

      <form
        className="px-2.5 py-2.5 border-b border-[#2b2b2b] bg-[#202020] flex flex-col gap-2 shrink-0"
        onSubmit={handleSave}
      >
        <div className="text-[11px] font-semibold text-[#9d9d9d]">储藏未提交变更</div>
        <input
          type="text"
          className="w-full bg-[#313131] text-[#cccccc] placeholder-[#868686] border border-[#3c3c3c] focus:border-[#0078d4] outline-none rounded-[2px] px-2 py-1 text-[12px]"
          placeholder="储藏说明（可选，如 wip: refactor auth）"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <div className="flex flex-col gap-1">
          <label
            className="inline-flex items-center gap-1.5 text-[11.5px] text-[#cccccc] cursor-pointer select-none"
            title="包含新添加但尚未 git add 的文件"
          >
            <input
              type="checkbox"
              checked={includeUntracked}
              onChange={(e) => setIncludeUntracked(e.target.checked)}
              className="accent-[#0078d4]"
            />
            <span>包含未跟踪文件 (-u)</span>
          </label>
          <label
            className="inline-flex items-center gap-1.5 text-[11.5px] text-[#cccccc] cursor-pointer select-none"
            title="储藏未暂存修改的同时，保留暂存区的已暂存状态"
          >
            <input
              type="checkbox"
              checked={keepIndex}
              onChange={(e) => setKeepIndex(e.target.checked)}
              className="accent-[#0078d4]"
            />
            <span>保留暂存区 (--keep-index)</span>
          </label>
        </div>
        <button
          type="submit"
          className="w-full h-[28px] inline-flex items-center justify-center gap-1.5 rounded-[2px] bg-[#0078d4] hover:bg-[#026ec1] disabled:bg-[#0078d4]/45 disabled:text-white/50 disabled:cursor-default text-white text-[12px] font-medium border-none cursor-pointer transition-colors"
          disabled={saving || !hasChanges}
          title={hasChanges ? "保存当前修改到 Stash" : "工作区无变更可储藏"}
        >
          <Archive size={13} strokeWidth={1.75} />
          <span>{saving ? "正在储藏…" : "储藏当前工作区变更"}</span>
        </button>
      </form>

      <div className="flex-1 overflow-y-auto min-h-0 py-1">
        {filteredStashes.length === 0 ? (
          <div className="py-8 px-4 text-center text-[#868686] text-[12px]">
            {filter ? "无匹配的储藏记录" : "暂无 Stash 储藏记录"}
          </div>
        ) : (
          filteredStashes.map((s) => {
            const isSelected = selectedStashOid === s.oid;
            return (
              <div
                key={s.oid || s.index}
                className={`px-3 py-2 border-b border-[#2b2b2b]/60 cursor-pointer select-none transition-colors ${
                  isSelected
                    ? "bg-[#04395e] text-white"
                    : "text-[#cccccc] hover:bg-[#2a2d2e]"
                }`}
                onClick={() => onSelectStash(s)}
                title="点击在右侧详情中查看代码差异与执行 Pop / Apply / 检出 / Drop 操作"
              >
                <div className="flex items-center justify-between mb-1">
                  <span
                    className={`font-mono text-[11px] font-semibold ${
                      isSelected ? "text-white" : "text-[#9d9d9d]"
                    }`}
                  >
                    stash@{`{${s.index}}`}
                  </span>
                  <span className={`text-[11px] ${isSelected ? "text-white/75" : "text-[#868686]"}`}>
                    {formatDate(s.timestamp)}
                  </span>
                </div>
                <div className="text-[12px] truncate">
                  {s.message || "（无说明）"}
                </div>
              </div>
            );
          })
        )}
      </div>

      {clearingAll && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55"
          onClick={() => setClearingAll(false)}
        >
          <div
            className="w-[420px] max-w-[90vw] bg-[#252526] border border-[#454545] rounded-[6px] p-4 shadow-[0_12px_36px_rgba(0,0,0,0.7)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[14px] font-semibold text-white mb-2">清空所有储藏 (Clear All)</div>
            <p className="text-[12.5px] text-[#cccccc] mb-2 mt-0">
              确定要清空仓库中全部的 <strong className="text-white">{stashes.length}</strong> 条 Stash 储藏记录吗？
            </p>
            <p className="text-[12px] text-[#f14c4c] mb-4 mt-0 leading-relaxed">
              警告：所有历史储藏的代码快照将被永久删除且无法恢复，请确保没有需要保留的重要未提交代码！
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="px-3 py-1.5 text-[12px] rounded-[2px] bg-[#313131] hover:bg-[#3c3c3c] text-[#cccccc] border border-[#3c3c3c] cursor-pointer"
                onClick={() => setClearingAll(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="px-3 py-1.5 text-[12px] rounded-[2px] bg-[#c74e39] hover:bg-[#e45b43] text-white border-none cursor-pointer font-medium"
                onClick={() => void handleClearConfirm()}
              >
                确定清空所有储藏
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
