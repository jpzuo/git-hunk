/**
 * 工作区文件目录面板（VS Code Dark Modern 100% 原子化实现）。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  ChevronsDownUp,
  Search,
  X,
  Copy,
  ExternalLink,
} from "lucide-react";
import { api } from "../api";
import { IconButton } from "./IconButton";
import { FileTypeIcon } from "./FileIcon";
import type { FileEntry, FileSearchResult, FileStatus, RepoStatus } from "../types";

const SEARCH_DEBOUNCE_MS = 300;
const MIN_SEARCH_LENGTH = 3;

interface SearchTreeNode {
  entry: FileEntry;
  isDirectMatch: boolean;
  children: SearchTreeNode[];
}

function normalizeSearchInput(raw: string): string {
  return raw.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function sortSearchNodes(nodes: SearchTreeNode[]) {
  nodes.sort((a, b) => {
    if (a.entry.is_dir !== b.entry.is_dir) {
      return a.entry.is_dir ? -1 : 1;
    }
    return a.entry.name.toLowerCase().localeCompare(b.entry.name.toLowerCase());
  });
  for (const node of nodes) {
    if (node.children.length > 0) {
      sortSearchNodes(node.children);
    }
  }
}

function buildSearchTree(matches: FileEntry[]): {
  roots: SearchTreeNode[];
  expandableDirs: string[];
} {
  const nodeMap = new Map<string, SearchTreeNode>();
  const roots: SearchTreeNode[] = [];
  const expandableDirs: string[] = [];

  const ensureDirNode = (dirPath: string): SearchTreeNode => {
    const existing = nodeMap.get(dirPath);
    if (existing) return existing;

    const lastSlash = dirPath.lastIndexOf("/");
    const name = lastSlash >= 0 ? dirPath.slice(lastSlash + 1) : dirPath;
    const node: SearchTreeNode = {
      entry: {
        name,
        path: dirPath,
        is_dir: true,
        is_markdown: false,
        is_image: false,
        size: 0,
      },
      isDirectMatch: false,
      children: [],
    };
    nodeMap.set(dirPath, node);

    if (lastSlash >= 0) {
      const parent = ensureDirNode(dirPath.slice(0, lastSlash));
      parent.children.push(node);
    } else {
      roots.push(node);
    }
    return node;
  };

  for (const item of matches) {
    if (item.is_dir) {
      const node = ensureDirNode(item.path);
      node.isDirectMatch = true;
      node.entry = item;
    } else {
      const existing = nodeMap.get(item.path);
      if (existing) {
        existing.isDirectMatch = true;
        existing.entry = item;
      } else {
        const node: SearchTreeNode = {
          entry: item,
          isDirectMatch: true,
          children: [],
        };
        nodeMap.set(item.path, node);
        const lastSlash = item.path.lastIndexOf("/");
        if (lastSlash >= 0) {
          const parent = ensureDirNode(item.path.slice(0, lastSlash));
          parent.children.push(node);
        } else {
          roots.push(node);
        }
      }
    }
  }

  sortSearchNodes(roots);
  for (const node of nodeMap.values()) {
    if (node.entry.is_dir && node.children.length > 0) {
      expandableDirs.push(node.entry.path);
    }
  }
  return { roots, expandableDirs };
}

function renderHighlightedName(
  name: string,
  query: string,
  isSelected: boolean,
): React.ReactNode {
  const qLower = query.toLowerCase();
  const nameLower = name.toLowerCase();
  let needle = qLower;
  let idx = nameLower.indexOf(needle);
  if (idx === -1 && qLower.includes("/")) {
    const tail = qLower.split("/").pop() ?? "";
    if (tail) {
      needle = tail;
      idx = nameLower.indexOf(needle);
    }
  }
  if (idx === -1 || needle.length === 0) {
    return name;
  }
  const end = idx + needle.length;
  return (
    <>
      {name.slice(0, idx)}
      <span
        className={
          isSelected
            ? "rounded-[2px] bg-white/25 px-[1px] font-semibold text-white"
            : "rounded-[2px] bg-[#613214] px-[1px] font-semibold text-[#f8c555]"
        }
      >
        {name.slice(idx, end)}
      </span>
      {name.slice(end)}
    </>
  );
}

interface Props {
  workdir: string | null;
  status?: RepoStatus | null;
  selectedPath: string | null;
  refreshSignal?: number;
  onSelectFile: (path: string) => void;
  onRevealInExplorer?: (path: string) => void;
  onOpenFileExternal?: (path: string) => void;
  onCopyPath?: (path: string) => void;
}

const EXPLORER_STATUS_LABEL: Record<FileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "!",
  type_change: "M",
};

const EXPLORER_STATUS_COLOR: Record<FileStatus, string> = {
  added: "text-[#73c991]",
  untracked: "text-[#73c991]",
  modified: "text-[#e2c08d]",
  deleted: "text-[#c74e39]",
  renamed: "text-[#73c991]",
  conflicted: "text-[#e46767]",
  type_change: "text-[#e2c08d]",
};

function getFileIcon(item: FileEntry) {
  if (item.is_dir) return null;
  return (
    <FileTypeIcon
      name={item.name}
      isMarkdown={item.is_markdown}
      isImage={item.is_image}
    />
  );
}

export const FileExplorerPanel = React.memo(function FileExplorerPanel({
  workdir,
  status,
  selectedPath,
  refreshSignal = 0,
  onSelectFile,
  onRevealInExplorer,
  onOpenFileExternal,
  onCopyPath,
}: Props) {
  const statusMap = useMemo(() => {
    const map = new Map<string, FileStatus>();
    if (!status) return map;
    for (const f of status.staged) map.set(f.path, f.status);
    for (const f of status.untracked) map.set(f.path, f.status);
    for (const f of status.unstaged) map.set(f.path, f.status);
    return map;
  }, [status]);
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
  const [childrenMap, setChildrenMap] = useState<Record<string, FileEntry[]>>({});
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [collapsedSearchDirs, setCollapsedSearchDirs] = useState<Set<string>>(new Set());
  const [expandedLeafSearchDirs, setExpandedLeafSearchDirs] = useState<Set<string>>(new Set());
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({});
  const [filterText, setFilterText] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [searchResult, setSearchResult] = useState<FileSearchResult | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchNonce, setSearchNonce] = useState(0);
  const [rootLoading, setRootLoading] = useState(false);

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    item: FileEntry;
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const rootLoadSeqRef = useRef(0);
  const expandedDirsRef = useRef<Set<string>>(expandedDirs);
  expandedDirsRef.current = expandedDirs;
  const isSearchModeRef = useRef(false);

  const loadRoot = useCallback(async () => {
    const reqSeq = ++rootLoadSeqRef.current;
    if (!workdir) {
      setRootLoading(false);
      setRootEntries([]);
      setChildrenMap({});
      return;
    }
    setRootLoading(true);
    try {
      const list = await api.readDir();
      if (reqSeq !== rootLoadSeqRef.current) return;
      setRootEntries(list);
    } catch (e) {
      if (reqSeq !== rootLoadSeqRef.current) return;
      console.error("加载根目录失败:", e);
      setRootEntries([]);
    } finally {
      if (reqSeq === rootLoadSeqRef.current) setRootLoading(false);
    }
  }, [workdir]);

  const loadDir = useCallback(async (dirPath: string) => {
    setLoadingMap((prev) => ({ ...prev, [dirPath]: true }));
    try {
      const list = await api.readDir(dirPath);
      setChildrenMap((prev) => ({ ...prev, [dirPath]: list }));
      return list;
    } catch (e) {
      console.error(`加载目录 [${dirPath}] 失败:`, e);
      return [];
    } finally {
      setLoadingMap((prev) => ({ ...prev, [dirPath]: false }));
    }
  }, []);

  useEffect(() => {
    setChildrenMap({});
    setExpandedDirs(new Set());
    setCollapsedSearchDirs(new Set());
    setExpandedLeafSearchDirs(new Set());
    setSearchResult(null);
    void loadRoot();
  }, [workdir, loadRoot]);

  const normalizedInput = useMemo(() => normalizeSearchInput(filterText), [filterText]);
  const inputCharCount = useMemo(() => Array.from(normalizedInput).length, [normalizedInput]);
  const isBelowMinLength =
    filterText.trim().length > 0 && inputCharCount < MIN_SEARCH_LENGTH;
  const isSearchMode = Array.from(debouncedQuery).length >= MIN_SEARCH_LENGTH;
  isSearchModeRef.current = isSearchMode;

  // 外部文件系统/分支变更时静默增量刷新根目录与当前已展开目录，保持展开态与筛选状态
  useEffect(() => {
    if (!workdir || refreshSignal === 0) return;
    let cancelled = false;
    const expanded = Array.from(expandedDirsRef.current);
    void (async () => {
      try {
        const nextRoot = await api.readDir();
        if (cancelled) return;
        setRootEntries(nextRoot);
        if (expanded.length > 0) {
          const pairs = await Promise.all(
            expanded.map(async (dir) => {
              try {
                return [dir, await api.readDir(dir)] as const;
              } catch {
                return [dir, null] as const;
              }
            }),
          );
          if (cancelled) return;
          setChildrenMap((prev) => {
            const next = { ...prev };
            for (const [dir, items] of pairs) {
              if (items === null) delete next[dir];
              else next[dir] = items;
            }
            return next;
          });
        }
        if (isSearchModeRef.current) {
          setSearchNonce((n) => n + 1);
        }
      } catch {
        /* 静默刷新失败不打断用户浏览 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workdir, refreshSignal]);
  const isPendingDebounce =
    inputCharCount >= MIN_SEARCH_LENGTH && normalizedInput !== debouncedQuery;

  // 搜索输入防抖；少于 3 个有效字符时不触发搜索
  useEffect(() => {
    if (inputCharCount < MIN_SEARCH_LENGTH) {
      setDebouncedQuery("");
      setSearchResult(null);
      setSearchLoading(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setDebouncedQuery(normalizedInput);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [normalizedInput, inputCharCount]);

  // 请求后端递归搜索匹配目录与文件
  useEffect(() => {
    if (!workdir || Array.from(debouncedQuery).length < MIN_SEARCH_LENGTH) {
      return;
    }
    let cancelled = false;
    setSearchLoading(true);
    void api
      .searchFiles(debouncedQuery)
      .then((res) => {
        if (cancelled) return;
        setSearchResult(res);
        // 搜索结果树默认全部展开
        setCollapsedSearchDirs(new Set());
        setExpandedLeafSearchDirs(new Set());
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("搜索目录或文件失败:", e);
        setSearchResult({ matches: [], truncated: false });
      })
      .finally(() => {
        if (!cancelled) setSearchLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workdir, debouncedQuery, searchNonce]);

  const searchTree = useMemo(
    () => (isSearchMode ? buildSearchTree(searchResult?.matches ?? []) : null),
    [isSearchMode, searchResult],
  );

  const handleToggleDir = useCallback(
    (dirPath: string) => {
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        if (next.has(dirPath)) {
          next.delete(dirPath);
        } else {
          next.add(dirPath);
          if (!childrenMap[dirPath]) {
            void loadDir(dirPath);
          }
        }
        return next;
      });
    },
    [childrenMap, loadDir],
  );

  const handleToggleSearchNode = useCallback(
    (node: SearchTreeNode) => {
      const dirPath = node.entry.path;
      if (node.children.length > 0) {
        setCollapsedSearchDirs((prev) => {
          const next = new Set(prev);
          if (next.has(dirPath)) next.delete(dirPath);
          else next.add(dirPath);
          return next;
        });
      } else {
        setExpandedLeafSearchDirs((prev) => {
          const next = new Set(prev);
          if (next.has(dirPath)) {
            next.delete(dirPath);
          } else {
            next.add(dirPath);
            if (!childrenMap[dirPath]) {
              void loadDir(dirPath);
            }
          }
          return next;
        });
      }
    },
    [childrenMap, loadDir],
  );

  const handleCollapseAll = useCallback(() => {
    if (isSearchMode && searchTree) {
      setCollapsedSearchDirs(new Set(searchTree.expandableDirs));
      setExpandedLeafSearchDirs(new Set());
    } else {
      setExpandedDirs(new Set());
    }
  }, [isSearchMode, searchTree]);

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

  const renderRow = (
    item: FileEntry,
    depth: number,
    isExpanded: boolean,
    onToggle: () => void,
    options?: {
      highlightQuery?: string;
      isDirectMatch?: boolean;
      dimAncestor?: boolean;
    },
  ) => {
    const isSelected = selectedPath === item.path;
    const isLoading = loadingMap[item.path];
    const paddingLeft = 8 + depth * 14;

    return (
      <div
        className={`flex items-center h-[23px] pr-2.5 cursor-pointer text-[12px] transition-colors ${
          isSelected
            ? "bg-[#04395e] text-white"
            : options?.dimAncestor
              ? "text-[#9d9d9d] hover:bg-[#2a2d2e] hover:text-[#cccccc]"
              : "text-[#cccccc] hover:bg-[#2a2d2e]"
        }`}
        style={{ paddingLeft }}
        onClick={() => {
          if (item.is_dir) {
            onToggle();
          } else {
            onSelectFile(item.path);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setContextMenu({
            x: e.clientX,
            y: e.clientY,
            item,
          });
        }}
        title={item.path}
      >
        {item.is_dir ? (
          <span
            className="flex items-center justify-center w-4 h-4 mr-0.5 text-[#9d9d9d] hover:text-white rounded-[2px] shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        ) : (
          <span className="w-4 h-4 mr-0.5 shrink-0" />
        )}

        <span className="flex items-center mr-1.5 shrink-0">
          {item.is_dir ? (
            isExpanded ? (
              <FolderOpen size={14} className="text-[#dcb67a]" />
            ) : (
              <Folder size={14} className="text-[#dcb67a]" />
            )
          ) : (
            getFileIcon(item)
          )}
        </span>

        <span
          className={`truncate flex-1 ${
            !item.is_dir && !isSelected && statusMap.has(item.path)
              ? EXPLORER_STATUS_COLOR[statusMap.get(item.path)!]
              : ""
          }`}
        >
          {options?.isDirectMatch && options.highlightQuery
            ? renderHighlightedName(item.name, options.highlightQuery, isSelected)
            : item.name}
        </span>

        {item.is_markdown && (
          <span
            className={`text-[9px] leading-[12px] px-1 rounded-[2px] ml-1.5 font-semibold uppercase shrink-0 border ${
              isSelected
                ? "bg-white/15 text-white border-transparent"
                : "bg-[#252526] text-[#9d9d9d] border-[#3c3c3c]"
            }`}
            title="Markdown 专属富文本支持"
          >
            md
          </span>
        )}

        {!item.is_dir && statusMap.has(item.path) && (
          <span
            className={`text-[11px] font-semibold ml-1.5 shrink-0 ${
              isSelected ? "text-white" : EXPLORER_STATUS_COLOR[statusMap.get(item.path)!]
            }`}
            title={`Git 状态: ${statusMap.get(item.path)}`}
          >
            {EXPLORER_STATUS_LABEL[statusMap.get(item.path)!]}
          </span>
        )}

        {isLoading && (
          <RefreshCw size={11} className="animate-spin text-[#868686] ml-1 shrink-0" />
        )}
      </div>
    );
  };

  const renderDirChildrenPlaceholder = (dirPath: string, depth: number) => {
    const paddingLeft = 8 + depth * 14;
    return (
      <div>
        {childrenMap[dirPath] ? (
          childrenMap[dirPath].length > 0 ? (
            childrenMap[dirPath].map((child) => renderItem(child, depth + 1))
          ) : (
            <div
              className="text-[11px] text-[#868686] leading-6 italic"
              style={{ paddingLeft: paddingLeft + 20 }}
            >
              (空目录)
            </div>
          )
        ) : (
          <div
            className="text-[11px] text-[#868686] leading-6 italic"
            style={{ paddingLeft: paddingLeft + 20 }}
          >
            加载中…
          </div>
        )}
      </div>
    );
  };

  const renderItem = (item: FileEntry, depth: number) => {
    const isExpanded = expandedDirs.has(item.path);
    return (
      <div key={item.path} className="select-none">
        {renderRow(item, depth, isExpanded, () => handleToggleDir(item.path))}
        {item.is_dir && isExpanded && renderDirChildrenPlaceholder(item.path, depth)}
      </div>
    );
  };

  const renderSearchNode = (node: SearchTreeNode, depth: number): React.ReactNode => {
    const { entry, isDirectMatch, children } = node;
    const hasSearchChildren = children.length > 0;
    const isExpanded = hasSearchChildren
      ? !collapsedSearchDirs.has(entry.path)
      : entry.is_dir && expandedLeafSearchDirs.has(entry.path);

    return (
      <div key={entry.path} className="select-none">
        {renderRow(entry, depth, isExpanded, () => handleToggleSearchNode(node), {
          highlightQuery: debouncedQuery,
          isDirectMatch,
          dimAncestor: entry.is_dir && !isDirectMatch,
        })}
        {entry.is_dir && isExpanded && (
          hasSearchChildren ? (
            <div>{children.map((child) => renderSearchNode(child, depth + 1))}</div>
          ) : (
            renderDirChildrenPlaceholder(entry.path, depth)
          )
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#181818]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#2b2b2b] min-h-[35px] shrink-0">
        <span
          className="text-[11px] font-semibold uppercase tracking-wider text-[#cccccc]"
          title={workdir || undefined}
        >
          资源管理器
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
          <IconButton
            tooltip="全部折叠"
            icon={<ChevronsDownUp size={14} />}
            onClick={handleCollapseAll}
          />
          <IconButton
            tooltip="刷新文件目录"
            align="right"
            icon={<RefreshCw size={13} className={rootLoading || searchLoading ? "animate-spin" : ""} />}
            onClick={() => {
              setChildrenMap({});
              void loadRoot();
              if (isSearchMode) {
                setSearchNonce((n) => n + 1);
              }
            }}
          />
        </div>
      </div>

      <div className="px-2.5 py-1.5 border-b border-[#2b2b2b] bg-[#181818] shrink-0">
        <div className="relative flex items-center bg-[#313131] border border-[#3c3c3c] focus-within:border-[#0078d4] rounded-[2px] px-2 h-[26px]">
          <Search size={12} className="text-[#868686] shrink-0" />
          <input
            type="text"
            className="border-none bg-transparent text-[#cccccc] placeholder-[#868686] text-[12px] w-full outline-none ml-1.5"
            placeholder="搜索目录或文件名（至少 3 个字符）…"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && filterText) {
                e.stopPropagation();
                setFilterText("");
              }
            }}
          />
          {(searchLoading || isPendingDebounce) && (
            <RefreshCw size={11} className="animate-spin text-[#868686] ml-1 shrink-0" />
          )}
          {filterText && (
            <button
              type="button"
              className="flex items-center justify-center border-none bg-transparent text-[#9d9d9d] hover:text-white p-0.5 ml-0.5 cursor-pointer"
              onClick={() => setFilterText("")}
              title="清除搜索"
            >
              <X size={12} />
            </button>
          )}
        </div>
        {isBelowMinLength && (
          <div className="mt-1 text-[11px] text-[#868686]">
            至少输入 {MIN_SEARCH_LENGTH} 个字符后开始搜索（当前 {inputCharCount}/{MIN_SEARCH_LENGTH}）
          </div>
        )}
        {!isBelowMinLength && isSearchMode && !searchLoading && searchResult && (
          <div className="mt-1 flex items-center justify-between text-[11px] text-[#868686]">
            <span>
              命中 {searchResult.matches.length} 项
              {searchResult.truncated ? "（已展示前 500 项）" : ""}
            </span>
            <span>树形全部展开</span>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
        {isSearchMode ? (
          searchLoading && !searchResult ? (
            <div className="py-9 px-4 text-center text-[#868686] text-[12px]">
              正在搜索工作区目录与文件…
            </div>
          ) : searchTree && searchTree.roots.length > 0 ? (
            <div className="py-1">
              {searchTree.roots.map((node) => renderSearchNode(node, 0))}
            </div>
          ) : searchLoading ? (
            <div className="py-9 px-4 text-center text-[#868686] text-[12px]">
              正在搜索工作区目录与文件…
            </div>
          ) : (
            <div className="py-9 px-4 text-center text-[#868686] text-[12px]">
              未找到匹配 "{debouncedQuery}" 的目录或文件
            </div>
          )
        ) : rootLoading && rootEntries.length === 0 ? (
          <div className="py-9 px-4 text-center text-[#868686] text-[12px]">正在扫描工作区文件…</div>
        ) : rootEntries.length === 0 ? (
          <div className="py-9 px-4 text-center text-[#868686] text-[12px]">当前工作区暂无文件</div>
        ) : (
          <div className="py-1">{rootEntries.map((item) => renderItem(item, 0))}</div>
        )}
      </div>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-[185px] bg-[#252526] border border-[#454545] rounded-[4px] py-1 shadow-[0_6px_20px_rgba(0,0,0,0.6)] text-[12px] text-[#cccccc]"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 220),
            top: Math.min(contextMenu.y, window.innerHeight - 160),
          }}
        >
          <div
            className="px-3 py-1 text-[11px] text-[#868686] font-semibold truncate"
            title={contextMenu.item.path}
          >
            {contextMenu.item.name}
          </div>
          <div className="h-[1px] bg-[#3c3c3c] my-1" />
          <button
            type="button"
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 bg-transparent border-none text-inherit cursor-pointer hover:bg-[#04395e] hover:text-white"
            onClick={() => {
              onRevealInExplorer?.(contextMenu.item.path);
              setContextMenu(null);
            }}
          >
            <ExternalLink size={13} />
            <span>在文件管理器中显示</span>
          </button>
          <button
            type="button"
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 bg-transparent border-none text-inherit cursor-pointer hover:bg-[#04395e] hover:text-white"
            onClick={() => {
              onOpenFileExternal?.(contextMenu.item.path);
              setContextMenu(null);
            }}
          >
            <ExternalLink size={13} />
            <span>在系统默认应用中打开</span>
          </button>
          <div className="h-[1px] bg-[#3c3c3c] my-1" />
          <button
            type="button"
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 bg-transparent border-none text-inherit cursor-pointer hover:bg-[#04395e] hover:text-white"
            onClick={() => {
              onCopyPath?.(contextMenu.item.path);
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
              void navigator.clipboard.writeText(contextMenu.item.name);
              setContextMenu(null);
            }}
          >
            <Copy size={13} />
            <span>复制文件名</span>
          </button>
        </div>
      )}
    </div>
  );
});
