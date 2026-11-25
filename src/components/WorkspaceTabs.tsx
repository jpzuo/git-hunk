import React, { useEffect, useRef, useState } from "react";
import { GitBranch, X, Plus, Pencil, XSquare } from "lucide-react";
import type { WorkspaceSummary } from "../types";

export interface WorkspaceTabsProps {
  workspaces: WorkspaceSummary[];
  activePath: string | null;
  onSwitch: (path: string) => void;
  onClose: (path: string) => void;
  onCloseOthers?: (path: string) => void;
  onRename?: (path: string, currentAlias: string | null, originalName: string) => void;
  onNew: () => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  ws: WorkspaceSummary;
}

export const WorkspaceTabs = React.memo(function WorkspaceTabs({
  workspaces,
  activePath,
  onSwitch,
  onClose,
  onCloseOthers,
  onRename,
  onNew,
}: WorkspaceTabsProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleGlobalClick = () => setContextMenu(null);
    window.addEventListener("click", handleGlobalClick);
    return () => window.removeEventListener("click", handleGlobalClick);
  }, []);

  useEffect(() => {
    const container = listRef.current;
    if (!container || !activePath) return;
    for (const child of Array.from(container.children)) {
      if (child instanceof HTMLElement && child.getAttribute("data-ws-path") === activePath) {
        child.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
        break;
      }
    }
  }, [activePath, workspaces.length]);

  return (
    <div className="flex items-center min-w-0 h-full overflow-hidden [-webkit-app-region:no-drag]">
      <div
        ref={listRef}
        className="flex items-center min-w-0 flex-1 overflow-x-auto scrollbar-none h-full"
        onWheel={(e) => {
          if (e.deltaY !== 0) {
            e.currentTarget.scrollLeft += e.deltaY;
          }
        }}
      >
        {workspaces.map((ws) => {
          const isActive = ws.is_active || ws.path === activePath;
          const branchLabel = ws.branch
            ? ws.detached
              ? `(${ws.branch})`
              : ws.branch
            : ws.detached
              ? "(detached)"
              : "(无分支)";

          const projectName = ws.alias || ws.project_name || ws.group || ws.original_name || ws.name;
          const tooltip = `项目: ${projectName}\n分支: ${branchLabel}\n路径: ${ws.path}${ws.alias ? `\n别名: ${ws.alias}` : ""}`;

          return (
            <div
              key={ws.path}
              data-ws-path={ws.path}
              className={`group flex items-center gap-1.5 h-full px-2.5 text-[12px] border-r border-[#2b2b2b] cursor-pointer whitespace-nowrap select-none transition-colors shrink-0 ${
                isActive
                  ? "bg-[#1f1f1f] text-white"
                  : "bg-[#181818] text-[#9d9d9d] hover:bg-[#222222] hover:text-[#cccccc]"
              }`}
              onClick={() => onSwitch(ws.path)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  e.stopPropagation();
                  onClose(ws.path);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setContextMenu({
                  x: e.clientX,
                  y: e.clientY,
                  ws,
                });
              }}
              title={tooltip}
            >
              <span className="font-medium whitespace-nowrap shrink-0">{projectName}</span>

              <span
                className="inline-flex items-center text-[11px] text-[#868686] font-mono whitespace-nowrap shrink-0"
                title={`当前分支: ${branchLabel}`}
              >
                <GitBranch size={11} strokeWidth={1.75} className="mr-0.5 shrink-0" />
                <span className="whitespace-nowrap">{branchLabel}</span>
              </span>

              {ws.has_changes && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-[#e2c08d] shrink-0"
                  title="有未提交的变更"
                />
              )}

              <button
                type="button"
                className={`inline-flex items-center justify-center w-4 h-4 rounded-[3px] border-none bg-transparent text-current hover:bg-white/15 cursor-pointer p-0 transition-opacity ${
                  isActive ? "opacity-75 hover:opacity-100" : "opacity-0 group-hover:opacity-75 hover:!opacity-100"
                }`}
                title="关闭工作区 (Ctrl+W)"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(ws.path);
                }}
              >
                <X size={12} strokeWidth={2} />
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        className="flex items-center justify-center w-6 h-6 mx-1 rounded-[4px] border-none bg-transparent text-[#9d9d9d] hover:bg-[#2a2d2e] hover:text-white cursor-pointer shrink-0 transition-colors p-0"
        title="打开新工作区 (Ctrl+O)"
        onClick={onNew}
      >
        <Plus size={13} strokeWidth={2} />
      </button>

      {contextMenu && (
        <div
          className="fixed z-50 min-w-[180px] bg-[#252526] border border-[#454545] rounded-[4px] py-1 shadow-[0_6px_20px_rgba(0,0,0,0.6)] text-[12px] text-[#cccccc]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {onRename && (
            <div
              className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-[#04395e] hover:text-white"
              onClick={() => {
                const ws = contextMenu.ws;
                setContextMenu(null);
                onRename(ws.path, ws.alias ?? null, ws.original_name ?? ws.name);
              }}
            >
              <Pencil size={12} strokeWidth={1.75} />
              <span>重命名显示别名...</span>
            </div>
          )}
          <div className="h-[1px] bg-[#3c3c3c] my-1" />
          <div
            className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-[#04395e] hover:text-white"
            onClick={() => {
              const p = contextMenu.ws.path;
              setContextMenu(null);
              onClose(p);
            }}
          >
            <X size={12} strokeWidth={2} />
            <span>关闭工作区</span>
          </div>
          {onCloseOthers && workspaces.length > 1 && (
            <div
              className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-[#04395e] hover:text-white"
              onClick={() => {
                const p = contextMenu.ws.path;
                setContextMenu(null);
                onCloseOthers(p);
              }}
            >
              <XSquare size={12} strokeWidth={1.75} />
              <span>关闭其他工作区</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
