/**
 * Source Control 面板（VS Code Dark Modern 100% 原子化复刻）
 */

import React, { useCallback, useMemo, useState } from "react";
import {
  RefreshCw,
  Plus,
  Minus,
  Undo2,
  FolderTree,
  List,
  MoreHorizontal,
  ArrowDown,
  ArrowUp,
  Trash2,
  AlertTriangle,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import type { ChangedFile, FileStatus, RepoStatus, StageArea } from "../types";
import { buildFileTree, type TreeNode } from "./FileTree";
import { ConventionalCommitForm } from "./ConventionalCommitForm";
import { FileContextMenu, type ContextMenuTarget } from "./FileContextMenu";
import { IconButton } from "./IconButton";

interface Props {
  status: RepoStatus | null;
  loading: boolean;
  selectedPath: string | null;
  onSelect: (path: string, area: StageArea) => void;
  onStageFile: (path: string) => void;
  onUnstageFile: (path: string) => void;
  onDiscardFile: (path: string, area: StageArea) => void;
  onStagePaths: (paths: string[]) => Promise<void>;
  onUnstagePaths: (paths: string[]) => Promise<void>;
  onDiscardPaths: (paths: string[]) => Promise<void>;
  onCleanUntrackedPaths: (paths: string[]) => Promise<void>;
  onDiscardAllUnstaged: () => Promise<void>;
  onUnstageAll: () => Promise<void>;
  onCleanAllUntracked: () => Promise<void>;
  onCommit: (message: string) => void;
  onCommitAndPush: (message: string) => void;
  onAmend: (message: string) => void;
  onStageAllAndCommit?: (message: string) => void;
  onStageAll: () => void;
  onRefresh: () => void;
  onPull?: () => void;
  onPush?: () => void;
  onFetch?: () => void;
  onSync?: () => Promise<void>;
  syncLoading?: boolean;
  onOpenFolder: () => void;
  onOpenFile: (path: string) => void;
  onRevealInExplorer: (path: string) => void;
  onOpenTerminal: (path: string) => void;
  onAddToGitignore: (pattern: string) => void;
  onCopyPath: (text: string) => void;
}

const STATUS_LABEL: Record<FileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "!",
  type_change: "T",
};

const STATUS_COLOR: Record<FileStatus, string> = {
  added: "text-[#73c991]",
  untracked: "text-[#73c991]",
  modified: "text-[#e2c08d]",
  deleted: "text-[#c74e39]",
  renamed: "text-[#73c991]",
  conflicted: "text-[#e46767]",
  type_change: "text-[#e2c08d]",
};

const FileRow = React.memo(function FileRow({
  file,
  area,
  selected,
  onSelect,
  actions,
  onContextMenu,
}: {
  file: ChangedFile;
  area: StageArea;
  selected: boolean;
  onSelect: () => void;
  actions: React.ReactNode;
  onContextMenu: (e: React.MouseEvent, target: ContextMenuTarget) => void;
}) {
  const name = file.path.split("/").pop() ?? file.path;
  const dir = file.path.slice(0, file.path.length - name.length);

  return (
    <div
      className={`group flex items-center gap-1.5 pl-5 pr-2 py-[2px] min-h-[22px] text-[12px] cursor-pointer select-none transition-colors ${
        selected ? "bg-[#04395e] text-white" : "text-[#cccccc] hover:bg-[#2a2d2e]"
      }`}
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e, {
          x: e.clientX,
          y: e.clientY,
          path: file.path,
          isDir: false,
          area,
          allFilePaths: [file.path],
        });
      }}
      title={file.path}
    >
      <span
        className={`truncate shrink-0 max-w-[55%] ${
          selected
            ? "text-white"
            : file.status === "deleted"
              ? "line-through text-[#c74e39]"
              : STATUS_COLOR[file.status]
        }`}
      >
        {name}
      </span>
      {dir && (
        <span className={`text-[11px] truncate flex-1 ${selected ? "text-white/75" : "text-[#868686]"}`}>
          {dir}
        </span>
      )}
      {!dir && <span className="flex-1" />}
      <span
        className="hidden group-hover:inline-flex items-center gap-0.5 shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        {actions}
      </span>
      <span className="inline-flex items-center gap-1 font-mono text-[10.5px] shrink-0">
        {file.additions > 0 && <span className="text-[#73c991]">+{file.additions}</span>}
        {file.deletions > 0 && <span className="text-[#c74e39]">-{file.deletions}</span>}
      </span>
      <span
        className={`w-3.5 text-center font-mono text-[11px] font-semibold shrink-0 ${
          selected ? "text-white" : STATUS_COLOR[file.status]
        }`}
      >
        {STATUS_LABEL[file.status]}
      </span>
    </div>
  );
});

