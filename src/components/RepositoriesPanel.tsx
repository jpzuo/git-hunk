/**
 * 仓库统一管理与项目自动分组面板（VS Code Dark Modern 100% 原子化实现）
 */

import { memo, useMemo, useState } from "react";
import {
  Plus,
  RefreshCw,
  X,
  ChevronDown,
  ChevronRight,
  Trash2,
  GitFork,
  GitBranch,
  Pencil,
  AlertTriangle,
} from "lucide-react";
import type { CatalogItemSummary, WorktreeInfo } from "../types";
import { IconButton } from "./IconButton";

interface Props {
  catalog: CatalogItemSummary[];
  loading: boolean;
  activePath: string | null;
  onOpenRepo: (path: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onRenameRepo: (path: string, newAlias: string | null) => Promise<void>;
  onRemoveRepo: (path: string, deleteDiskFiles: boolean) => Promise<void>;
  onDeleteGroup: (name: string) => Promise<void>;
  onImportWorktrees: (repoPath: string, targetGroup: string) => Promise<void>;
  onAddLocalRepo: () => Promise<void>;
}

export const RepositoriesPanel = memo(function RepositoriesPanel({
  catalog,
  loading,
  activePath,
  onOpenRepo,
  onRefresh,
  onRenameRepo,
  onRemoveRepo,
  onDeleteGroup,
  onImportWorktrees,
  onAddLocalRepo,
}: Props) {
  const [filter, setFilter] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [editingRepo, setEditingRepo] = useState<CatalogItemSummary | null>(null);
  const [aliasInput, setAliasInput] = useState("");
  const [deletingRepo, setDeletingRepo] = useState<CatalogItemSummary | null>(null);
  const [deleteDiskFiles, setDeleteDiskFiles] = useState(false);

  const { groups, totalCount } = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const groupMap = new Map<string, CatalogItemSummary[]>();
    const namesSet = new Set<string>();

    for (const item of catalog) {
      if (item.group) {
        namesSet.add(item.group);
      }
    }

    for (const name of namesSet) {
      groupMap.set(name, []);
    }

    let matchCount = 0;
    for (const item of catalog) {
      const match =
        !q ||
        item.display_name.toLowerCase().includes(q) ||
        item.original_name.toLowerCase().includes(q) ||
        item.path.toLowerCase().includes(q) ||
        (item.alias && item.alias.toLowerCase().includes(q)) ||
        (item.current_branch && item.current_branch.toLowerCase().includes(q)) ||
        item.group.toLowerCase().includes(q);

      if (match) {
        matchCount++;
        const g = item.group || item.original_name;
        if (!groupMap.has(g)) {
          groupMap.set(g, []);
          namesSet.add(g);
        }
        groupMap.get(g)!.push(item);
      }
    }

    const sortedGroups = Array.from(groupMap.entries()).sort(([a], [b]) =>
      a.localeCompare(b),
    );

    return {
      groups: sortedGroups,
      totalCount: matchCount,
    };
  }, [catalog, filter]);

