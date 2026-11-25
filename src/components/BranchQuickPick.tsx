/**
 * 集成式分支快捷切换与管理浮层（VS Code Quick Pick + 分支增删改一体）
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  GitBranch,
  Cloud,
  Plus,
  Check,
  Pencil,
  Trash2,
  RefreshCw,
  X,
} from "lucide-react";
import type { BranchInfo } from "../types";
import { IconButton } from "./IconButton";

interface Props {
  open: boolean;
  branches: BranchInfo[];
  currentBranch: string | null;
  loading?: boolean;
  onClose: () => void;
  onRefresh?: () => Promise<void>;
  onCheckout: (name: string) => Promise<void>;
  onCreateBranch?: (name: string, checkoutImmediately: boolean) => Promise<void>;
  onCreateAndCheckout: (name: string) => Promise<void>;
  onRenameBranch?: (oldName: string, newName: string) => Promise<void>;
  onDeleteBranch?: (
    name: string,
    force: boolean,
    deleteRemote?: boolean,
  ) => Promise<void>;
}

type ScopeTab = "all" | "local" | "remote";

export function BranchQuickPick({
  open,
  branches,
  currentBranch,
  loading = false,
  onClose,
  onRefresh,
  onCheckout,
  onCreateBranch,
  onCreateAndCheckout,
  onRenameBranch,
  onDeleteBranch,
}: Props) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ScopeTab>("all");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [renamingBranch, setRenamingBranch] = useState<BranchInfo | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const [deletingBranch, setDeletingBranch] = useState<BranchInfo | null>(null);
  const [forceDelete, setForceDelete] = useState(false);
  const [deleteRemote, setDeleteRemote] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setScope("all");
      setSelectedIndex(0);
      setRenamingBranch(null);
      setDeletingBranch(null);
      setForceDelete(false);
      setDeleteRemote(false);
      window.setTimeout(() => inputRef.current?.focus(), 40);
    }
  }, [open]);

  const localBranches = useMemo(
    () => branches.filter((b) => !b.is_remote),
    [branches],
  );
  const remoteBranches = useMemo(
    () => branches.filter((b) => b.is_remote),
    [branches],
  );

  const scopedBranches = useMemo(() => {
    if (scope === "local") return localBranches;
    if (scope === "remote") return remoteBranches;
    return branches;
  }, [branches, localBranches, remoteBranches, scope]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return scopedBranches;
    return scopedBranches.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        b.target_summary.toLowerCase().includes(q),
    );
  }, [scopedBranches, query]);

  const exactMatch = useMemo(() => {
    const q = query.trim();
    return branches.some((b) => b.name === q);
  }, [branches, query]);

  const canCreate = query.trim().length > 0 && !exactMatch;
  const totalItems = filtered.length + (canCreate ? 1 : 0);

  const targetRemoteForDelete = useMemo(() => {
    if (!deletingBranch || deletingBranch.is_remote) return null;
    if (
      deletingBranch.upstream &&
      branches.some((b) => b.is_remote && b.name === deletingBranch.upstream)
    ) {
      return deletingBranch.upstream;
    }
    const candidate = `origin/${deletingBranch.name}`;
    return branches.some((b) => b.is_remote && b.name === candidate)
      ? candidate
      : null;
  }, [deletingBranch, branches]);

  const handleSelect = async (idx: number) => {
    if (busy) return;
    if (canCreate && idx === 0) {
      setBusy(true);
      try {
        await onCreateAndCheckout(query.trim());
        onClose();
      } finally {
        setBusy(false);
      }
      return;
    }
    const branchIdx = canCreate ? idx - 1 : idx;
    const target = filtered[branchIdx];
    if (target) {
      setBusy(true);
      try {
        await onCheckout(target.name);
        onClose();
      } finally {
        setBusy(false);
      }
    }
  };

  const handleRenameConfirm = async () => {
    if (!renamingBranch || !onRenameBranch) return;
    const next = renameInput.trim();
    if (!next || next === renamingBranch.name) return;
    setBusy(true);
    try {
      await onRenameBranch(renamingBranch.name, next);
      setRenamingBranch(null);
      setRenameInput("");
      void onRefresh?.();
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deletingBranch || !onDeleteBranch) return;
    const name = deletingBranch.name;
    const force = forceDelete;
    const delRemote = deleteRemote && !!targetRemoteForDelete;
    setBusy(true);
    try {
      await onDeleteBranch(name, force, delRemote);
      setDeletingBranch(null);
      setForceDelete(false);
      setDeleteRemote(false);
      void onRefresh?.();
    } finally {
      setBusy(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (renamingBranch || deletingBranch) {
      if (e.key === "Escape") {
        e.preventDefault();
        setRenamingBranch(null);
        setDeletingBranch(null);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (totalItems > 0 ? (prev + 1) % totalItems : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        totalItems > 0 ? (prev - 1 + totalItems) % totalItems : 0,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      void handleSelect(selectedIndex);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[48px] bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[620px] max-w-[92vw] bg-[#252526] border border-[#454545] rounded-[6px] shadow-[0_12px_36px_rgba(0,0,0,0.7)] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 搜索输入栏 */}
        <div className="flex items-center gap-2 p-2.5 border-b border-[#2b2b2b]">
          <div className="flex items-center flex-1 bg-[#313131] border border-[#3c3c3c] focus-within:border-[#0078d4] rounded-[2px] px-2.5 py-1">
            <GitBranch size={14} strokeWidth={1.75} className="text-[#9d9d9d] mr-2 shrink-0" />
            <input
              ref={inputRef}
              className="flex-1 bg-transparent border-none outline-none text-[#cccccc] placeholder-[#868686] text-[12.5px]"
              placeholder="搜索分支名 / 提交，或输入新分支名称回车直接创建并检出..."
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedIndex(0);
              }}
              onKeyDown={handleKeyDown}
            />
            {query && (
              <IconButton
                size="xs"
                tooltip="清空搜索"
                icon={<X size={12} />}
                onClick={() => {
                  setQuery("");
                  setSelectedIndex(0);
                  inputRef.current?.focus();
                }}
              />
            )}
          </div>
          {onRefresh && (
            <IconButton
              tooltip="刷新分支列表"
              icon={<RefreshCw size={12.5} className={loading ? "animate-spin" : ""} />}
              onClick={() => void onRefresh()}
            />
          )}
          <IconButton tooltip="关闭 (Esc)" align="right" icon={<X size={13} />} onClick={onClose} />
        </div>

        {/* 范围标签切换 */}
        <div className="flex items-center justify-between px-3 py-1.5 bg-[#1f1f1f] border-b border-[#2b2b2b] text-[11px] select-none">
          <div className="flex items-center gap-1">
            {(
              [
                { id: "all", label: `全部 (${branches.length})` },
                { id: "local", label: `本地 (${localBranches.length})` },
                { id: "remote", label: `远程 (${remoteBranches.length})` },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`px-2 py-0.5 rounded-[3px] border-none cursor-pointer transition-colors ${
                  scope === tab.id
                    ? "bg-[#37373d] text-white font-medium"
                    : "bg-transparent text-[#9d9d9d] hover:bg-[#2a2d2e] hover:text-[#cccccc]"
                }`}
                onClick={() => {
                  setScope(tab.id);
                  setSelectedIndex(0);
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <span className="text-[#868686]">点击或回车切换 · 悬浮管理分支</span>
        </div>

        {/* 主体区域：重命名 / 删除确认 / 分支列表 */}
        {renamingBranch ? (
          <div className="p-4 flex flex-col gap-3">
            <div className="text-[13px] font-semibold text-white">
              重命名分支 <span className="font-mono text-[#9d9d9d] font-normal">{renamingBranch.name}</span>
            </div>
            <input
              autoFocus
              type="text"
              className="h-[28px] bg-[#313131] text-[#cccccc] border border-[#3c3c3c] focus:border-[#0078d4] outline-none rounded-[2px] px-2.5 text-[12.5px]"
              placeholder="输入新的分支名称"
              value={renameInput}
              onChange={(e) => setRenameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleRenameConfirm();
                if (e.key === "Escape") setRenamingBranch(null);
              }}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="px-3 py-1 text-[12px] rounded-[2px] bg-[#313131] hover:bg-[#3c3c3c] text-[#cccccc] border border-[#3c3c3c] cursor-pointer"
                onClick={() => setRenamingBranch(null)}
              >
                取消
              </button>
              <button
                type="button"
                disabled={busy || !renameInput.trim() || renameInput.trim() === renamingBranch.name}
                className="px-3 py-1 text-[12px] rounded-[2px] bg-[#0078d4] hover:bg-[#026ec1] text-white border-none cursor-pointer disabled:opacity-45"
                onClick={() => void handleRenameConfirm()}
              >
                确认重命名
              </button>
            </div>
          </div>
        ) : deletingBranch ? (
          <div className="p-4 flex flex-col gap-3">
            <div className="text-[13px] font-semibold text-white">删除本地分支</div>
            <p className="m-0 text-[12px] text-[#cccccc]">
              确定要删除本地分支 <strong className="text-white">{deletingBranch.name}</strong> 吗？
            </p>
            <label className="flex items-start gap-2 text-[12px] text-[#cccccc] cursor-pointer">
              <input
                type="checkbox"
                checked={forceDelete}
                onChange={(e) => setForceDelete(e.target.checked)}
                className="mt-0.5 accent-[#0078d4]"
              />
              <span>强制删除（丢弃尚未合并到上游的提交）</span>
            </label>
            <label
              className={`flex items-start gap-2 text-[12px] ${
                !targetRemoteForDelete ? "opacity-45 cursor-default" : "text-[#cccccc] cursor-pointer"
              }`}
            >
              <input
                type="checkbox"
                disabled={!targetRemoteForDelete}
                checked={deleteRemote && !!targetRemoteForDelete}
                onChange={(e) => setDeleteRemote(e.target.checked)}
                className="mt-0.5 accent-[#0078d4]"
              />
              <span>
                {targetRemoteForDelete
                  ? `同时删除远程分支 (${targetRemoteForDelete})`
                  : "同时删除远程分支（未检测到对应远端分支）"}
              </span>
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="px-3 py-1 text-[12px] rounded-[2px] bg-[#313131] hover:bg-[#3c3c3c] text-[#cccccc] border border-[#3c3c3c] cursor-pointer"
                onClick={() => setDeletingBranch(null)}
              >
                取消
              </button>
              <button
                type="button"
                disabled={busy}
                className="px-3 py-1 text-[12px] rounded-[2px] bg-[#c74e39] hover:bg-[#e45b43] text-white border-none cursor-pointer font-medium disabled:opacity-45"
                onClick={() => void handleDeleteConfirm()}
              >
                确认删除
              </button>
            </div>
          </div>
        ) : (
          <div className="max-h-[400px] overflow-y-auto py-1">
            {canCreate && (
              <div
                className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer text-[12.5px] border-b border-[#2b2b2b] ${
                  selectedIndex === 0
                    ? "bg-[#04395e] text-white"
                    : "bg-[#1f1f1f] text-[#cccccc] hover:bg-[#2a2d2e]"
                }`}
                onClick={() => void handleSelect(0)}
              >
                <span className="inline-flex items-center gap-1 text-[#73c991] font-medium text-[12px]">
                  <Plus size={12} strokeWidth={2} />
                  <span>创建并检出</span>
                </span>
                <span className="font-mono font-semibold text-white">“{query.trim()}”</span>
                <span className="ml-auto flex items-center gap-2 text-[11px] text-[#9d9d9d]">
                  {onCreateBranch && (
                    <button
                      type="button"
                      className="px-1.5 py-0.5 rounded-[2px] bg-[#313131] hover:bg-[#3c3c3c] border border-[#454545] text-[#cccccc] text-[10.5px] cursor-pointer"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onCreateBranch(query.trim(), false).then(onClose);
                      }}
                    >
                      仅创建不切换
                    </button>
                  )}
                  <span>Enter 检出</span>
                </span>
              </div>
            )}

            {filtered.map((b, idx) => {
              const itemIndex = canCreate ? idx + 1 : idx;
              const isSelected = itemIndex === selectedIndex;
              const isCurrent = b.is_head || b.name === currentBranch;

              return (
                <div
                  key={b.name}
                  className={`group flex items-center gap-2 px-3 py-1.5 cursor-pointer text-[12px] transition-colors ${
                    isSelected
                      ? "bg-[#04395e] text-white"
                      : "text-[#cccccc] hover:bg-[#2a2d2e]"
                  }`}
                  onClick={() => void handleSelect(itemIndex)}
                >
                  <span className="text-[#9d9d9d] shrink-0">
                    {b.is_remote ? (
                      <Cloud size={13} strokeWidth={1.75} />
                    ) : (
                      <GitBranch size={13} strokeWidth={1.75} />
                    )}
                  </span>
                  <span className={`font-medium truncate ${isCurrent ? "text-white" : ""}`}>
                    {b.name}
                  </span>
                  {isCurrent && (
                    <span className="px-1.5 py-0.5 text-[10px] rounded-[3px] bg-[#73c991]/20 text-[#73c991] font-medium shrink-0">
                      当前
                    </span>
                  )}
                  {b.ahead > 0 && (
                    <span className="text-[11px] font-mono text-[#73c991]">↑{b.ahead}</span>
                  )}
                  {b.behind > 0 && (
                    <span className="text-[11px] font-mono text-[#e2c08d]">↓{b.behind}</span>
                  )}
                  <span className="ml-auto text-[11px] text-[#868686] truncate max-w-[180px] group-hover:max-w-[110px]">
                    {b.target_summary}
                  </span>

                  <span
                    className="hidden group-hover:inline-flex items-center gap-0.5 shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {!isCurrent && (
                      <IconButton
                        size="xs"
                        tooltip={b.is_remote ? "检出并跟踪远程分支" : "切换到此分支"}
                        icon={<Check size={12} strokeWidth={2} />}
                        onClick={() => void handleSelect(itemIndex)}
                      />
                    )}
                    {!b.is_remote && onRenameBranch && (
                      <IconButton
                        size="xs"
                        tooltip="重命名分支"
                        icon={<Pencil size={11} strokeWidth={1.75} />}
                        onClick={() => {
                          setRenamingBranch(b);
                          setRenameInput(b.name);
                        }}
                      />
                    )}
                    {!isCurrent && !b.is_remote && onDeleteBranch && (
                      <IconButton
                        size="xs"
                        variant="danger"
                        align="right"
                        tooltip="删除分支"
                        icon={<Trash2 size={11} strokeWidth={1.75} />}
                        onClick={() => {
                          setDeletingBranch(b);
                          setForceDelete(false);
                          setDeleteRemote(false);
                        }}
                      />
                    )}
                  </span>
                </div>
              );
            })}

            {totalItems === 0 && (
              <div className="py-8 text-center text-[#868686] text-[12px]">未找到匹配的分支</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
