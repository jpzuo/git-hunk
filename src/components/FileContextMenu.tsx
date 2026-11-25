/**
 * 文件与目录右键上下文菜单 (VS Code Dark Modern 100% 原子化实现)
 */

import React, { useEffect, useRef } from "react";
import {
  FileCode,
  FolderOpen,
  Terminal,
  Plus,
  Minus,
  Undo2,
  Trash2,
  Copy,
  EyeOff,
} from "lucide-react";
import type { StageArea } from "../types";

export interface ContextMenuTarget {
  x: number;
  y: number;
  path: string;
  isDir: boolean;
  area: StageArea;
  allFilePaths?: string[];
}

interface Props {
  target: ContextMenuTarget | null;
  workdir: string;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  onRevealInExplorer: (path: string) => void;
  onOpenTerminal: (path: string) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (paths: string[], isDir: boolean) => void;
  onCleanUntracked: (paths: string[], isDir: boolean) => void;
  onAddToGitignore: (pattern: string) => void;
  onCopyPath: (text: string) => void;
}

const menuItemCls =
  "flex items-center gap-2 px-3 py-1.5 text-[12px] text-[#cccccc] cursor-pointer hover:bg-[#04395e] hover:text-white transition-colors";

const dangerItemCls =
  "flex items-center gap-2 px-3 py-1.5 text-[12px] text-[#f14c4c] cursor-pointer hover:bg-[#04395e] hover:text-[#ff7070] transition-colors";

export const FileContextMenu = React.memo(function FileContextMenu({
  target,
  workdir,
  onClose,
  onOpenFile,
  onRevealInExplorer,
  onOpenTerminal,
  onStage,
  onUnstage,
  onDiscard,
  onCleanUntracked,
  onAddToGitignore,
  onCopyPath,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!target) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    window.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [target, onClose]);

  if (!target) return null;

  const targetPaths = target.allFilePaths && target.allFilePaths.length > 0
    ? target.allFilePaths
    : [target.path];

  const fullAbsPath = workdir.endsWith("/") || workdir.endsWith("\\")
    ? `${workdir}${target.path}`
    : `${workdir}/${target.path}`;

  const style: React.CSSProperties = {
    top: Math.min(target.y, window.innerHeight - 320),
    left: Math.min(target.x, window.innerWidth - 220),
  };

  return (
    <div
      className="fixed z-50 min-w-[200px] bg-[#252526] border border-[#454545] rounded-[4px] py-1 shadow-[0_8px_24px_rgba(0,0,0,0.65)] select-none"
      ref={menuRef}
      style={style}
    >
      {!target.isDir && (
        <div
          className={menuItemCls}
          onClick={() => {
            onClose();
            onOpenFile(target.path);
          }}
        >
          <span className="shrink-0 opacity-85"><FileCode size={13} strokeWidth={1.75} /></span>
          <span>打开文件</span>
        </div>
      )}

      <div
        className={menuItemCls}
        onClick={() => {
          onClose();
          onRevealInExplorer(fullAbsPath);
        }}
      >
        <span className="shrink-0 opacity-85"><FolderOpen size={13} strokeWidth={1.75} /></span>
        <span>在文件资源管理器中显示</span>
      </div>

      <div
        className={menuItemCls}
        onClick={() => {
          onClose();
          onOpenTerminal(fullAbsPath);
        }}
      >
        <span className="shrink-0 opacity-85"><Terminal size={13} strokeWidth={1.75} /></span>
        <span>在集成终端中打开</span>
      </div>

      <div className="h-[1px] bg-[#3c3c3c] my-1" />

      {target.area !== "staged" && (
        <div
          className={menuItemCls}
          onClick={() => {
            onClose();
            onStage(targetPaths);
          }}
        >
          <span className="shrink-0 opacity-85"><Plus size={13} strokeWidth={2} /></span>
          <span>{target.isDir ? "暂存整目录更改" : "暂存更改"}</span>
        </div>
      )}

      {target.area === "staged" && (
        <div
          className={menuItemCls}
          onClick={() => {
            onClose();
            onUnstage(targetPaths);
          }}
        >
          <span className="shrink-0 opacity-85"><Minus size={13} strokeWidth={2} /></span>
          <span>{target.isDir ? "取消暂存整目录" : "取消暂存更改"}</span>
        </div>
      )}

      {target.area === "unstaged" && (
        <div
          className={dangerItemCls}
          onClick={() => {
            onClose();
            onDiscard(targetPaths, target.isDir);
          }}
        >
          <span className="shrink-0"><Undo2 size={13} strokeWidth={1.75} /></span>
          <span>{target.isDir ? "放弃整目录更改…" : "放弃更改…"}</span>
        </div>
      )}

      {target.area === "untracked" && (
        <div
          className={dangerItemCls}
          onClick={() => {
            onClose();
            onCleanUntracked([target.path], target.isDir);
          }}
        >
          <span className="shrink-0"><Trash2 size={13} strokeWidth={1.75} /></span>
          <span>{target.isDir ? "删除未跟踪目录…" : "删除文件…"}</span>
        </div>
      )}

      <div className="h-[1px] bg-[#3c3c3c] my-1" />

      <div
        className={menuItemCls}
        onClick={() => {
          onClose();
          onCopyPath(target.path);
        }}
      >
        <span className="shrink-0 opacity-85"><Copy size={13} strokeWidth={1.75} /></span>
        <span>复制相对路径</span>
      </div>

      <div
        className={menuItemCls}
        onClick={() => {
          onClose();
          onCopyPath(fullAbsPath);
        }}
      >
        <span className="shrink-0 opacity-85"><Copy size={13} strokeWidth={1.75} /></span>
        <span>复制绝对路径</span>
      </div>

      <div
        className={menuItemCls}
        onClick={() => {
          onClose();
          onAddToGitignore(target.isDir ? `${target.path}/` : target.path);
        }}
      >
        <span className="shrink-0 opacity-85"><EyeOff size={13} strokeWidth={1.75} /></span>
        <span>添加至 .gitignore</span>
      </div>
    </div>
  );
});
