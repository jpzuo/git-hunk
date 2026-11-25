/**
 * 全格式只读预览页面组件（VS Code Dark Modern 100% 原子化实现）。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Lock,
  Eye,
  Code,
  Copy,
  Check,
  ExternalLink,
  RefreshCw,
  FileWarning,
  FileText,
  Image as ImageIcon,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Search,
} from "lucide-react";
import { marked } from "marked";
import { api } from "../api";
import { detectLanguage, highlightLines, type LineTokens } from "../highlighter";
import { CodeLine, type CodeHighlightRange } from "./CodeLine";
import { EditorBreadcrumbs } from "./EditorBreadcrumbs";
import { FindWidget } from "./FindWidget";
import { IconButton } from "./IconButton";
import {
  compileFindRegex,
  DEFAULT_FIND_OPTIONS,
  extractSingleLineSelection,
  findMatchesInLine,
  type FindQueryOptions,
} from "../utils/inFileSearch";
import { sanitizeMarkdownHtml } from "../utils/sanitizeHtml";
import type { EditorTab, FilePreviewResult } from "../types";

const ROW_HEIGHT = 20;
const OVERSCAN = 30;

interface FileMatchOccurrence {
  lineNumber: number;
  start: number;
  end: number;
}

interface Props {
  path: string | null;
  activeTab?: EditorTab | null;
  workdir?: string | null;
  onOpenFileExternal?: (path: string) => void;
  onRevealInExplorer?: (path: string) => void;
  onShowToast?: (kind: "info" | "error", text: string) => void;
}

export const FilePreviewPage = React.memo(function FilePreviewPage({
  path,
  activeTab = null,
  workdir = null,
  onOpenFileExternal,
  onRevealInExplorer,
  onShowToast,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<FilePreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"preview" | "source">("preview");
  const [codeTokens, setCodeTokens] = useState<LineTokens[] | null>(null);
  const [highlighting, setHighlighting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [imageScale, setImageScale] = useState(1);
  const codeContainerRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const loadSeqRef = useRef(0);
  const scrollRafRef = useRef<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  // 文件内查找浮层状态 (Ctrl+F)
  const [findOpen, setFindOpen] = useState(false);
  const [findOptions, setFindOptions] = useState<FindQueryOptions>(DEFAULT_FIND_OPTIONS);
  const [findFocusNonce, setFindFocusNonce] = useState(0);
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);
  const [findNavNonce, setFindNavNonce] = useState(0);
  const [dismissedTabHighlight, setDismissedTabHighlight] = useState(false);

  const targetLine = activeTab?.targetLine;
  const jumpNonce = activeTab?.jumpNonce;
  const targetLineRef = useRef<number | undefined>(targetLine);
  targetLineRef.current = targetLine;

  useEffect(() => {
    setDismissedTabHighlight(false);
  }, [path, jumpNonce]);

  const loadFile = useCallback(async () => {
    const reqSeq = ++loadSeqRef.current;
    if (!path) {
      setLoading(false);
      setData(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.readFile(path);
      if (reqSeq !== loadSeqRef.current) return;
      setData(res);
      setViewMode(res.is_markdown && !targetLineRef.current ? "preview" : "source");
      if (codeContainerRef.current) {
        codeContainerRef.current.scrollTop = 0;
        codeContainerRef.current.scrollLeft = 0;
      }
      setScrollTop(0);
    } catch (e) {
      if (reqSeq !== loadSeqRef.current) return;
      console.error("读取文件失败:", e);
      setError(String(e));
      setData(null);
    } finally {
      if (reqSeq === loadSeqRef.current) {
        setLoading(false);
      }
    }
  }, [path]);

  useEffect(() => {
    void loadFile();
  }, [loadFile]);

  // 已打开 Markdown 富文本预览时点击搜索命中行，自动切至源码视图以定位行号
  useEffect(() => {
    if (targetLine && data?.is_markdown && viewMode === "preview") {
      setViewMode("source");
    }
  }, [targetLine, jumpNonce, data?.is_markdown, viewMode]);

  const markdownHtml = useMemo(() => {
    if (!data?.is_markdown || !data.text_content) return "";
    try {
      const rawHtml = marked.parse(data.text_content, {
        gfm: true,
        breaks: true,
      }) as string;
      return sanitizeMarkdownHtml(rawHtml);
    } catch (e) {
      console.error("Markdown 解析异常:", e);
      return `<p class="text-[#f14c4c]">Markdown 解析失败: ${String(e)}</p>`;
    }
  }, [data]);

  const lines = useMemo(() => {
    if (!data?.text_content) return [];
    return data.text_content.split(/\r?\n/);
  }, [data?.text_content]);

  const scrollToLineNumber = useCallback(
    (lineNumber: number) => {
      const container = codeContainerRef.current;
      if (!container || lines.length === 0) return;
      const vh = container.clientHeight > 0 ? container.clientHeight : viewportHeight;
      const totalHeight = Math.max(container.scrollHeight, lines.length * ROW_HEIGHT + 16);
      const maxTop = Math.max(0, totalHeight - vh);
      const targetTop = Math.min(
        maxTop,
        Math.max(0, (lineNumber - 1) * ROW_HEIGHT - Math.floor(vh * 0.42)),
      );
      container.scrollTop = targetTop;
      setScrollTop(targetTop);
      return requestAnimationFrame(() => {
        const activeSpan = container.querySelector<HTMLElement>('[data-active-match="true"]');
        activeSpan?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
      });
    },
    [lines.length, viewportHeight],
  );

  // 全局搜索跳行定位（非文件内主动 Find 状态时执行）
  useEffect(() => {
    if (findOpen) return;
    if (!targetLine || !data || data.is_binary || data.is_image) return;
    if (data.is_markdown && viewMode === "preview") return;
    let innerRaf: number | undefined;
    const outerRaf = requestAnimationFrame(() => {
      innerRaf = scrollToLineNumber(targetLine);
    });
    return () => {
      cancelAnimationFrame(outerRaf);
      if (innerRaf !== undefined) cancelAnimationFrame(innerRaf);
    };
  }, [
    findOpen,
    targetLine,
    jumpNonce,
    data?.path,
    data?.is_binary,
    data?.is_image,
    data?.is_markdown,
    viewMode,
    scrollToLineNumber,
  ]);

  const canSearchText = Boolean(path && data && !data.is_binary && !data.is_image && data.text_content !== undefined);

  const openFind = useCallback(() => {
    if (!canSearchText) return;
    if (data?.is_markdown && viewMode === "preview") {
      setViewMode("source");
    }
    const sel = extractSingleLineSelection();
    if (sel) {
      setFindOptions((prev) => ({ ...prev, query: sel }));
    } else if (!findOptions.query && activeTab?.searchHighlight?.query && !dismissedTabHighlight) {
      const h = activeTab.searchHighlight;
      setFindOptions({
        query: h.query,
        caseSensitive: h.caseSensitive,
        wholeWord: h.wholeWord,
        useRegex: h.useRegex,
      });
    }
    setFindOpen(true);
    setFindFocusNonce((n) => n + 1);
  }, [
    canSearchText,
    data?.is_markdown,
    viewMode,
    findOptions.query,
    activeTab?.searchHighlight,
    dismissedTabHighlight,
  ]);

  const effectiveFindSpec = useMemo(() => {
    if (findOpen) {
      return findOptions;
    }
    if (!dismissedTabHighlight && activeTab?.searchHighlight) {
      return {
        query: activeTab.searchHighlight.query,
        caseSensitive: activeTab.searchHighlight.caseSensitive,
        wholeWord: activeTab.searchHighlight.wholeWord,
        useRegex: activeTab.searchHighlight.useRegex,
      };
    }
    return null;
  }, [findOpen, findOptions, dismissedTabHighlight, activeTab?.searchHighlight]);

  const { regex: activeRegex, error: findRegexError } = useMemo(
    () =>
      effectiveFindSpec
        ? compileFindRegex(effectiveFindSpec)
        : { regex: null, error: null },
    [effectiveFindSpec],
  );

  const { occurrences: findOccurrences, lineHighlightsMap } = useMemo(() => {
    const occs: FileMatchOccurrence[] = [];
    const map = new Map<number, CodeHighlightRange[]>();
    if (!activeRegex || lines.length === 0) {
      return { occurrences: occs, lineHighlightsMap: map };
    }

    const totalLines = lines.length;
    for (let i = 0; i < totalLines; i++) {
      const lineNumber = i + 1;
      const spans = findMatchesInLine(lines[i], activeRegex);
      if (spans.length === 0) continue;
      const ranges: CodeHighlightRange[] = [];
      for (const sp of spans) {
        const idx = occs.length;
        const isActive = findOpen
          ? idx === activeMatchIdx
          : !dismissedTabHighlight &&
            activeTab?.searchHighlight?.activeLine === lineNumber &&
            (activeTab.searchHighlight.activeColumn
              ? sp.start + 1 === activeTab.searchHighlight.activeColumn ||
                (ranges.length === 0 && activeTab.searchHighlight.activeColumn <= sp.end + 1)
              : ranges.length === 0);
        occs.push({ lineNumber, start: sp.start, end: sp.end });
        ranges.push({ start: sp.start, end: sp.end, active: isActive });
      }
      map.set(lineNumber, ranges);
    }

    return { occurrences: occs, lineHighlightsMap: map };
  }, [
    activeRegex,
    lines,
    findOpen,
    activeMatchIdx,
    dismissedTabHighlight,
    activeTab?.searchHighlight,
  ]);

  // 索引越界保护
  useEffect(() => {
    if (findOccurrences.length === 0) {
      if (activeMatchIdx !== 0) setActiveMatchIdx(0);
    } else if (activeMatchIdx >= findOccurrences.length) {
      setActiveMatchIdx(0);
    }
  }, [findOccurrences.length, activeMatchIdx]);

  // 查找条件变更后自动归位到当前文件第 1 处命中（若刚从全局搜索跳转来则优先对齐全局搜索行）
  useEffect(() => {
    if (!findOpen) return;
    if (findOccurrences.length === 0) {
      setActiveMatchIdx(0);
      return;
    }
    setActiveMatchIdx(0);
    setFindNavNonce((n) => n + 1);
  }, [
    findOptions.query,
    findOptions.caseSensitive,
    findOptions.wholeWord,
    findOptions.useRegex,
    findOpen,
  ]);

  const activeFindMatch =
    findOpen && findOccurrences.length > 0
      ? (findOccurrences[activeMatchIdx] ?? findOccurrences[0])
      : null;

  const goNextMatch = useCallback(() => {
    if (findOccurrences.length === 0) return;
    setActiveMatchIdx((i) => (i + 1) % findOccurrences.length);
    setFindNavNonce((n) => n + 1);
  }, [findOccurrences.length]);

  const goPrevMatch = useCallback(() => {
    if (findOccurrences.length === 0) return;
    setActiveMatchIdx((i) => (i - 1 + findOccurrences.length) % findOccurrences.length);
    setFindNavNonce((n) => n + 1);
  }, [findOccurrences.length]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setDismissedTabHighlight(true);
  }, []);

  // 文件内查找导航：滚至当前活跃命中行与水平列位置
  useEffect(() => {
    if (!findOpen || !activeFindMatch) return;
    let innerRaf: number | undefined;
    const outerRaf = requestAnimationFrame(() => {
      innerRaf = scrollToLineNumber(activeFindMatch.lineNumber);
    });
    return () => {
      cancelAnimationFrame(outerRaf);
      if (innerRaf !== undefined) cancelAnimationFrame(innerRaf);
    };
  }, [findOpen, activeFindMatch, findNavNonce, scrollToLineNumber]);

  useEffect(() => {
    const el = codeContainerRef.current;
    if (!el) return;
    const syncViewport = () => {
      if (el.clientHeight > 0) setViewportHeight(el.clientHeight);
    };
    const ro = new ResizeObserver(syncViewport);
    ro.observe(el);
    syncViewport();
    return () => ro.disconnect();
  }, [data?.path, viewMode, lines.length]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
      }
    };
  }, []);

  const handleCodeScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = codeContainerRef.current;
      if (el) {
        setScrollTop(el.scrollTop);
        if (el.clientHeight > 0) setViewportHeight(el.clientHeight);
      }
    });
  }, []);

  // 快捷键绑定：Ctrl+F 打开查找、F3/Shift+F3 切换命中、Esc 关闭
  useEffect(() => {
    if (!canSearchText) return;
    const onKey = (e: KeyboardEvent) => {
      const inDialog = Boolean(
        (e.target as HTMLElement | null)?.closest?.('[role="dialog"], .modal-backdrop'),
      );
      if (inDialog) return;

      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openFind();
      } else if (e.key === "F3" && findOpen) {
        e.preventDefault();
        if (e.shiftKey) goPrevMatch();
        else goNextMatch();
      } else if (e.key === "Escape" && findOpen) {
        e.preventDefault();
        e.stopPropagation();
        closeFind();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canSearchText, findOpen, openFind, goNextMatch, goPrevMatch, closeFind]);

  useEffect(() => {
    let cancelled = false;
    if (
      !data ||
      data.is_binary ||
      data.is_image ||
      !data.text_content ||
      (data.is_markdown && viewMode === "preview")
    ) {
      setCodeTokens(null);
      setHighlighting(false);
      return;
    }

    const lang = detectLanguage(data.path);
    setHighlighting(true);
    void (async () => {
      try {
        const tokens = await highlightLines(data.text_content!, lang);
        if (!cancelled) setCodeTokens(tokens);
      } catch (e) {
        console.error("代码高亮异常:", e);
        if (!cancelled) setCodeTokens(null);
      } finally {
        if (!cancelled) setHighlighting(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [data, viewMode]);

  const handleCopy = useCallback(() => {
    if (!data?.text_content) return;
    void navigator.clipboard.writeText(data.text_content);
    setCopied(true);
    onShowToast?.("info", "已复制文件内容至剪贴板");
    window.setTimeout(() => setCopied(false), 2000);
  }, [data?.text_content, onShowToast]);

  if (!path) {
    return (
      <div className="flex items-center justify-center flex-1 h-full bg-[#1f1f1f] text-[#868686]">
        <div className="flex flex-col items-center max-w-[440px] px-5 py-8 text-center">
          <FileText size={48} strokeWidth={1.25} className="text-[#868686] opacity-80 mb-4" />
          <h2 className="text-[18px] font-semibold text-[#cccccc] m-0 mb-1.5">只读预览查看器</h2>
          <p className="text-[#868686] m-0 text-[13px]">请在左侧文件目录中选择一个文件以开启预览标签页</p>
          <div className="flex flex-col gap-2.5 mt-6 text-left w-full">
            <div className="flex items-center gap-2.5 text-[12px] text-[#cccccc] px-3 py-2 bg-[#181818] border border-[#2b2b2b] rounded-[4px]">
              <Eye size={15} className="text-[#9d9d9d] shrink-0" />
              <span>Markdown 渲染：支持 GFM 表格、列表与代码块</span>
            </div>
            <div className="flex items-center gap-2.5 text-[12px] text-[#cccccc] px-3 py-2 bg-[#181818] border border-[#2b2b2b] rounded-[4px]">
              <Code size={15} className="text-[#9d9d9d] shrink-0" />
              <span>代码语法高亮：VS Code Dark+ 配色与行号</span>
            </div>
            <div className="flex items-center gap-2.5 text-[12px] text-[#cccccc] px-3 py-2 bg-[#181818] border border-[#2b2b2b] rounded-[4px]">
              <ImageIcon size={15} className="text-[#9d9d9d] shrink-0" />
              <span>图片查看：支持 PNG、JPG、SVG、WebP 透明缩放预览</span>
            </div>
            <div className="flex items-center gap-2.5 text-[12px] text-[#cccccc] px-3 py-2 bg-[#181818] border border-[#2b2b2b] rounded-[4px]">
              <Lock size={15} className="text-[#9d9d9d] shrink-0" />
              <span>严格只读保障：杜绝误触篡改代码文件</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const breadcrumbTab: EditorTab = activeTab ?? {
    id: `preview:${path}`,
    kind: "preview",
    title: path.split("/").pop() ?? path,
    path,
    isReadOnly: true,
  };

  const actionsBar = (
    <>
      {data?.is_markdown && (
        <div className="flex items-center gap-0.5 mr-1">
          <IconButton
            tooltip="富文本预览"
            variant={viewMode === "preview" ? "active" : "ghost"}
            icon={<Eye size={13} />}
            onClick={() => setViewMode("preview")}
          />
          <IconButton
            tooltip="源码视图"
            variant={viewMode === "source" ? "active" : "ghost"}
            icon={<Code size={13} />}
            onClick={() => setViewMode("source")}
          />
        </div>
      )}

      {data?.text_content && (
        <IconButton
          tooltip="在当前文件中查找 (Ctrl+F)"
          variant={findOpen ? "active" : "ghost"}
          icon={<Search size={13} />}
          onClick={openFind}
        />
      )}

      {data?.text_content && (
        <IconButton
          tooltip={copied ? "已复制内容" : "复制文件内容"}
          icon={copied ? <Check size={13} className="text-[#73c991]" /> : <Copy size={13} />}
          onClick={handleCopy}
        />
      )}

      <IconButton
        tooltip="外部打开"
        icon={<ExternalLink size={13} />}
        onClick={() => onOpenFileExternal?.(path)}
      />

      <IconButton
        tooltip="刷新文件"
        align="right"
        icon={<RefreshCw size={12} className={loading ? "animate-spin" : ""} />}
        onClick={() => void loadFile()}
      />
    </>
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-[#1f1f1f]">
      <EditorBreadcrumbs
        activeTab={breadcrumbTab}
        workdir={workdir}
        onRevealInExplorer={onRevealInExplorer}
        rightSlot={actionsBar}
      />

      <div className="flex-1 overflow-hidden min-h-0 relative bg-[#1f1f1f] flex flex-col">
        <FindWidget
          open={findOpen}
          options={findOptions}
          onOptionsChange={setFindOptions}
          totalMatches={findOccurrences.length}
          activeIndex={activeMatchIdx}
          regexError={findRegexError}
          focusNonce={findFocusNonce}
          onNext={goNextMatch}
          onPrev={goPrevMatch}
          onClose={closeFind}
        />
        {loading ? (
          <div className="flex flex-col items-center justify-center h-full p-10 text-center text-[#868686] gap-2">
            <RefreshCw size={22} className="animate-spin text-[#868686]" />
            <p className="m-0 text-[13px]">正在读取文件…</p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full p-10 text-center text-[#868686] gap-2">
            <FileWarning size={32} className="text-[#f14c4c]" />
            <h3 className="m-0 text-[#cccccc] text-[15px]">读取文件失败</h3>
            <p className="m-0 text-[12px] text-[#868686]">{error}</p>
            <button
              type="button"
              className="mt-2 px-3 py-1.5 text-[12px] rounded-[2px] bg-[#0078d4] hover:bg-[#026ec1] text-white border-none cursor-pointer"
              onClick={() => void loadFile()}
            >
              重试
            </button>
          </div>
        ) : !data ? null : data.is_image ? (
          <div className="flex flex-col h-full">
            <div className="flex items-center justify-center gap-1 py-1.5 bg-[#181818] border-b border-[#2b2b2b] text-[11px]">
              <IconButton
                tooltip="缩小"
                icon={<ZoomOut size={13} />}
                onClick={() => setImageScale((s) => Math.max(0.2, s - 0.25))}
              />
              <span className="min-w-[44px] text-center text-[11px] text-[#cccccc] font-mono">
                {Math.round(imageScale * 100)}%
              </span>
              <IconButton
                tooltip="放大"
                icon={<ZoomIn size={13} />}
                onClick={() => setImageScale((s) => Math.min(4, s + 0.25))}
              />
              <IconButton
                tooltip="还原 100%"
                icon={<Maximize2 size={12} />}
                onClick={() => setImageScale(1)}
              />
            </div>
            <div className="flex-1 flex items-center justify-center overflow-auto p-6 bg-checkerboard">
              {data.base64_content ? (
                <img
                  src={`data:${data.mime_type || "image/png"};base64,${data.base64_content}`}
                  alt={data.name}
                  style={{
                    transform: `scale(${imageScale})`,
                    transformOrigin: "center center",
                  }}
                  className="max-w-[85%] max-h-[85%] object-contain shadow-[0_4px_24px_rgba(0,0,0,0.6)] rounded-[4px] transition-transform duration-100"
                />
              ) : (
                <div className="flex flex-col items-center gap-3 text-[#868686]">
                  <FileWarning size={36} className="text-[#e2c08d]" />
                  <p className="m-0">图片体积较大，建议在系统查看器中浏览</p>
                  <button
                    type="button"
                    className="px-3 py-1.5 text-[12px] rounded-[2px] bg-[#252526] hover:bg-[#2a2d2e] text-[#cccccc] border border-[#3c3c3c] cursor-pointer"
                    onClick={() => onOpenFileExternal?.(path)}
                  >
                    外部查看
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : data.is_binary ? (
          <div className="flex flex-col items-center justify-center h-full p-10 text-center max-w-[480px] mx-auto">
            <FileWarning size={40} className="text-[#e2c08d]" />
            <h3 className="mt-3 mb-1.5 text-[15px] text-[#cccccc]">无法在内置视图中预览此文件</h3>
            <p className="m-0 text-[12.5px] text-[#868686]">
              该文件为二进制文件或超出了内置文本预览大小限制（5MB）。
            </p>
            <div className="flex gap-3 mt-5">
              <button
                type="button"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-[2px] bg-[#252526] hover:bg-[#2a2d2e] text-[#cccccc] border border-[#3c3c3c] cursor-pointer"
                onClick={() => onOpenFileExternal?.(path)}
              >
                <ExternalLink size={14} />
                在系统默认应用中打开
              </button>
            </div>
          </div>
        ) : data.is_markdown && viewMode === "preview" ? (
          <div className="h-full overflow-y-auto px-10 py-7 box-border bg-[#1f1f1f]">
            <div
              className="markdown-body"
              dangerouslySetInnerHTML={{ __html: markdownHtml }}
            />
          </div>
        ) : (
          <div className="flex flex-1 min-h-0 overflow-hidden relative bg-[#1f1f1f]">
            {(() => {
              const totalRows = lines.length;
              const visibleCount = Math.max(1, Math.ceil(viewportHeight / ROW_HEIGHT));
              const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
              const endIndex = Math.min(
                totalRows,
                Math.floor(scrollTop / ROW_HEIGHT) + visibleCount + OVERSCAN,
              );
              const paddingTop = startIndex * ROW_HEIGHT;
              const paddingBottom = Math.max(0, (totalRows - endIndex) * ROW_HEIGHT);
              const visibleLines = lines.slice(startIndex, endIndex);

              return (
                <div
                  ref={codeContainerRef}
                  onScroll={handleCodeScroll}
                  className="flex-1 min-w-0 h-full overflow-auto bg-[#1f1f1f] relative"
                >
                  {highlighting && (
                    <div className="sticky top-0 left-0 right-0 bg-[#252526] border-b border-[#2b2b2b] text-[#9d9d9d] text-[11px] py-0.5 px-3 text-center z-20">
                      正在分析代码语法…
                    </div>
                  )}
                  <div className="min-w-full w-max py-2 font-mono text-[12.5px] leading-[20px]">
                    {paddingTop > 0 && <div style={{ height: paddingTop }} />}
                    {visibleLines.map((lineText, offset) => {
                      const idx = startIndex + offset;
                      const lineNumber = idx + 1;
                      const tokens = codeTokens ? codeTokens[idx] : null;
                      const isTargetRow = findOpen
                        ? activeFindMatch?.lineNumber === lineNumber
                        : !dismissedTabHighlight && targetLine === lineNumber;
                      const lineHighlights = lineHighlightsMap.get(lineNumber);
                      return (
                        <div
                          key={idx}
                          className={`flex h-[20px] items-center ${
                            isTargetRow
                              ? "bg-[#04395e]/45"
                              : "hover:bg-white/[0.03]"
                          }`}
                        >
                          <div
                            className={`sticky left-0 z-10 w-[54px] min-w-[54px] h-full shrink-0 text-right pr-3.5 select-none border-r border-[#2b2b2b] text-[11.5px] leading-[20px] ${
                              isTargetRow
                                ? "bg-[#0c4a75] text-[#cccccc] font-semibold"
                                : "bg-[#1f1f1f] text-[#6e7681]"
                            }`}
                            data-line={lineNumber}
                          >
                            {lineNumber}
                          </div>
                          <div className="pl-3.5 pr-5 whitespace-pre text-[#cccccc]">
                            <CodeLine
                              tokens={tokens}
                              fallback={lineText}
                              highlights={lineHighlights}
                            />
                          </div>
                        </div>
                      );
                    })}
                    {paddingBottom > 0 && <div style={{ height: paddingBottom }} />}
                  </div>
                </div>
              );
            })()}

            {/* 查找命中鸟瞰缩略细条 */}
            {findOpen && findOccurrences.length > 0 && lines.length > 0 && (
              <div
                ref={rulerRef}
                className="relative w-[12px] shrink-0 cursor-pointer select-none border-l border-[#2b2b2b] bg-[#181818]"
                title="点击定位到查找匹配行"
                onClick={(e) => {
                  const ruler = rulerRef.current;
                  const container = codeContainerRef.current;
                  if (!ruler || !container) return;
                  const rect = ruler.getBoundingClientRect();
                  if (rect.height <= 0) return;
                  const ratio = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
                  const targetLn = Math.max(1, Math.min(lines.length, Math.round(ratio * lines.length)));
                  let bestIdx = 0;
                  let bestDist = Infinity;
                  for (let i = 0; i < findOccurrences.length; i++) {
                    const d = Math.abs(findOccurrences[i].lineNumber - targetLn);
                    if (d < bestDist) {
                      bestDist = d;
                      bestIdx = i;
                    }
                  }
                  setActiveMatchIdx(bestIdx);
                  setFindNavNonce((n) => n + 1);
                }}
              >
                {findOccurrences.slice(0, 400).map((occ, i) => {
                  const topPct = ((occ.lineNumber - 1) / Math.max(1, lines.length)) * 100;
                  const isActive = i === activeMatchIdx;
                  return (
                    <div
                      key={`${occ.lineNumber}-${occ.start}-${i}`}
                      className={`pointer-events-none absolute left-[2px] right-[2px] min-h-[2px] rounded-[1px] ${
                        isActive ? "z-10 min-h-[3px] bg-[#f8c555]" : "bg-[#d18616]/80"
                      }`}
                      style={{ top: `${topPct}%` }}
                    />
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
