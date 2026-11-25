/**
 * VS Code Dark Modern 风格的编辑器/对比标签栏 (EditorTabBar)。
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  X,
  Lock,
  FileText,
  FileCode,
  Image as ImageIcon,
  FileDiff,
  File,
  Copy,
  FolderOpen,
  GitGraph,
} from "lucide-react";
import { IconButton } from "./IconButton";
import type { EditorTab, FileStatus } from "../types";

interface Props {
  tabs: EditorTab[];
  activeTabId: string | null;
  showGraphAction?: boolean;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onCloseOtherTabs?: (id: string) => void;
  onCloseTabsToRight?: (id: string) => void;
  onCloseAllTabs?: () => void;
  onShowGraph?: () => void;
  onCopyPath?: (path: string) => void;
  onRevealInExplorer?: (path: string) => void;
}

const STATUS_COLOR_MAP: Partial<Record<FileStatus, string>> = {
  added: "text-[#73c991]",
  untracked: "text-[#73c991]",
  modified: "text-[#e2c08d]",
  deleted: "text-[#c74e39]",
  renamed: "text-[#73c991]",
  conflicted: "text-[#e46767]",
  type_change: "text-[#e2c08d]",
};

function renderTabIcon(tab: EditorTab) {
  const ext = tab.path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "vue") return <span className="font-mono text-[11px] font-extrabold leading-none text-[#42b883]">V</span>;
  if (ext === "ts" || ext === "tsx") return <span className="font-mono text-[10px] font-extrabold leading-none text-[#3178c6]">TS</span>;
  if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") return <span className="font-mono text-[10px] font-extrabold leading-none text-[#f7df1e]">JS</span>;
  if (ext === "rs") return <span className="font-mono text-[10px] font-extrabold leading-none text-[#dea584]">RS</span>;
  if (ext === "py") return <span className="font-mono text-[10px] font-extrabold leading-none text-[#3572a5]">PY</span>;

  if (tab.kind !== "preview") {
    return <FileDiff size={13} className="text-[#3794ff]" />;
  }
  if (ext === "md" || ext === "markdown") {
    return <FileText size={13} className="text-[#3794ff]" />;
  }
  if (["png", "jpg", "jpeg", "svg", "webp", "gif", "ico"].includes(ext)) {
    return <ImageIcon size={13} className="text-[#c586c0]" />;
  }
  if (["json", "jsonc", "yaml", "yml", "toml", "xml", "css", "scss", "html"].includes(ext)) {
    return <FileCode size={13} className="text-[#e2c08d]" />;
  }
  return <File size={13} className="text-[#9d9d9d]" />;
}

export const EditorTabBar = React.memo(function EditorTabBar({
  tabs,
  activeTabId,
  showGraphAction = false,
  onSelectTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseTabsToRight,
  onCloseAllTabs,
  onShowGraph,
  onCopyPath,
  onRevealInExplorer,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    tab: EditorTab;
    index: number;
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (containerRef.current && (e.deltaY !== 0 || e.deltaX !== 0)) {
      containerRef.current.scrollLeft += e.deltaY || e.deltaX;
    }
  }, []);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (
        contextMenuRef.current &&
        !contextMenuRef.current.contains(e.target as Node)
      ) {
        setContextMenu(null);
      }
    };
    if (contextMenu) {
      window.addEventListener("mousedown", handleOutsideClick);
      return () => window.removeEventListener("mousedown", handleOutsideClick);
    }
  }, [contextMenu]);

  useEffect(() => {
    if (!activeTabId || !containerRef.current) return;
    const activeEl = containerRef.current.querySelector(
      `[data-tab-id="${CSS.escape(activeTabId)}"]`,
    ) as HTMLElement | null;
    if (activeEl) {
      activeEl.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      });
    }
  }, [activeTabId]);

  if (tabs.length === 0) {
    return null;
  }

  return (
    <div className="flex items-stretch h-[35px] bg-[#181818] border-b border-[#2b2b2b] shrink-0 select-none">
      <div
        ref={containerRef}
        className="flex items-stretch overflow-x-auto overflow-y-hidden flex-1 scrollbar-none"
        onWheel={handleWheel}
      >
        {tabs.map((tab, idx) => {
          const isActive = tab.id === activeTabId;
          const statusColor = tab.statusKind ? (STATUS_COLOR_MAP[tab.statusKind] ?? "text-[#cccccc]") : "text-[#cccccc]";

          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              className={`group inline-flex items-center h-full pl-3 pr-2 text-[12px] border-r border-[#2b2b2b] cursor-pointer whitespace-nowrap shrink-0 transition-colors ${
                isActive
                  ? "bg-[#1f1f1f] text-white font-medium relative after:content-[''] after:absolute after:left-0 after:right-0 after:-bottom-[1px] after:h-[1px] after:bg-[#1f1f1f]"
                  : "bg-[#181818] text-[#9d9d9d] hover:bg-[#1f1f1f]/60 hover:text-[#cccccc]"
              }`}
              onClick={() => onSelectTab(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setContextMenu({
                  x: e.clientX,
                  y: e.clientY,
                  tab,
                  index: idx,
                });
              }}
              title={tab.path}
            >
              <span className="inline-flex items-center justify-center mr-1.5 shrink-0">
                {renderTabIcon(tab)}
              </span>

              <span
                className={`whitespace-nowrap ${
                  tab.statusKind &&
                  (tab.kind === "preview" || tab.kind === "workdir-diff" || !isActive)
                    ? statusColor
                    : ""
                }`}
              >
                {tab.title}
              </span>

              {tab.subtitle && (
                <span
                  className={`ml-1.5 text-[11px] font-normal whitespace-nowrap ${
                    isActive ? "text-[#9d9d9d]" : "text-[#7a7a7a]"
                  }`}
                  title={tab.subtitle}
                >
                  {tab.subtitle}
                </span>
              )}

              {tab.statusLabel && (
                <span
                  className={`ml-1.5 text-[11px] font-semibold leading-none ${statusColor}`}
                  title={`状态: ${tab.statusKind || tab.statusLabel}`}
                >
                  {tab.statusLabel}
                </span>
              )}

              {tab.isReadOnly && (
                <span
                  className={`inline-flex items-center ml-1.5 shrink-0 ${
                    isActive ? "text-[#9d9d9d]" : "text-[#7a7a7a]"
                  }`}
                  title="只读"
                >
                  <Lock size={10} strokeWidth={2.2} />
                </span>
              )}

              <button
                type="button"
                className={`inline-flex items-center justify-center w-[18px] h-[18px] ml-2 border-none bg-transparent text-current rounded-[3px] p-0 cursor-pointer transition-opacity shrink-0 hover:bg-white/15 ${
                  isActive ? "opacity-75 hover:opacity-100" : "opacity-0 group-hover:opacity-75 hover:!opacity-100"
                }`}
                title="关闭 (Ctrl+W)"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                <X size={12} strokeWidth={2} />
              </button>
            </div>
          );
        })}
      </div>

      {(showGraphAction || tabs.length > 1) && (
        <div className="flex items-center gap-0.5 px-1.5 border-l border-[#2b2b2b] bg-[#181818] shrink-0">
          {showGraphAction && onShowGraph && (
            <IconButton
              tooltip="回到提交历史图"
              icon={<GitGraph size={13} />}
              onClick={onShowGraph}
            />
          )}
          {tabs.length > 1 && onCloseAllTabs && (
            <IconButton
              tooltip="全部关闭标签页"
              align="right"
              icon={<X size={13} />}
              onClick={onCloseAllTabs}
            />
          )}
        </div>
      )}

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-[175px] bg-[#252526] border border-[#454545] rounded-[4px] py-1 shadow-[0_6px_20px_rgba(0,0,0,0.6)] text-[12px] text-[#cccccc]"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 200),
            top: Math.min(contextMenu.y, window.innerHeight - 220),
          }}
        >
          <button
            type="button"
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 bg-transparent border-none text-inherit cursor-pointer hover:bg-[#04395e] hover:text-white"
            onClick={() => {
              onCloseTab(contextMenu.tab.id);
              setContextMenu(null);
            }}
          >
            <X size={13} />
            <span>关闭</span>
          </button>
          <button
            type="button"
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 bg-transparent border-none text-inherit cursor-pointer hover:bg-[#04395e] hover:text-white"
            onClick={() => {
              onCloseOtherTabs?.(contextMenu.tab.id);
              setContextMenu(null);
            }}
          >
            <span>关闭其他标签页</span>
          </button>
          {contextMenu.index < tabs.length - 1 && (
            <button
              type="button"
              className="flex items-center gap-2 w-full text-left px-3 py-1.5 bg-transparent border-none text-inherit cursor-pointer hover:bg-[#04395e] hover:text-white"
              onClick={() => {
                onCloseTabsToRight?.(contextMenu.tab.id);
                setContextMenu(null);
              }}
            >
              <span>关闭右侧标签页</span>
            </button>
          )}
          <button
            type="button"
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 bg-transparent border-none text-inherit cursor-pointer hover:bg-[#04395e] hover:text-white"
            onClick={() => {
              onCloseAllTabs?.();
              setContextMenu(null);
            }}
          >
            <span>全部关闭</span>
          </button>

          <div className="h-[1px] bg-[#3c3c3c] my-1" />

          {contextMenu.tab.path && (
            <>
              <button
                type="button"
                className="flex items-center gap-2 w-full text-left px-3 py-1.5 bg-transparent border-none text-inherit cursor-pointer hover:bg-[#04395e] hover:text-white"
                onClick={() => {
                  onCopyPath?.(contextMenu.tab.path);
                  setContextMenu(null);
                }}
              >
                <Copy size={13} />
                <span>复制相对路径</span>
              </button>
              <button
                type="button"
                className="flex items-center gap-2 w-full text-left px-3 py-1.5 bg-transparent border-none text-inherit cursor-pointer hover:bg-[#04395e] hover:text-white"
                onClick={() => {
                  onRevealInExplorer?.(contextMenu.tab.path);
                  setContextMenu(null);
                }}
              >
                <FolderOpen size={13} />
                <span>在文件管理器中显示</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
});