  const toggleGroup = (groupName: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupName)) next.delete(groupName);
      else next.add(groupName);
      return next;
    });
  };

  const handleStartRenameRepo = (repo: CatalogItemSummary) => {
    setEditingRepo(repo);
    setAliasInput(repo.alias ?? "");
  };

  const handleConfirmRenameRepo = async () => {
    if (!editingRepo) return;
    const clean = aliasInput.trim();
    await onRenameRepo(editingRepo.path, clean ? clean : null);
    setEditingRepo(null);
  };

  const handleStartDeleteRepo = (repo: CatalogItemSummary) => {
    setDeletingRepo(repo);
    setDeleteDiskFiles(false);
  };

  const handleConfirmDeleteRepo = async () => {
    if (!deletingRepo) return;
    const targetPath = deletingRepo.path;
    const delFiles = deleteDiskFiles;
    setDeletingRepo(null);
    setDeleteDiskFiles(false);
    await onRemoveRepo(targetPath, delFiles);
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#252526]">
      <div className="flex items-center justify-between px-3 h-[36px] border-b border-[#3c3c3c] shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[#cccccc]">
            仓库与分组
          </span>
          <span className="px-1.5 py-0.5 rounded-full bg-[#313131] text-[#cccccc] text-[10px] leading-none font-semibold">
            {totalCount}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <IconButton
            tooltip="打开本地仓库"
            icon={<Plus size={13} strokeWidth={2} />}
            onClick={() => void onAddLocalRepo()}
          />
          <IconButton
            tooltip="刷新仓库清单"
            align="right"
            disabled={loading}
            icon={<RefreshCw size={12} strokeWidth={1.75} className={loading ? "animate-spin" : ""} />}
            onClick={() => void onRefresh()}
          />
        </div>
      </div>

      <div className="px-2.5 py-1.5 border-b border-[#3c3c3c] shrink-0">
        <div className="flex items-center bg-[#313131] border border-[#3c3c3c] focus-within:border-[#0078d4] rounded-[2px] px-2 h-[26px]">
          <input
            type="text"
            className="border-none bg-transparent text-[#cccccc] placeholder-[#868686] text-[12px] w-full outline-none"
            placeholder="搜索工作区、别名、分支..."
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

      <div className="flex-1 overflow-y-auto min-h-0 py-1">
        {groups.map(([groupName, repos]) => {
          const isCollapsed = collapsedGroups.has(groupName);

          const existingPaths = new Set(repos.map((r) => r.path.toLowerCase()));
          const missingWorktreesMap = new Map<string, WorktreeInfo>();
          let rootRepoPath = repos[0]?.path;

          for (const repo of repos) {
            if (repo.is_main_worktree) {
              rootRepoPath = repo.path;
            }
            for (const wt of repo.linked_worktrees ?? []) {
              const norm = wt.path.toLowerCase();
              if (!existingPaths.has(norm)) {
                missingWorktreesMap.set(norm, wt);
              }
            }
          }
          const missingWorktrees = Array.from(missingWorktreesMap.values());
          const hasMissingWorktrees = missingWorktrees.length > 0;

          return (
            <div key={groupName} className="border-b border-[#2b2b2b]">
              <div
                className="group flex items-center gap-1.5 px-2.5 py-1.5 bg-[#202020] hover:bg-[#2a2d2e] cursor-pointer select-none text-[12px]"
                onClick={() => toggleGroup(groupName)}
              >
                <span className="text-[#9d9d9d] shrink-0">
                  {isCollapsed ? (
                    <ChevronRight size={13} strokeWidth={1.75} />
                  ) : (
                    <ChevronDown size={13} strokeWidth={1.75} />
                  )}
                </span>
                <span className="font-semibold text-[#cccccc] truncate flex-1" title={groupName}>
                  {groupName}
                </span>

                <div
                  className="opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    className="flex items-center justify-center w-5 h-5 rounded-[3px] border-none bg-transparent text-[#9d9d9d] hover:text-[#f14c4c] hover:bg-[#37373d] cursor-pointer p-0"
                    title="从列表中移除此项目分组"
                    onClick={() => void onDeleteGroup(groupName)}
                  >
                    <Trash2 size={12} strokeWidth={1.75} />
                  </button>
                </div>
              </div>

              {!isCollapsed && (
                <div>
                  {hasMissingWorktrees && (
                    <div
                      className="mx-2 my-1.5 p-2 rounded-[4px] bg-[#1f1f1f] border border-[#3c3c3c] flex flex-col gap-1.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center gap-1.5 text-[11.5px] text-[#9d9d9d]">
                        <GitFork size={13} strokeWidth={1.75} className="shrink-0 text-[#cccccc]" />
                        <span>
                          发现该项目有 <strong className="text-[#cccccc]">{missingWorktrees.length}</strong> 个未导入的工作树
                        </span>
                      </div>
                      <button
                        type="button"
                        className="inline-flex items-center justify-center gap-1 px-2 py-1 text-[11px] rounded-[2px] bg-[#313131] hover:bg-[#3c3c3c] text-[#cccccc] hover:text-white border border-[#454545] cursor-pointer"
                        title={`一键将未导入的 ${missingWorktrees.length} 个工作树添加到本组`}
                        onClick={() => {
                          if (rootRepoPath) {
                            void onImportWorktrees(rootRepoPath, groupName);
                          }
                        }}
                      >
                        <GitFork size={12} strokeWidth={1.75} />
                        <span>一键导入至本组</span>
                      </button>
                    </div>
                  )}

                  {repos.length === 0 ? (
                    <div className="px-4 py-2 text-[11.5px] text-[#868686]">
                      暂无工作区，点击上方 + 打开本地仓库添加
                    </div>
                  ) : (
                    repos.map((repo) => {
                      const isActive =
                        repo.is_active ||
                        (activePath &&
                          repo.path.toLowerCase() === activePath.toLowerCase());

                      return (
                        <div
                          key={repo.path}
                          className={`group flex items-center justify-between gap-2 pl-5 pr-2.5 py-1.5 cursor-pointer select-none transition-colors ${
                            isActive
                              ? "bg-[#04395e] text-white"
                              : "text-[#cccccc] hover:bg-[#2a2d2e]"
                          }`}
                          onClick={() => void onOpenRepo(repo.path)}
                          title={`${repo.display_name}\n路径: ${repo.path}\n单击打开或切换工作区`}
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span
                                className={`w-2 h-2 rounded-full shrink-0 ${
                                  isActive
                                    ? "bg-[#73c991]"
                                    : repo.is_open
                                      ? "bg-[#3794ff]"
                                      : "bg-[#6e7681]"
                                }`}
                                title={
                                  isActive
                                    ? "当前活跃工作区"
                                    : repo.is_open
                                      ? "已在标签页中打开"
                                      : "未打开"
                                }
                              />
                              {repo.worktree_count > 1 && (
                                <span className="text-[#9d9d9d] shrink-0" title="包含多个工作树">
                                  <GitFork size={12} strokeWidth={1.75} />
                                </span>
                              )}
                              <span className="text-[12.5px] font-medium truncate">
                                {repo.display_name}
                              </span>

                              {repo.alias && (
                                <span
                                  className={`text-[11px] truncate ${
                                    isActive ? "text-white/70" : "text-[#868686]"
                                  }`}
                                  title={`真实目录名: ${repo.original_name}`}
                                >
                                  ({repo.original_name})
                                </span>
                              )}

                              {repo.has_changes && (
                                <span
                                  className="w-1.5 h-1.5 rounded-full bg-[#e2c08d] shrink-0"
                                  title="工作区有未提交改动"
                                />
                              )}
                            </div>

                            {(repo.current_branch || repo.is_main_worktree || repo.is_worktree) && (
                              <div className="flex items-center gap-2 mt-0.5 pl-3.5 text-[11px]">
                                {repo.current_branch && (
                                  <span
                                    className={`inline-flex items-center gap-1 font-mono truncate ${
                                      isActive ? "text-[#75beff]" : "text-[#868686]"
                                    }`}
                                  >
                                    <GitBranch size={11} strokeWidth={1.75} />
                                    {repo.current_branch}
                                  </span>
                                )}
                                {repo.is_main_worktree && (
                                  <span className="text-[10px] text-[#73c991]">主工作区</span>
                                )}
                                {!repo.is_main_worktree && repo.is_worktree && (
                                  <span className="text-[10px] text-[#3794ff]">工作树</span>
                                )}
                              </div>
                            )}
                          </div>

                          <div
                            className="hidden group-hover:flex items-center gap-1 shrink-0"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              className="flex items-center justify-center w-5 h-5 rounded-[3px] border-none bg-[#252526] text-[#cccccc] hover:text-white hover:bg-[#37373d] cursor-pointer p-0"
                              title="重命名显示别名"
                              onClick={() => handleStartRenameRepo(repo)}
                            >
                              <Pencil size={11} strokeWidth={1.75} />
                            </button>
                            <button
                              type="button"
                              className="flex items-center justify-center w-5 h-5 rounded-[3px] border-none bg-[#252526] text-[#f14c4c] hover:text-white hover:bg-[#c74e39] cursor-pointer p-0"
                              title="删除工作区..."
                              onClick={() => handleStartDeleteRepo(repo)}
                            >
                              <Trash2 size={11} strokeWidth={1.75} />
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {editingRepo && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55"
          onClick={() => setEditingRepo(null)}
        >
          <div
            className="w-[420px] max-w-[90vw] bg-[#252526] border border-[#454545] rounded-[6px] p-4 shadow-[0_12px_36px_rgba(0,0,0,0.7)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[14px] font-semibold text-white mb-1.5">重命名工作区别名</div>
            <p className="text-[12px] text-[#868686] mb-3 mt-0">
              设置在应用内显示的自定义名称（仅影响界面显示，不修改硬盘真实目录名）。
            </p>
            <div className="mb-3">
              <label className="block text-[11.5px] text-[#cccccc] mb-1">原始目录名</label>
              <input
                type="text"
                disabled
                className="w-full bg-[#1f1f1f] text-[#868686] border border-[#3c3c3c] rounded-[2px] px-2.5 py-1.5 text-[12px]"
                value={editingRepo.original_name}
              />
            </div>
            <div className="mb-4">
              <label className="block text-[11.5px] text-[#cccccc] mb-1">显示别名 (留空恢复为目录名)</label>
              <input
                type="text"
                autoFocus
                className="w-full bg-[#313131] text-[#cccccc] border border-[#3c3c3c] focus:border-[#0078d4] outline-none rounded-[2px] px-2.5 py-1.5 text-[12px]"
                placeholder={editingRepo.original_name}
                value={aliasInput}
                onChange={(e) => setAliasInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleConfirmRenameRepo();
                  if (e.key === "Escape") setEditingRepo(null);
                }}
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="px-3 py-1.5 text-[12px] rounded-[2px] bg-[#313131] hover:bg-[#3c3c3c] text-[#cccccc] border border-[#3c3c3c] cursor-pointer"
                onClick={() => setEditingRepo(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="px-3 py-1.5 text-[12px] rounded-[2px] bg-[#0078d4] hover:bg-[#026ec1] text-white border-none cursor-pointer"
                onClick={() => void handleConfirmRenameRepo()}
              >
                保存别名
              </button>
            </div>
          </div>
        </div>
      )}

      {deletingRepo && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55"
          onClick={() => {
            setDeletingRepo(null);
            setDeleteDiskFiles(false);
          }}
        >
          <div
            className="w-[450px] max-w-[90vw] bg-[#252526] border border-[#454545] rounded-[6px] p-4 shadow-[0_12px_36px_rgba(0,0,0,0.7)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[14px] font-semibold text-white mb-1.5">删除工作区</div>
            <p className="text-[12.5px] text-[#cccccc] mb-3 mt-0">
              确定要将 <strong className="text-white">{deletingRepo.display_name}</strong> 从工作区管理列表中移除吗？
            </p>

            <div className="p-2.5 rounded-[4px] bg-[#181818] border border-[#2b2b2b] mb-3 flex flex-col gap-1.5 text-[11.5px]">
              {deletingRepo.current_branch && (
                <div className="flex items-center gap-2">
                  <span className="text-[#868686] shrink-0">关联分支:</span>
                  <span className="inline-flex items-center gap-1 font-mono text-[#75beff]">
                    <GitBranch size={12} strokeWidth={1.75} />
                    {deletingRepo.current_branch}
                  </span>
                </div>
              )}
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[#868686] shrink-0">物理路径:</span>
                <span className="font-mono text-[#cccccc] truncate" title={deletingRepo.path}>
                  {deletingRepo.path}
                </span>
              </div>
            </div>

            <div className="mb-3">
              <label className="flex items-start gap-2 text-[12px] text-[#cccccc] cursor-pointer">
                <input
                  type="checkbox"
                  checked={deleteDiskFiles}
                  onChange={(e) => setDeleteDiskFiles(e.target.checked)}
                  className="mt-0.5 accent-[#0078d4]"
                />
                <span>
                  同时删除硬盘上的物理文件（彻底删除该文件夹及关联 Git 工作树）
                </span>
              </label>
            </div>

            {deleteDiskFiles && (
              <div className="flex items-start gap-2 p-2.5 mb-4 rounded-[4px] bg-[#f14c4c]/12 border border-[#f14c4c]/35 text-[12px] text-[#f14c4c]">
                <AlertTriangle size={15} strokeWidth={2} className="shrink-0 mt-0.5" />
                <span>
                  <strong>危险操作：</strong>将永久物理删除该文件夹下的所有代码及未提交改动，此操作<strong>无法撤销</strong>！
                </span>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="px-3 py-1.5 text-[12px] rounded-[2px] bg-[#313131] hover:bg-[#3c3c3c] text-[#cccccc] border border-[#3c3c3c] cursor-pointer"
                onClick={() => {
                  setDeletingRepo(null);
                  setDeleteDiskFiles(false);
                }}
              >
                取消
              </button>
              <button
                type="button"
                className={`px-3 py-1.5 text-[12px] rounded-[2px] text-white border-none cursor-pointer font-medium ${
                  deleteDiskFiles
                    ? "bg-[#c74e39] hover:bg-[#e45b43]"
                    : "bg-[#0078d4] hover:bg-[#026ec1]"
                }`}
                onClick={() => void handleConfirmDeleteRepo()}
              >
                {deleteDiskFiles ? "彻底删除" : "从列表移除"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
