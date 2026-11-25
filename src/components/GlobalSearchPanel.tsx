/**
 * 全局文件内容搜索侧栏面板（100% 对标 VS Code Search Viewlet，Tailwind v4 + Dark Modern）。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Eraser,
  Filter,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  X,
} from "lucide-react";
import { api } from "../api";
import { FileTypeIcon } from "./FileIcon";
import { IconButton } from "./IconButton";
import type {
  ContentSearchResult,
  FileContentMatch,
  LineContentMatch,
  MatchRange,
  SearchHighlightSpec,
} from "../types";

const CONTENT_SEARCH_DEBOUNCE_MS = 300;
const MIN_AUTO_SEARCH_LEN = 2;

export interface GlobalSearchState {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  includePattern: string;
  excludePattern: string;
  useIgnoreFiles: boolean;
  detailsOpen: boolean;
}

export function createDefaultGlobalSearchState(): GlobalSearchState {
  return {
    query: "",
    caseSensitive: false,
    wholeWord: false,
    useRegex: false,
    includePattern: "",
    excludePattern: "",
    useIgnoreFiles: true,
    detailsOpen: false,
  };
}

interface Props {
  workdir: string | null;
  searchState: GlobalSearchState;
  onSearchStateChange: (next: GlobalSearchState) => void;
  activePath: string | null;
  activeLine?: number;
  focusNonce?: number;
  onSelectMatch: (
    path: string,
    lineNumber: number,
    column: number,
    highlight: SearchHighlightSpec,
  ) => void;
  onCopyPath?: (path: string) => void;
}

function renderMatchedSnippet(
  text: string,
  ranges: MatchRange[],
  isActiveRow: boolean,
): React.ReactNode {
  if (!ranges || ranges.length === 0) return text;
  const parts: React.ReactNode[] = [];
  let cursor = 0;

  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    const start = Math.max(cursor, Math.min(r.start, text.length));
    const end = Math.max(start, Math.min(r.end, text.length));
    if (start > cursor) {
      parts.push(text.slice(cursor, start));
    }
    if (end > start) {
      parts.push(
        <span
          key={i}
          className={
            isActiveRow
              ? "rounded-[2px] bg-[#9e6a03] px-[1px] font-semibold text-white ring-1 ring-[#f8c555]/80"
              : "rounded-[2px] bg-[#613214] px-[1px] font-semibold text-[#f8c555]"
          }
        >
          {text.slice(start, end)}
        </span>,
      );
    }
    cursor = end;
  }

  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return parts;
}

export const GlobalSearchPanel = React.memo(function GlobalSearchPanel({
  workdir,
  searchState,
  onSearchStateChange,
  activePath,
  activeLine,
  focusNonce = 0,
  onSelectMatch,
  onCopyPath,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);
  const debounceRef = useRef<number | null>(null);

  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [result, setResult] = useState<ContentSearchResult | null>(null);
  const [lastExecutedKey, setLastExecutedKey] = useState<string>("");
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [dismissedFiles, setDismissedFiles] = useState<Set<string>>(new Set());
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);

  const patchState = useCallback(
    (patch: Partial<GlobalSearchState>) => {
      onSearchStateChange({ ...searchState, ...patch });
    },
    [onSearchStateChange, searchState],
  );

  // 切到搜索视图 / Ctrl+Shift+F 时自动聚焦输入框并选中文本
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (el.value) {
      el.select();
    }
  }, [focusNonce]);

  const executeSearch = useCallback(
    async (state: GlobalSearchState) => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }

      const raw = state.query;
      const effectiveQuery = state.useRegex ? raw : raw.trim();
      if (!workdir || effectiveQuery.length === 0) {
        seqRef.current += 1;
        setLoading(false);
        setErrorMsg(null);
        setResult(null);
        setLastExecutedKey("");
        void api.cancelContentSearch().catch(() => {});
        return;
      }

      const key = JSON.stringify([
        workdir,
        state.query,
        state.caseSensitive,
        state.wholeWord,
        state.useRegex,
        state.includePattern,
        state.excludePattern,
        state.useIgnoreFiles,
      ]);

      const reqSeq = ++seqRef.current;
      setLoading(true);
      setErrorMsg(null);

      try {
        const res = await api.searchContent({
          query: state.query,
          case_sensitive: state.caseSensitive,
          whole_word: state.wholeWord,
          use_regex: state.useRegex,
          include_pattern: state.includePattern.trim() || undefined,
          exclude_pattern: state.excludePattern.trim() || undefined,
          use_ignore_files: state.useIgnoreFiles,
        });
        if (reqSeq !== seqRef.current) return;
        setResult(res);
        setLastExecutedKey(key);
        setDismissedFiles(new Set());
        // 默认全部展开（超过 120 个文件时默认折叠以保持流畅）
        if (res.files.length > 120) {
          setCollapsedFiles(new Set(res.files.slice(40).map((f) => f.path)));
        } else {
          setCollapsedFiles(new Set());
        }
      } catch (e) {
        if (reqSeq !== seqRef.current) return;
        setErrorMsg(String(e));
        setResult(null);
      } finally {
        if (reqSeq === seqRef.current) {
          setLoading(false);
        }
      }
    },
    [workdir],
  );

  // 工作区切换或条件变化时的防抖检索
  const currentStateKey = useMemo(
    () =>
      JSON.stringify([
        workdir,
        searchState.query,
        searchState.caseSensitive,
        searchState.wholeWord,
        searchState.useRegex,
        searchState.includePattern,
        searchState.excludePattern,
        searchState.useIgnoreFiles,
      ]),
    [
      workdir,
      searchState.query,
      searchState.caseSensitive,
      searchState.wholeWord,
      searchState.useRegex,
      searchState.includePattern,
      searchState.excludePattern,
      searchState.useIgnoreFiles,
    ],
  );

  const effectiveLength = useMemo(
    () => Array.from(searchState.useRegex ? searchState.query : searchState.query.trim()).length,
    [searchState.query, searchState.useRegex],
  );

  useEffect(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    if (!workdir || effectiveLength === 0) {
      seqRef.current += 1;
      setLoading(false);
      setErrorMsg(null);
      setResult(null);
      setLastExecutedKey("");
      return;
    }

    // 普通搜索至少 2 个字符或正则模式下非空时自动防抖；1 个字符可按 Enter 强制检索
    if (!searchState.useRegex && effectiveLength < MIN_AUTO_SEARCH_LEN) {
      return;
    }

    if (currentStateKey === lastExecutedKey) {
      return;
    }

    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      void executeSearch(searchState);
    }, CONTENT_SEARCH_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [
    workdir,
    currentStateKey,
    lastExecutedKey,
    effectiveLength,
    searchState,
    executeSearch,
  ]);

  const visibleFiles = useMemo(() => {
    if (!result) return [];
    if (dismissedFiles.size === 0) return result.files;
    return result.files.filter((f) => !dismissedFiles.has(f.path));
  }, [result, dismissedFiles]);

  const visibleMatchCount = useMemo(
    () => visibleFiles.reduce((acc, f) => acc + f.match_count, 0),
    [visibleFiles],
  );

  // 计算扁平化键盘导航列表
  const flatItems = useMemo(() => {
    const list: Array<{
      key: string;
      file: FileContentMatch;
      match: LineContentMatch;
    }> = [];
    for (const file of visibleFiles) {
      if (collapsedFiles.has(file.path)) continue;
      for (const m of file.matches) {
        list.push({
          key: `${file.path}:${m.line_number}:${m.column}`,
          file,
          match: m,
        });
      }
    }
    return list;
  }, [visibleFiles, collapsedFiles]);

  const highlightSpec: SearchHighlightSpec = useMemo(
    () => ({
      query: searchState.query,
      caseSensitive: searchState.caseSensitive,
      wholeWord: searchState.wholeWord,
      useRegex: searchState.useRegex,
    }),
    [
      searchState.query,
      searchState.caseSensitive,
      searchState.wholeWord,
      searchState.useRegex,
    ],
  );

  const triggerJump = useCallback(
    (file: FileContentMatch, match: LineContentMatch) => {
      const key = `${file.path}:${match.line_number}:${match.column}`;
      setSelectedRowKey(key);
      onSelectMatch(file.path, match.line_number, match.column, {
        ...highlightSpec,
        activeLine: match.line_number,
        activeColumn: match.column,
      });
    },
    [highlightSpec, onSelectMatch],
  );

  const allCollapsed =
    visibleFiles.length > 0 && visibleFiles.every((f) => collapsedFiles.has(f.path));

  const toggleCollapseAll = useCallback(() => {
    if (allCollapsed) {
      setCollapsedFiles(new Set());
    } else {
      setCollapsedFiles(new Set(visibleFiles.map((f) => f.path)));
    }
  }, [allCollapsed, visibleFiles]);

  const handleClear = useCallback(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    seqRef.current += 1;
    setLoading(false);
    setErrorMsg(null);
    setResult(null);
    setLastExecutedKey("");
    setCollapsedFiles(new Set());
    setDismissedFiles(new Set());
    setSelectedRowKey(null);
    void api.cancelContentSearch().catch(() => {});
    onSearchStateChange({
      ...searchState,
      query: "",
    });
    inputRef.current?.focus();
  }, [onSearchStateChange, searchState]);

  const handleStopSearch = useCallback(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    seqRef.current += 1;
    setLoading(false);
    void api.cancelContentSearch().catch(() => {});
  }, []);

  const handleKeyDownTree = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (flatItems.length === 0) return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;

      const curIdx = selectedRowKey
        ? flatItems.findIndex((it) => it.key === selectedRowKey)
        : -1;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = flatItems[Math.min(flatItems.length - 1, curIdx + 1)];
        if (next) triggerJump(next.file, next.match);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prevIdx = curIdx <= 0 ? 0 : curIdx - 1;
        const prev = flatItems[prevIdx];
        if (prev) triggerJump(prev.file, prev.match);
      } else if (e.key === "Enter" && curIdx >= 0) {
        e.preventDefault();
        const cur = flatItems[curIdx];
        triggerJump(cur.file, cur.match);
      }
    },
    [flatItems, selectedRowKey, triggerJump],
  );

  const hasExtraFilters =
    Boolean(searchState.includePattern.trim()) ||
    Boolean(searchState.excludePattern.trim()) ||
    !searchState.useIgnoreFiles;

  const isTooShortAuto =
    !searchState.useRegex &&
    effectiveLength === 1 &&
    currentStateKey !== lastExecutedKey;

  const isPendingDebounce =
    effectiveLength > 0 &&
    !isTooShortAuto &&
    currentStateKey !== lastExecutedKey &&
    !loading &&
    !errorMsg;

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-[#181818]"
      onKeyDown={handleKeyDownTree}
    >
      {/* 头部标题 + 纯图标工具栏 */}
      <div className="flex min-h-[35px] shrink-0 items-center justify-between border-b border-[#2b2b2b] px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[#cccccc]">
          全局搜索
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            tooltip="刷新搜索结果"
            disabled={!workdir || effectiveLength === 0 || loading}
            icon={<RefreshCw size={13} className={loading ? "animate-spin" : ""} />}
            onClick={() => void executeSearch(searchState)}
          />
          <IconButton
            tooltip={allCollapsed ? "全部展开" : "全部折叠"}
            disabled={visibleFiles.length === 0}
            icon={allCollapsed ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
            onClick={toggleCollapseAll}
          />
          <IconButton
            tooltip="清空搜索与结果"
            align="right"
            disabled={!searchState.query && !result && !errorMsg}
            icon={<Eraser size={13} />}
            onClick={handleClear}
          />
        </div>
      </div>

      {/* 主搜索输入区（VS Code 内嵌 Aa / ab / .* 模式切换） */}
      <div className="shrink-0 border-b border-[#2b2b2b] bg-[#181818] px-2.5 py-2">
        <div className="flex h-[28px] items-center rounded-[2px] border border-[#3c3c3c] bg-[#313131] pl-2 pr-1 focus-within:border-[#0078d4]">
          <Search size={12} className="mr-1.5 shrink-0 text-[#868686]" />
          <input
            ref={inputRef}
            type="text"
            value={searchState.query}
            onChange={(e) => patchState({ query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                void executeSearch(searchState);
              } else if (e.key === "Escape" && searchState.query) {
                e.stopPropagation();
                handleClear();
              }
            }}
            placeholder="搜索文件内容（Enter 立即搜索）…"
            className="min-w-0 flex-1 border-none bg-transparent text-[12px] text-[#cccccc] placeholder-[#868686] outline-none"
          />
          {searchState.query && (
            <button
              type="button"
              title="清除输入"
              className="mr-0.5 flex h-[18px] w-[18px] shrink-0 cursor-pointer items-center justify-center rounded-[2px] border-none bg-transparent text-[#9d9d9d] hover:bg-[#3c3c3c] hover:text-white"
              onClick={handleClear}
            >
              <X size={11} />
            </button>
          )}
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              title="区分大小写 (Aa)"
              aria-pressed={searchState.caseSensitive}
              className={`flex h-[20px] min-w-[21px] cursor-pointer items-center justify-center rounded-[2px] px-1 font-mono text-[11px] font-semibold transition-colors ${
                searchState.caseSensitive
                  ? "border border-[#0078d4] bg-[#0078d4]/25 text-[#75beff]"
                  : "border border-transparent bg-transparent text-[#868686] hover:bg-[#3c3c3c] hover:text-white"
              }`}
              onClick={() => patchState({ caseSensitive: !searchState.caseSensitive })}
            >
              Aa
            </button>
            <button
              type="button"
              title="全词匹配 (ab)"
              aria-pressed={searchState.wholeWord}
              className={`flex h-[20px] min-w-[21px] cursor-pointer items-center justify-center rounded-[2px] px-1 font-mono text-[11px] font-semibold underline decoration-1 underline-offset-2 transition-colors ${
                searchState.wholeWord
                  ? "border border-[#0078d4] bg-[#0078d4]/25 text-[#75beff]"
                  : "border border-transparent bg-transparent text-[#868686] hover:bg-[#3c3c3c] hover:text-white"
              }`}
              onClick={() => patchState({ wholeWord: !searchState.wholeWord })}
            >
              ab
            </button>
            <button
              type="button"
              title="使用正则表达式 (.*)"
              aria-pressed={searchState.useRegex}
              className={`flex h-[20px] min-w-[21px] cursor-pointer items-center justify-center rounded-[2px] px-1 font-mono text-[11px] font-semibold transition-colors ${
                searchState.useRegex
                  ? "border border-[#0078d4] bg-[#0078d4]/25 text-[#75beff]"
                  : "border border-transparent bg-transparent text-[#868686] hover:bg-[#3c3c3c] hover:text-white"
              }`}
              onClick={() => patchState({ useRegex: !searchState.useRegex })}
            >
              .*
            </button>
          </div>
        </div>

        {/* 切换包含/排除过滤区按钮 */}
        <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px]">
          <button
            type="button"
            className="flex cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-[#9d9d9d] hover:text-white"
            onClick={() => patchState({ detailsOpen: !searchState.detailsOpen })}
          >
            {searchState.detailsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <Filter size={11} />
            <span>包含 / 排除文件</span>
            {hasExtraFilters && (
              <span className="ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-[#3794ff]" />
            )}
          </button>

          {(loading || isPendingDebounce) && (
            <span className="flex items-center gap-1.5 text-[#868686]">
              <RefreshCw size={10} className="animate-spin" />
              <span>搜索中…</span>
              {loading && (
                <button
                  type="button"
                  title="立即停止当前后台搜索"
                  className="inline-flex cursor-pointer items-center gap-1 rounded-[2px] border border-[#3c3c3c] bg-[#252526] px-1.5 py-[1px] text-[10.5px] text-[#cccccc] transition-colors hover:border-[#f14c4c]/60 hover:bg-[#5a1d1d] hover:text-white"
                  onClick={handleStopSearch}
                >
                  <Square size={8} className="fill-current" />
                  <span>停止</span>
                </button>
              )}
            </span>
          )}
        </div>

        {/* 包含与排除路径条件 */}
        {searchState.detailsOpen && (
          <div className="mt-2 flex flex-col gap-2">
            <div>
              <div className="mb-1 text-[11px] text-[#9d9d9d]">要包含的文件</div>
              <input
                type="text"
                value={searchState.includePattern}
                onChange={(e) => patchState({ includePattern: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void executeSearch(searchState);
                  }
                }}
                placeholder="例如: src/**, *.ts, !*.test.ts"
                className="h-[24px] w-full rounded-[2px] border border-[#3c3c3c] bg-[#313131] px-2 text-[11.5px] text-[#cccccc] placeholder-[#868686] outline-none focus:border-[#0078d4]"
              />
            </div>

            <div>
              <div className="mb-1 text-[11px] text-[#9d9d9d]">要排除的文件</div>
              <div className="flex h-[24px] items-center rounded-[2px] border border-[#3c3c3c] bg-[#313131] pl-2 pr-1 focus-within:border-[#0078d4]">
                <input
                  type="text"
                  value={searchState.excludePattern}
                  onChange={(e) => patchState({ excludePattern: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void executeSearch(searchState);
                    }
                  }}
                  placeholder="例如: dist/**, *.min.js"
                  className="min-w-0 flex-1 border-none bg-transparent text-[11.5px] text-[#cccccc] placeholder-[#868686] outline-none"
                />
                <button
                  type="button"
                  title="启用 .gitignore 与默认排除规则 (node_modules / target 等)"
                  aria-pressed={searchState.useIgnoreFiles}
                  className={`flex h-[18px] w-[20px] shrink-0 cursor-pointer items-center justify-center rounded-[2px] transition-colors ${
                    searchState.useIgnoreFiles
                      ? "border border-[#0078d4] bg-[#0078d4]/25 text-[#75beff]"
                      : "border border-transparent bg-transparent text-[#868686] hover:bg-[#3c3c3c] hover:text-white"
                  }`}
                  onClick={() => patchState({ useIgnoreFiles: !searchState.useIgnoreFiles })}
                >
                  <ShieldCheck size={12} />
                </button>
              </div>
            </div>
          </div>
        )}

        {isTooShortAuto && (
          <div className="mt-1.5 text-[11px] text-[#868686]">
            输入至少 {MIN_AUTO_SEARCH_LEN} 个字符自动搜索，或按 Enter 立即搜索
          </div>
        )}

        {errorMsg && (
          <div className="mt-1.5 rounded-[2px] border border-[#be1100] bg-[#5a1d1d] px-2 py-1 text-[11px] text-[#f48771] break-words">
            {errorMsg}
          </div>
        )}
      </div>

      {/* 结果统计栏 */}
      {result && !errorMsg && (
        <div className="flex shrink-0 items-center justify-between border-b border-[#2b2b2b] bg-[#181818] px-3 py-1 text-[11px] text-[#868686]">
          <span>
            {visibleFiles.length > 0
              ? `在 ${visibleFiles.length} 个文件中找到 ${visibleMatchCount} 个结果`
              : "未找到匹配结果"}
          </span>
          {result.truncated && (
            <span
              className="text-[#e2c08d]"
              title={
                result.timed_out
                  ? "已达 15 秒扫描保护上限，仅展示已扫描结果，建议补充包含/排除过滤条件"
                  : "已达到最大返回数量上限，请缩小包含范围或增加过滤条件"
              }
            >
              {result.timed_out ? "已限时截断" : "已截断"}
            </span>
          )}
        </div>
      )}

      {/* 按文件树分组的命中列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {!workdir ? (
          <div className="px-4 py-9 text-center text-[12px] text-[#868686]">请先打开一个工作区</div>
        ) : effectiveLength === 0 ? (
          <div className="px-4 py-9 text-center text-[12px] leading-relaxed text-[#868686]">
            输入关键词、正则表达式，或展开「包含 / 排除文件」精准搜索工作区文件内容
          </div>
        ) : loading && !result ? (
          <div className="px-4 py-9 text-center text-[12px] text-[#868686]">
            正在全局搜索工作区文件内容…
          </div>
        ) : result && visibleFiles.length === 0 ? (
          <div className="px-4 py-9 text-center text-[12px] text-[#868686]">
            {result.files.length > 0
              ? "已移除全部搜索结果条目"
              : `未找到包含 "${searchState.query}" 的文件内容`}
          </div>
        ) : result ? (
          <div className="py-1">
            {visibleFiles.map((file) => {
              const isCollapsed = collapsedFiles.has(file.path);
              const lastSlash = file.path.lastIndexOf("/");
              const dirPart = lastSlash >= 0 ? file.path.slice(0, lastSlash) : "";

              return (
                <div key={file.path} className="select-none">
                  {/* 文件分组头 */}
                  <div
                    className="group flex h-[24px] cursor-pointer items-center gap-1 px-2 text-[12px] text-[#cccccc] hover:bg-[#2a2d2e]"
                    title={file.path}
                    onClick={() => {
                      setCollapsedFiles((prev) => {
                        const next = new Set(prev);
                        if (next.has(file.path)) next.delete(file.path);
                        else next.add(file.path);
                        return next;
                      });
                    }}
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[#9d9d9d]">
                      {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    </span>
                    <FileTypeIcon
                      name={file.name}
                      isMarkdown={file.is_markdown}
                      isImage={file.is_image}
                    />
                    <span className="ml-0.5 shrink-0 font-medium text-[#cccccc]">
                      {file.name}
                    </span>
                    {dirPart && (
                      <span className="min-w-0 flex-1 truncate text-[11px] text-[#868686]">
                        {dirPart}
                      </span>
                    )}
                    {!dirPart && <span className="flex-1" />}

                    <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                      {onCopyPath && (
                        <button
                          type="button"
                          title="复制相对路径"
                          className="flex h-[18px] w-[18px] cursor-pointer items-center justify-center rounded-[2px] border-none bg-transparent text-[#9d9d9d] hover:bg-[#3c3c3c] hover:text-white"
                          onClick={(e) => {
                            e.stopPropagation();
                            onCopyPath(file.path);
                          }}
                        >
                          <Copy size={11} />
                        </button>
                      )}
                      <button
                        type="button"
                        title="从结果中移除"
                        className="flex h-[18px] w-[18px] cursor-pointer items-center justify-center rounded-[2px] border-none bg-transparent text-[#9d9d9d] hover:bg-[#3c3c3c] hover:text-white"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDismissedFiles((prev) => new Set(prev).add(file.path));
                        }}
                      >
                        <X size={11} />
                      </button>
                    </div>
                    <span className="shrink-0 rounded-full bg-[#333333] px-1.5 py-px text-[10px] tabular-nums text-[#cccccc]">
                      {file.match_count}
                    </span>
                  </div>

                  {/* 命中行明细 */}
                  {!isCollapsed && (
                    <div>
                      {file.matches.map((m) => {
                        const rowKey = `${file.path}:${m.line_number}:${m.column}`;
                        const isActiveRow =
                          selectedRowKey === rowKey ||
                          (activePath === file.path && activeLine === m.line_number);
                        return (
                          <div
                            key={rowKey}
                            className={`flex h-[22px] cursor-pointer items-center gap-1.5 pr-2 pl-5 font-mono text-[11.5px] transition-colors ${
                              isActiveRow
                                ? "bg-[#04395e] text-white"
                                : "text-[#cccccc] hover:bg-[#2a2d2e]"
                            }`}
                            title={`${file.path}:${m.line_number}:${m.column}`}
                            onClick={() => triggerJump(file, m)}
                          >
                            <span
                              className={`w-[32px] shrink-0 text-right text-[10.5px] tabular-nums ${
                                isActiveRow ? "text-white/75" : "text-[#6e7681]"
                              }`}
                            >
                              {m.line_number}
                            </span>
                            <span className="min-w-0 flex-1 truncate whitespace-pre">
                              {renderMatchedSnippet(m.line_text, m.ranges, isActiveRow)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
});