interface FileTreeSectionProps {
  files: ChangedFile[];
  area: StageArea;
  selectedPath: string | null;
  onSelect: (path: string, area?: StageArea) => void;
  renderFileActions: (file: ChangedFile) => React.ReactNode;
  renderDirActions?: (node: TreeNode) => React.ReactNode;
  onContextMenu: (e: React.MouseEvent, target: ContextMenuTarget) => void;
}

const FileTreeSection = React.memo(function FileTreeSection({
  files,
  area,
  selectedPath,
  onSelect,
  renderFileActions,
  renderDirActions,
  onContextMenu,
}: FileTreeSectionProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const tree = useMemo(() => buildFileTree(files, true), [files]);

  const toggleDir = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const isCollapsed = collapsed.has(node.path);
    const indent = 8 + depth * 12;

    if (node.isDir) {
      const slashIdx = node.name.lastIndexOf("/");
      const prefix = slashIdx >= 0 ? node.name.slice(0, slashIdx + 1) : "";
      const base = slashIdx >= 0 ? node.name.slice(slashIdx + 1) : node.name;

      return (
        <React.Fragment key={node.path}>
          <div
            className="group flex items-center gap-1 pr-2 py-[2px] min-h-[22px] text-[12px] text-[#cccccc] hover:bg-[#2a2d2e] cursor-pointer select-none"
            style={{ paddingLeft: indent }}
            onClick={() => toggleDir(node.path)}
            onContextMenu={(e) => {
              e.preventDefault();
              onContextMenu(e, {
                x: e.clientX,
                y: e.clientY,
                path: node.path,
                isDir: true,
                area,
                allFilePaths: node.allFilePaths,
              });
            }}
            title={node.path}
          >
            <span className="flex items-center justify-center text-[#9d9d9d] shrink-0">
              {isCollapsed ? (
                <ChevronRight size={13} strokeWidth={1.75} />
              ) : (
                <ChevronDown size={13} strokeWidth={1.75} />
              )}
            </span>
            <span className="flex-1 truncate">
              {prefix && <span className="text-[#868686]">{prefix}</span>}
              <span className="text-[#cccccc] font-medium">{base}</span>
            </span>
            {renderDirActions && (
              <span
                className="hidden group-hover:inline-flex items-center gap-0.5 shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                {renderDirActions(node)}
              </span>
            )}
          </div>
          {!isCollapsed &&
            node.children.map((child) => renderNode(child, depth + 1))}
        </React.Fragment>
      );
    }

    const file = node.file!;
    const fileArea: StageArea = file.status === "untracked" ? "untracked" : area;
    const isSelected = selectedPath === node.path;

    return (
      <div
        key={node.path}
        className={`group flex items-center gap-1.5 pr-2 py-[2px] min-h-[22px] text-[12px] cursor-pointer select-none transition-colors ${
          isSelected ? "bg-[#04395e] text-white" : "text-[#cccccc] hover:bg-[#2a2d2e]"
        }`}
        style={{ paddingLeft: indent + 14 }}
        onClick={() => onSelect(node.path, fileArea)}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(e, {
            x: e.clientX,
            y: e.clientY,
            path: node.path,
            isDir: false,
            area: fileArea,
            allFilePaths: [node.path],
          });
        }}
        title={node.path}
      >
        <span
          className={`flex-1 truncate ${
            isSelected
              ? "text-white"
              : file.status === "deleted"
                ? "line-through text-[#c74e39]"
                : STATUS_COLOR[file.status]
          }`}
        >
          {node.name}
        </span>
        <span
          className="hidden group-hover:inline-flex items-center gap-0.5 shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          {renderFileActions(file)}
        </span>
        <span className="inline-flex items-center gap-1 font-mono text-[10.5px] shrink-0">
          {file.additions > 0 && <span className="text-[#73c991]">+{file.additions}</span>}
          {file.deletions > 0 && <span className="text-[#c74e39]">-{file.deletions}</span>}
        </span>
        <span
          className={`w-3.5 text-center font-mono text-[11px] font-semibold shrink-0 ${
            isSelected ? "text-white" : STATUS_COLOR[file.status]
          }`}
        >
          {STATUS_LABEL[file.status]}
        </span>
      </div>
    );
  };

  if (files.length === 0) {
    return <div className="px-4 py-2 text-[12px] text-[#868686]">无</div>;
  }

  return <div className="py-0.5">{tree.map((node) => renderNode(node, 0))}</div>;
});

function Group({
  title,
  count,
  children,
  action,
  isConflict,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
  action?: React.ReactNode;
  isConflict?: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="flex flex-col border-b border-[#2b2b2b]/60">
      <header
        className={`group flex items-center gap-1.5 px-2 h-[24px] text-[11px] font-semibold uppercase tracking-wide cursor-pointer select-none hover:bg-[#2a2d2e] ${
          isConflict ? "text-[#e46767]" : "text-[#cccccc]"
        }`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="text-[#9d9d9d] shrink-0">
          {open ? (
            <ChevronDown size={13} strokeWidth={1.75} />
          ) : (
            <ChevronRight size={13} strokeWidth={1.75} />
          )}
        </span>
        <span className="flex-1 truncate">{title}</span>
        {action && (
          <span
            className="inline-flex items-center gap-0.5 mr-1 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => e.stopPropagation()}
          >
            {action}
          </span>
        )}
        <span className="px-1.5 py-0.5 rounded-full bg-[#313131] text-[#cccccc] text-[10px] leading-none font-semibold">
          {count}
        </span>
      </header>
      {open && <div className="pb-1">{children}</div>}
    </section>
  );
}

export const SourceControlPanel = React.memo(function SourceControlPanel(props: Props) {
  const { status, loading, selectedPath } = props;

  const [viewMode, setViewMode] = useState<"tree" | "list">(() => {
    try {
      return (
        (localStorage.getItem("git-hunk.sc-view-mode") as "tree" | "list") ||
        "tree"
      );
    } catch {
      return "tree";
    }
  });

  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [contextMenuTarget, setContextMenuTarget] = useState<ContextMenuTarget | null>(null);

  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    description: string;
    onConfirm: () => Promise<void>;
  } | null>(null);

  const handleContextMenu = useCallback((_e: React.MouseEvent, target: ContextMenuTarget) => {
    setContextMenuTarget(target);
  }, []);

  const conflictedFiles = useMemo(
    () => (status ? status.unstaged.filter((f) => f.status === "conflicted") : []),
    [status],
  );
  const normalUnstagedFiles = useMemo(
    () => (status ? status.unstaged.filter((f) => f.status !== "conflicted") : []),
    [status],
  );
  const allChangesFiles = useMemo(() => {
    if (!status) return [];
    return [...normalUnstagedFiles, ...status.untracked].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
  }, [status, normalUnstagedFiles]);

  if (!status) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-4 bg-[#181818] text-[#868686]">
        <p className="m-0 text-[13px]">尚未打开仓库</p>
        <button
          className="px-3 py-1.5 text-[12px] rounded-[2px] bg-[#0078d4] hover:bg-[#026ec1] text-white border-none cursor-pointer"
          onClick={props.onOpenFolder}
        >
          打开仓库…
        </button>
      </div>
    );
  }

  const totalChanges =
    status.staged.length + status.unstaged.length + status.untracked.length;

  const renderChangeFileActions = (f: ChangedFile) => {
    if (f.status === "untracked") {
      return (
        <>
          <IconButton
            size="xs"
            tooltip="暂存 (加入版本控制)"
            icon={<Plus size={12} strokeWidth={2} />}
            onClick={() => props.onStageFile(f.path)}
          />
          <IconButton
            size="xs"
            variant="danger"
            align="right"
            tooltip="删除未跟踪文件"
            icon={<Trash2 size={12} strokeWidth={1.75} />}
            onClick={() => {
              setConfirmDialog({
                title: "删除未跟踪文件？",
                description: `确定要永久删除 ${f.path} 吗？此操作无法撤销！`,
                onConfirm: async () => {
                  await props.onCleanUntrackedPaths([f.path]);
                },
              });
            }}
          />
        </>
      );
    }
    return (
      <>
        <IconButton
          size="xs"
          tooltip="暂存"
          icon={<Plus size={12} strokeWidth={2} />}
          onClick={() => props.onStageFile(f.path)}
        />
        <IconButton
          size="xs"
          variant="danger"
          align="right"
          tooltip="丢弃改动"
          icon={<Undo2 size={12} strokeWidth={1.85} />}
          onClick={() => props.onDiscardFile(f.path, "unstaged")}
        />
      </>
    );
  };

  const renderChangeDirActions = (node: TreeNode) => {
    return (
      <>
        <IconButton
          size="xs"
          tooltip={`暂存整目录 (${node.allFilePaths.length} 个文件)`}
          icon={<Plus size={12} strokeWidth={2} />}
          onClick={() => void props.onStagePaths(node.allFilePaths)}
        />
        <IconButton
          size="xs"
          variant="danger"
          align="right"
          tooltip={`放弃整目录修改 (${node.allFilePaths.length} 个文件)`}
          icon={<Undo2 size={12} strokeWidth={1.85} />}
          onClick={() => {
            setConfirmDialog({
              title: `放弃目录 ${node.name} 的修改？`,
              description: `确定放弃 ${node.allFilePaths.length} 个文件的所有修改吗？未跟踪文件将被直接删除，此操作不可撤销。`,
              onConfirm: async () => {
                const untrackedSet = new Set(status.untracked.map((u) => u.path));
                const untracked = node.allFilePaths.filter((p) => untrackedSet.has(p));
                const tracked = node.allFilePaths.filter((p) => !untrackedSet.has(p));
                if (tracked.length > 0) {
                  await props.onDiscardPaths(tracked);
                }
                if (untracked.length > 0) {
                  await props.onCleanUntrackedPaths(untracked);
                }
              },
            });
          }}
        />
      </>
    );
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#181818] relative">
      {/* 顶栏 */}
      <div className="flex items-center justify-between px-3 h-[35px] border-b border-[#2b2b2b] shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[#cccccc]">
            源代码管理
          </span>
          {totalChanges > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-[#0078d4] text-white text-[10px] leading-none font-semibold">
              {totalChanges}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <IconButton
            tooltip="刷新状态"
            icon={<RefreshCw size={13} strokeWidth={1.8} />}
            onClick={props.onRefresh}
          />
          <IconButton
            tooltip="暂存所有更改"
            icon={<Plus size={14} strokeWidth={2} />}
            onClick={props.onStageAll}
          />
          <IconButton
            tooltip="放弃所有未暂存的更改"
            variant="danger"
            disabled={normalUnstagedFiles.length === 0}
            icon={<Undo2 size={13} strokeWidth={1.85} />}
            onClick={() => {
              setConfirmDialog({
                title: "放弃所有更改？",
                description: `确定要放弃所有未暂存的修改吗？共 ${normalUnstagedFiles.length} 个文件，此操作不可撤销。`,
                onConfirm: async () => {
                  await props.onDiscardAllUnstaged();
                },
              });
            }}
          />
          <IconButton
            tooltip={
              viewMode === "tree"
                ? "当前为树状视图，点击切换为列表视图"
                : "当前为列表视图，点击切换为树状视图"
            }
            icon={viewMode === "tree" ? <FolderTree size={13} strokeWidth={1.75} /> : <List size={13} strokeWidth={1.75} />}
            onClick={() => {
              const next = viewMode === "tree" ? "list" : "tree";
              setViewMode(next);
              try {
                localStorage.setItem("git-hunk.sc-view-mode", next);
              } catch {}
            }}
          />
          <div className="relative">
            <IconButton
              tooltip="更多操作"
              align="right"
              icon={<MoreHorizontal size={14} strokeWidth={1.8} />}
              onClick={() => setMoreMenuOpen((o) => !o)}
            />
            {moreMenuOpen && (
              <div
                className="fixed inset-0 z-30"
                onClick={() => setMoreMenuOpen(false)}
              />
            )}
            {moreMenuOpen && (
              <div
                className="absolute right-0 top-7 z-40 min-w-[175px] bg-[#252526] border border-[#454545] rounded-[4px] py-1 shadow-[0_6px_20px_rgba(0,0,0,0.6)] text-[12px] text-[#cccccc]"
                onClick={() => setMoreMenuOpen(false)}
              >
                {props.onPull && (
                  <div
                    className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-[#04395e] hover:text-white"
                    onClick={props.onPull}
                  >
                    <ArrowDown size={13} strokeWidth={1.75} />
                    <span>拉取 (Pull)</span>
                  </div>
                )}
                {props.onPush && (
                  <div
                    className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-[#04395e] hover:text-white"
                    onClick={props.onPush}
                  >
                    <ArrowUp size={13} strokeWidth={1.75} />
                    <span>推送 (Push)</span>
                  </div>
                )}
                {props.onFetch && (
                  <div
                    className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-[#04395e] hover:text-white"
                    onClick={props.onFetch}
                  >
                    <RefreshCw size={13} strokeWidth={1.75} />
                    <span>抓取 (Fetch All)</span>
                  </div>
                )}
                <div className="h-[1px] bg-[#3c3c3c] my-1" />
                <div
                  className="flex items-center gap-2 px-3 py-1.5 cursor-pointer text-[#f14c4c] hover:bg-[#04395e] hover:text-[#ff7070]"
                  onClick={() => {
                    setConfirmDialog({
                      title: "放弃所有更改？",
                      description: "确定要丢弃所有变更与未跟踪文件吗？此操作将硬重置到 HEAD。",
                      onConfirm: async () => {
                        await props.onDiscardAllUnstaged();
                        await props.onCleanAllUntracked();
                      },
                    });
                  }}
                >
                  <Trash2 size={13} strokeWidth={1.75} />
                  <span>放弃全部工作区更改…</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {conflictedFiles.length > 0 && (
        <div className="flex items-start gap-2 px-3 py-2 bg-[#f14c4c]/12 border-b border-[#f14c4c]/30 text-[11.5px]">
          <AlertTriangle size={15} strokeWidth={2} className="text-[#f14c4c] shrink-0 mt-0.5" />
          <div className="flex flex-col gap-0.5">
            <span className="font-semibold text-[#f14c4c]">
              存在 {conflictedFiles.length} 个未解决的冲突文件
            </span>
            <span className="text-[#cccccc]/80 text-[11px]">
              请先在下方解决冲突并暂存（或放弃修改），再执行切换分支或提交。
            </span>
          </div>
        </div>
      )}

      <ConventionalCommitForm
        branch={status.branch}
        stagedCount={status.staged.length}
        totalChangesCount={allChangesFiles.length}
        hasConflicts={conflictedFiles.length > 0}
        onCommit={props.onCommit}
        onCommitAndPush={props.onCommitAndPush}
        onAmend={props.onAmend}
        ahead={status.ahead}
        behind={status.behind}
        onSync={props.onSync ? () => void props.onSync!() : undefined}
        syncLoading={props.syncLoading}
      />

      <div className="flex-1 overflow-y-auto min-h-0">
        {conflictedFiles.length > 0 && (
          <Group
            title="未解决的冲突"
            count={conflictedFiles.length}
            isConflict
            action={
              <IconButton
                size="xs"
                variant="danger"
                align="right"
                tooltip="放弃所有冲突文件的修改并还原至 HEAD"
                icon={<Undo2 size={12} strokeWidth={1.85} />}
                onClick={() => {
                  setConfirmDialog({
                    title: "放弃所有冲突更改？",
                    description: `确定要放弃 ${conflictedFiles.length} 个冲突文件的修改并还原至 HEAD 吗？`,
                    onConfirm: async () => {
                      for (const f of conflictedFiles) {
                        props.onDiscardFile(f.path, "unstaged");
                      }
                    },
                  });
                }}
              />
            }
          >
            {viewMode === "tree" ? (
              <FileTreeSection
                files={conflictedFiles}
                area="unstaged"
                selectedPath={selectedPath}
                onSelect={(p) => props.onSelect(p, "unstaged")}
                onContextMenu={handleContextMenu}
                renderFileActions={(f) => (
                  <>
                    <IconButton
                      size="xs"
                      tooltip="标记冲突已解决 (暂存)"
                      icon={<Plus size={12} strokeWidth={2} />}
                      onClick={() => props.onStageFile(f.path)}
                    />
                    <IconButton
                      size="xs"
                      variant="danger"
                      align="right"
                      tooltip="丢弃此冲突改动 (还原至 HEAD)"
                      icon={<Undo2 size={12} strokeWidth={1.85} />}
                      onClick={() => props.onDiscardFile(f.path, "unstaged")}
                    />
                  </>
                )}
              />
            ) : (
              conflictedFiles.map((f) => (
                <FileRow
                  key={`c-${f.path}`}
                  file={f}
                  area="unstaged"
                  selected={selectedPath === f.path}
                  onSelect={() => props.onSelect(f.path, "unstaged")}
                  onContextMenu={handleContextMenu}
                  actions={
                    <>
                      <IconButton
                        size="xs"
                        tooltip="标记冲突已解决 (暂存)"
                        icon={<Plus size={12} strokeWidth={2} />}
                        onClick={() => props.onStageFile(f.path)}
                      />
                      <IconButton
                        size="xs"
                        variant="danger"
                        align="right"
                        tooltip="丢弃此冲突改动 (还原至 HEAD)"
                        icon={<Undo2 size={12} strokeWidth={1.85} />}
                        onClick={() => props.onDiscardFile(f.path, "unstaged")}
                      />
                    </>
                  }
                />
              ))
            )}
          </Group>
        )}

        {status.staged.length > 0 && (
          <Group
            title="已暂存的更改"
            count={status.staged.length}
            action={
              <IconButton
                size="xs"
                align="right"
                tooltip="取消暂存所有更改 (Unstage All)"
                icon={<Minus size={12} strokeWidth={2} />}
                onClick={props.onUnstageAll}
              />
            }
          >
            {viewMode === "tree" ? (
              <FileTreeSection
                files={status.staged}
                area="staged"
                selectedPath={selectedPath}
                onSelect={(p) => props.onSelect(p, "staged")}
                onContextMenu={handleContextMenu}
                renderFileActions={(f) => (
                  <IconButton
                    size="xs"
                    align="right"
                    tooltip="取消暂存"
                    icon={<Minus size={12} strokeWidth={2} />}
                    onClick={() => props.onUnstageFile(f.path)}
                  />
                )}
                renderDirActions={(node) => (
                  <IconButton
                    size="xs"
                    align="right"
                    tooltip={`取消暂存整目录 (${node.allFilePaths.length} 个文件)`}
                    icon={<Minus size={12} strokeWidth={2} />}
                    onClick={() => void props.onUnstagePaths(node.allFilePaths)}
                  />
                )}
              />
            ) : (
              status.staged.map((f) => (
                <FileRow
                  key={`s-${f.path}`}
                  file={f}
                  area="staged"
                  selected={selectedPath === f.path}
                  onSelect={() => props.onSelect(f.path, "staged")}
                  onContextMenu={handleContextMenu}
                  actions={
                    <IconButton
                      size="xs"
                      align="right"
                      tooltip="取消暂存"
                      icon={<Minus size={12} strokeWidth={2} />}
                      onClick={() => props.onUnstageFile(f.path)}
                    />
                  }
                />
              ))
            )}
          </Group>
        )}

        {allChangesFiles.length > 0 && (
          <Group
            title="更改"
            count={allChangesFiles.length}
            action={
              <>
                <IconButton
                  size="xs"
                  tooltip="暂存所有更改"
                  icon={<Plus size={12} strokeWidth={2} />}
                  onClick={props.onStageAll}
                />
                <IconButton
                  size="xs"
                  variant="danger"
                  align="right"
                  tooltip="放弃所有修改…"
                  icon={<Undo2 size={12} strokeWidth={1.85} />}
                  onClick={() => {
                    setConfirmDialog({
                      title: "放弃全部更改？",
                      description: `确定放弃「更改」中的全部 ${allChangesFiles.length} 个文件修改吗？包含未跟踪文件，此操作不可逆。`,
                      onConfirm: async () => {
                        await props.onDiscardAllUnstaged();
                        if (status.untracked.length > 0) {
                          await props.onCleanAllUntracked();
                        }
                      },
                    });
                  }}
                />
              </>
            }
          >
            {viewMode === "tree" ? (
              <FileTreeSection
                files={allChangesFiles}
                area="unstaged"
                selectedPath={selectedPath}
                onSelect={(p, a) =>
                  props.onSelect(
                    p,
                    a ?? (status.untracked.some((u) => u.path === p) ? "untracked" : "unstaged"),
                  )
                }
                onContextMenu={handleContextMenu}
                renderFileActions={renderChangeFileActions}
                renderDirActions={renderChangeDirActions}
              />
            ) : (
              allChangesFiles.map((f) => {
                const isUntracked = f.status === "untracked";
                const fileArea: StageArea = isUntracked ? "untracked" : "unstaged";
                return (
                  <FileRow
                    key={`change-${f.path}`}
                    file={f}
                    area={fileArea}
                    selected={selectedPath === f.path}
                    onSelect={() => props.onSelect(f.path, fileArea)}
                    onContextMenu={handleContextMenu}
                    actions={renderChangeFileActions(f)}
                  />
                );
              })
            )}
          </Group>
        )}

        {totalChanges === 0 && (
          <div className="text-center py-10 px-4 text-[#868686] text-[12px]">
            没有检测到更改
          </div>
        )}
      </div>

      {loading && (
        <div className="px-3 py-1 bg-[#181818] border-t border-[#2b2b2b] text-[11px] text-[#9d9d9d] shrink-0">
          刷新中…
        </div>
      )}

      <FileContextMenu
        target={contextMenuTarget}
        workdir={status.workdir}
        onClose={() => setContextMenuTarget(null)}
        onOpenFile={props.onOpenFile}
        onRevealInExplorer={props.onRevealInExplorer}
        onOpenTerminal={props.onOpenTerminal}
        onStage={(paths) => void props.onStagePaths(paths)}
        onUnstage={(paths) => void props.onUnstagePaths(paths)}
        onDiscard={(paths) => {
          setConfirmDialog({
            title: `放弃 ${paths.length} 个文件的修改？`,
            description: "此操作将丢弃工作区更改并还原至 HEAD，不可撤销。",
            onConfirm: async () => {
              await props.onDiscardPaths(paths);
            },
          });
        }}
        onCleanUntracked={(paths) => {
          setConfirmDialog({
            title: `删除 ${paths.length} 个未跟踪项？`,
            description: "此操作将永久从磁盘删除文件，不可恢复。",
            onConfirm: async () => {
              await props.onCleanUntrackedPaths(paths);
            },
          });
        }}
        onAddToGitignore={props.onAddToGitignore}
        onCopyPath={props.onCopyPath}
      />

      {confirmDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55"
          onClick={() => setConfirmDialog(null)}
        >
          <div
            className="w-[420px] max-w-[90vw] bg-[#252526] border border-[#454545] rounded-[6px] p-4 shadow-[0_12px_36px_rgba(0,0,0,0.7)]"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setConfirmDialog(null);
            }}
          >
            <div className="text-[14px] font-semibold text-white mb-2">{confirmDialog.title}</div>
            <p className="text-[12.5px] text-[#cccccc] leading-relaxed mb-4 mt-0">
              {confirmDialog.description}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="px-3 py-1.5 text-[12px] rounded-[2px] bg-[#313131] hover:bg-[#3c3c3c] text-[#cccccc] border border-[#3c3c3c] cursor-pointer"
                onClick={() => setConfirmDialog(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="px-3 py-1.5 text-[12px] rounded-[2px] bg-[#c74e39] hover:bg-[#e45b43] text-white border-none cursor-pointer font-medium"
                onClick={async () => {
                  const fn = confirmDialog.onConfirm;
                  setConfirmDialog(null);
                  await fn();
                }}
              >
                确定执行
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
