/**
 * VS Code Dark Modern 100% 复刻双栏 / 行内全文对比器。
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EditorTab, Hunk, HunkLine, StageArea } from "../types";
import type { FilePair } from "../historyTypes";
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
import {
  ChevronUp,
  ChevronDown,
  FileCode,
  Copy,
  Check,
  Plus,
  Minus,
  Undo2,
  RefreshCw,
  Search,
} from "lucide-react";

const ROW_HEIGHT = 20;
const OVERSCAN = 25;

interface Cell {
  no: number;
  text: string;
}

interface Row {
  left: Cell | null;
  right: Cell | null;
  isContext: boolean;
  hunk?: Hunk;
  isHunkStart?: boolean;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function hunkLinesToRows(lines: HunkLine[]): Row[] {
  const rows: Row[] = [];
  let pendingDel: HunkLine[] = [];
  let pendingAdd: HunkLine[] = [];

  const flush = () => {
    const max = Math.max(pendingDel.length, pendingAdd.length);
    for (let i = 0; i < max; i++) {
      const d = pendingDel[i];
      const a = pendingAdd[i];
      rows.push({
        left: d ? { no: d.old_lineno ?? 0, text: d.content } : null,
        right: a ? { no: a.new_lineno ?? 0, text: a.content } : null,
        isContext: false,
      });
    }
    pendingDel = [];
    pendingAdd = [];
  };

  for (const line of lines) {
    if (line.kind === "deletion") pendingDel.push(line);
    else if (line.kind === "addition") pendingAdd.push(line);
    else {
      flush();
      rows.push({
        left: { no: line.old_lineno ?? 0, text: line.content },
        right: { no: line.new_lineno ?? 0, text: line.content },
        isContext: true,
      });
    }
  }
  flush();
  return rows;
}

export function buildRows(
  oldContent: string,
  newContent: string,
  hunks: Hunk[],
): Row[] {
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const rows: Row[] = [];

  let oldCursor = 0;
  let newCursor = 0;

  const pushContext = (count: number) => {
    for (let i = 0; i < count; i++) {
      const oi = oldCursor + i;
      const ni = newCursor + i;
      rows.push({
        left: { no: oi + 1, text: oldLines[oi] ?? "" },
        right: { no: ni + 1, text: newLines[ni] ?? "" },
        isContext: true,
      });
    }
    oldCursor += count;
    newCursor += count;
  };

  for (const hunk of hunks) {
    const hunkOldStart = hunk.old_lines === 0 ? hunk.old_start : hunk.old_start - 1;
    const hunkNewStart = hunk.new_lines === 0 ? hunk.new_start : hunk.new_start - 1;

    const gap = hunkOldStart - oldCursor;
    if (gap > 0) pushContext(gap);

    const hunkRows = hunkLinesToRows(hunk.lines);
    if (hunkRows.length > 0) {
      hunkRows[0].isHunkStart = true;
      hunkRows[0].hunk = hunk;
    }
    rows.push(...hunkRows);

    oldCursor = hunkOldStart + hunk.old_lines;
    newCursor = hunkNewStart + hunk.new_lines;
  }

  const tail = oldLines.length - oldCursor;
  if (tail > 0) pushContext(tail);

  return rows;
}

interface Props {
  pair: FilePair | null;
  loading: boolean;
  area?: StageArea;
  activeTab?: EditorTab | null;
  workdir?: string | null;
  onStageHunk?: (hunkIndex: number) => void;
  onUnstageHunk?: (hunkIndex: number) => void;
  onDiscardHunk?: (hunkIndex: number) => void;
  onStageFile?: () => void;
  onUnstageFile?: () => void;
  onDiscardFile?: () => void;
  onPrevFile?: () => void;
  onNextFile?: () => void;
  hasPrevFile?: boolean;
  hasNextFile?: boolean;
  onOpenFile?: () => void;
  onRevealInExplorer?: (path: string) => void;
  onCopyPath?: () => void;
}

export const SideBySideDiff = React.memo(function SideBySideDiff({
  pair,
  loading,
  area,
  activeTab = null,
  workdir = null,
  onStageHunk,
  onUnstageHunk,
  onDiscardHunk,
  onStageFile,
  onUnstageFile,
  onDiscardFile,
  onPrevFile,
  onNextFile,
  hasPrevFile,
  hasNextFile,
  onOpenFile,
  onRevealInExplorer,
  onCopyPath,
}: Props) {
  const [copiedPath, setCopiedPath] = useState(false);
  const [cachedPair, setCachedPair] = useState<FilePair | null>(pair);
  useEffect(() => {
    if (pair) setCachedPair(pair);
  }, [pair]);

  const handleCopyPath = useCallback(() => {
    if (!onCopyPath) return;
    onCopyPath();
    setCopiedPath(true);
    window.setTimeout(() => setCopiedPath(false), 1800);
  }, [onCopyPath]);

  const displayPair = pair ?? cachedPair;

  const canStageHunk = area === "unstaged" && !!onStageHunk;
  const canUnstageHunk = area === "staged" && !!onUnstageHunk;
  const canDiscardHunk =
    area === "unstaged" && !!onDiscardHunk && displayPair?.status !== "untracked";
  const hasHunkActions = canStageHunk || canUnstageHunk || canDiscardHunk;

  const rows = useMemo(() => {
    if (!displayPair || displayPair.binary || displayPair.truncated) return [];
    return buildRows(
      displayPair.old_content,
      displayPair.new_content,
      displayPair.hunks,
    );
  }, [displayPair]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const lastAutoScrolledKeyRef = useRef<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [contentHeight, setContentHeight] = useState(0);
  const [draggingRuler, setDraggingRuler] = useState(false);
  const [rulerHover, setRulerHover] = useState<{ top: number; label: string } | null>(null);
  const rafIdRef = useRef<number | null>(null);

  // Diff 内查找状态 (Ctrl+F)
  const [findOpen, setFindOpen] = useState(false);
  const [findOptions, setFindOptions] = useState<FindQueryOptions>(DEFAULT_FIND_OPTIONS);
  const [findFocusNonce, setFindFocusNonce] = useState(0);
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);
  const [findNavNonce, setFindNavNonce] = useState(0);

  type OverviewKind = "add" | "del" | "mod";
  interface OverviewSpan {
    start: number;
    count: number;
    kind: OverviewKind;
  }

  const { firstChangeIndex, overviewSpans } = useMemo(() => {
    let firstIdx = -1;
    let firstHunkIdx = -1;
    const spans: OverviewSpan[] = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.isHunkStart && firstHunkIdx === -1) firstHunkIdx = i;
      if (r.isContext) continue;

      if (firstIdx === -1) firstIdx = i;
      const kind: OverviewKind =
        !r.left && r.right ? "add" : r.left && !r.right ? "del" : "mod";
      const last = spans[spans.length - 1];
      if (last && last.kind === kind && last.start + last.count === i) {
        last.count += 1;
      } else {
        spans.push({ start: i, count: 1, kind });
      }
    }

    return {
      firstChangeIndex: firstIdx >= 0 ? firstIdx : firstHunkIdx,
      overviewSpans: spans,
    };
  }, [rows]);

  const scrollIdentity = useMemo(() => {
    if (!displayPair) return null;
    if (activeTab?.id) return activeTab.id;
    return `${displayPair.path}:${displayPair.old_exists}:${displayPair.new_exists}:${displayPair.hunks.length}:${displayPair.hunks[0]?.header ?? ""}:${displayPair.old_content.length}:${displayPair.new_content.length}`;
  }, [activeTab?.id, displayPair]);

  useLayoutEffect(() => {
    if (loading || !scrollIdentity || !displayPair || displayPair.binary || displayPair.truncated) {
      return;
    }
    const el = scrollRef.current;
    if (!el || el.clientHeight <= 0) return;
    if (lastAutoScrolledKeyRef.current === scrollIdentity) return;

    const vh = el.clientHeight;
    const total = Math.max(el.scrollHeight, rows.length * ROW_HEIGHT);
    let targetTop = 0;
    if (firstChangeIndex > 0) {
      const contextLead = Math.min(120, Math.max(60, Math.floor(vh * 0.22)));
      const maxTop = Math.max(0, total - vh);
      targetTop = Math.min(maxTop, Math.max(0, firstChangeIndex * ROW_HEIGHT - contextLead));
    }

    el.scrollTop = targetTop;
    setScrollTop(targetTop);
    if (el.clientHeight > 0) setViewportHeight(el.clientHeight);
    if (el.scrollHeight > 0) setContentHeight(el.scrollHeight);
    lastAutoScrolledKeyRef.current = scrollIdentity;
  }, [loading, scrollIdentity, displayPair, rows.length, firstChangeIndex, viewportHeight]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const syncMetrics = () => {
      if (el.clientHeight > 0) setViewportHeight(el.clientHeight);
      if (el.scrollHeight > 0) setContentHeight(el.scrollHeight);
    };
    const ro = new ResizeObserver(syncMetrics);
    ro.observe(el);
    syncMetrics();
    return () => ro.disconnect();
  }, [displayPair?.path, rows.length]);

  const handleScroll = useCallback(() => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      const el = scrollRef.current;
      if (el) {
        setScrollTop(el.scrollTop);
        if (el.scrollHeight > 0) setContentHeight(el.scrollHeight);
      }
    });
  }, []);

  const jumpToRulerY = useCallback(
    (clientY: number) => {
      const ruler = rulerRef.current;
      const el = scrollRef.current;
      if (!ruler || !el || rows.length === 0) return;
      const rect = ruler.getBoundingClientRect();
      if (rect.height <= 0) return;
      const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
      const total = Math.max(el.scrollHeight, rows.length * ROW_HEIGHT);
      const vh = el.clientHeight > 0 ? el.clientHeight : viewportHeight;
      const targetTop = Math.min(
        Math.max(0, total - vh),
        Math.max(0, ratio * total - vh / 2),
      );
      el.scrollTop = targetTop;
      setScrollTop(targetTop);
    },
    [rows.length, viewportHeight],
  );

  useEffect(() => {
    if (!draggingRuler) return;
    const onMove = (e: MouseEvent) => {
      jumpToRulerY(e.clientY);
    };
    const onUp = () => setDraggingRuler(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [draggingRuler, jumpToRulerY]);

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  const canSearchDiff = Boolean(
    displayPair && !displayPair.binary && !displayPair.truncated && rows.length > 0,
  );

  const openFind = useCallback(() => {
    if (!canSearchDiff) return;
    const sel = extractSingleLineSelection();
    if (sel) {
      setFindOptions((prev) => ({ ...prev, query: sel }));
    }
    setFindOpen(true);
    setFindFocusNonce((n) => n + 1);
  }, [canSearchDiff]);

  const { regex: findRegex, error: findRegexError } = useMemo(
    () => (findOpen ? compileFindRegex(findOptions) : { regex: null, error: null }),
    [findOpen, findOptions],
  );

  interface DiffMatchOccurrence {
    rowIndex: number;
    side: "left" | "right";
    start: number;
    end: number;
  }

  const { diffMatches, leftHighlightsMap, rightHighlightsMap } = useMemo(() => {
    const occs: DiffMatchOccurrence[] = [];
    const leftMap = new Map<number, CodeHighlightRange[]>();
    const rightMap = new Map<number, CodeHighlightRange[]>();

    if (!findOpen || !findRegex || rows.length === 0) {
      return { diffMatches: occs, leftHighlightsMap: leftMap, rightHighlightsMap: rightMap };
    }

    for (let ri = 0; ri < rows.length; ri++) {
      const r = rows[ri];
      if (r.isContext) {
        const text = r.right?.text ?? r.left?.text ?? "";
        const spans = findMatchesInLine(text, findRegex);
        if (spans.length === 0) continue;
        const leftRanges: CodeHighlightRange[] = [];
        const rightRanges: CodeHighlightRange[] = [];
        for (const sp of spans) {
          const idx = occs.length;
          const isActive = idx === activeMatchIdx;
          occs.push({ rowIndex: ri, side: "right", start: sp.start, end: sp.end });
          leftRanges.push({ start: sp.start, end: sp.end, active: false });
          rightRanges.push({ start: sp.start, end: sp.end, active: isActive });
        }
        leftMap.set(ri, leftRanges);
        rightMap.set(ri, rightRanges);
      } else {
        if (r.left?.text) {
          const spans = findMatchesInLine(r.left.text, findRegex);
          if (spans.length > 0) {
            const ranges: CodeHighlightRange[] = [];
            for (const sp of spans) {
              const idx = occs.length;
              occs.push({ rowIndex: ri, side: "left", start: sp.start, end: sp.end });
              ranges.push({ start: sp.start, end: sp.end, active: idx === activeMatchIdx });
            }
            leftMap.set(ri, ranges);
          }
        }
        if (r.right?.text) {
          const spans = findMatchesInLine(r.right.text, findRegex);
          if (spans.length > 0) {
            const ranges: CodeHighlightRange[] = [];
            for (const sp of spans) {
              const idx = occs.length;
              occs.push({ rowIndex: ri, side: "right", start: sp.start, end: sp.end });
              ranges.push({ start: sp.start, end: sp.end, active: idx === activeMatchIdx });
            }
            rightMap.set(ri, ranges);
          }
        }
      }
    }

    return { diffMatches: occs, leftHighlightsMap: leftMap, rightHighlightsMap: rightMap };
  }, [findOpen, findRegex, rows, activeMatchIdx]);

  useEffect(() => {
    if (diffMatches.length === 0) {
      if (activeMatchIdx !== 0) setActiveMatchIdx(0);
    } else if (activeMatchIdx >= diffMatches.length) {
      setActiveMatchIdx(0);
    }
  }, [diffMatches.length, activeMatchIdx]);

  useEffect(() => {
    if (!findOpen) return;
    setActiveMatchIdx(0);
    setFindNavNonce((n) => n + 1);
  }, [
    findOptions.query,
    findOptions.caseSensitive,
    findOptions.wholeWord,
    findOptions.useRegex,
    findOpen,
  ]);

  const activeDiffMatch =
    findOpen && diffMatches.length > 0
      ? (diffMatches[activeMatchIdx] ?? diffMatches[0])
      : null;

  const goNextMatch = useCallback(() => {
    if (diffMatches.length === 0) return;
    setActiveMatchIdx((i) => (i + 1) % diffMatches.length);
    setFindNavNonce((n) => n + 1);
  }, [diffMatches.length]);

  const goPrevMatch = useCallback(() => {
    if (diffMatches.length === 0) return;
    setActiveMatchIdx((i) => (i - 1 + diffMatches.length) % diffMatches.length);
    setFindNavNonce((n) => n + 1);
  }, [diffMatches.length]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
  }, []);

  useEffect(() => {
    if (!findOpen || !activeDiffMatch) return;
    const el = scrollRef.current;
    if (!el) return;
    const vh = el.clientHeight > 0 ? el.clientHeight : viewportHeight;
    const total = Math.max(el.scrollHeight, rows.length * ROW_HEIGHT);
    const maxTop = Math.max(0, total - vh);
    const targetTop = Math.min(
      maxTop,
      Math.max(0, activeDiffMatch.rowIndex * ROW_HEIGHT - vh / 2 + ROW_HEIGHT / 2),
    );
    el.scrollTop = targetTop;
    setScrollTop(targetTop);
    const raf = requestAnimationFrame(() => {
      el.querySelector<HTMLElement>('[data-active-match="true"]')?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [findOpen, activeDiffMatch, findNavNonce, viewportHeight, rows.length]);

  useEffect(() => {
    if (!canSearchDiff) return;
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
  }, [canSearchDiff, findOpen, openFind, goNextMatch, goPrevMatch, closeFind]);

  const isVirtual = rows.length > 150;
  const { startIndex, paddingTop, paddingBottom, visibleRows } = useMemo(() => {
    if (!isVirtual) {
      return {
        startIndex: 0,
        paddingTop: 0,
        paddingBottom: 0,
        visibleRows: rows,
      };
    }
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
    const end = Math.min(rows.length, start + visibleCount);
    const top = start * ROW_HEIGHT;
    const bottom = Math.max(0, (rows.length - end) * ROW_HEIGHT);
    return {
      startIndex: start,
      paddingTop: top,
      paddingBottom: bottom,
      visibleRows: rows.slice(start, end),
    };
  }, [isVirtual, rows, scrollTop, viewportHeight]);

  const language = useMemo(
    () => (displayPair ? detectLanguage(displayPair.path) : null),
    [displayPair?.path],
  );

  const [oldTokens, setOldTokens] = useState<LineTokens[] | null>(null);
  const [newTokens, setNewTokens] = useState<LineTokens[] | null>(null);
  const [highlighting, setHighlighting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    if (!displayPair || displayPair.binary || displayPair.truncated || !language) {
      setOldTokens(null);
      setNewTokens(null);
      setHighlighting(false);
      return;
    }

    setHighlighting(true);
    void (async () => {
      const [oldT, newT] = await Promise.all([
        highlightLines(displayPair.old_content, language),
        highlightLines(displayPair.new_content, language),
      ]);
      if (cancelled) return;
      setOldTokens(oldT);
      setNewTokens(newT);
      setHighlighting(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [displayPair, language]);

  const actionsSlot = displayPair ? (
    <>
      {loading && (
        <span className="inline-flex items-center mr-1 text-[#9d9d9d]" aria-label="刷新中">
          <RefreshCw size={11} className="animate-spin" />
        </span>
      )}
      {displayPair.additions > 0 && (
        <span className="font-mono text-[11px] font-medium text-[#73c991]">
          +{displayPair.additions}
        </span>
      )}
      {displayPair.deletions > 0 && (
        <span className="font-mono text-[11px] font-medium text-[#c74e39] mr-1">
          -{displayPair.deletions}
        </span>
      )}

      {(onPrevFile || onNextFile) && (
        <>
          <IconButton
            tooltip="上一个变更文件 (Alt+Up)"
            icon={<ChevronUp size={13} strokeWidth={2} />}
            disabled={!hasPrevFile}
            onClick={onPrevFile}
          />
          <IconButton
            tooltip="下一个变更文件 (Alt+Down)"
            icon={<ChevronDown size={13} strokeWidth={2} />}
            disabled={!hasNextFile}
            onClick={onNextFile}
          />
        </>
      )}

      {canSearchDiff && (
        <IconButton
          tooltip="在当前对比中查找 (Ctrl+F)"
          variant={findOpen ? "active" : "ghost"}
          icon={<Search size={13} strokeWidth={1.75} />}
          onClick={openFind}
        />
      )}

      {onOpenFile && (
        <IconButton
          tooltip="打开文件"
          icon={<FileCode size={13} strokeWidth={1.75} />}
          onClick={onOpenFile}
        />
      )}
      {onCopyPath && (
        <IconButton
          tooltip={copiedPath ? "已复制路径" : "复制相对路径"}
          icon={
            copiedPath ? (
              <Check size={12.5} className="text-[#73c991]" />
            ) : (
              <Copy size={12.5} strokeWidth={1.75} />
            )
          }
          onClick={handleCopyPath}
        />
      )}
      {area === "unstaged" && onStageFile && (
        <IconButton
          tooltip="暂存文件"
          icon={<Plus size={13} strokeWidth={2.2} />}
          onClick={onStageFile}
        />
      )}
      {area === "staged" && onUnstageFile && (
        <IconButton
          tooltip="取消暂存"
          icon={<Minus size={13} strokeWidth={2.2} />}
          onClick={onUnstageFile}
        />
      )}
      {area === "unstaged" && onDiscardFile && displayPair.status !== "untracked" && (
        <IconButton
          tooltip="放弃更改"
          variant="danger"
          align="right"
          icon={<Undo2 size={12.5} strokeWidth={1.85} />}
          onClick={onDiscardFile}
        />
      )}
    </>
  ) : loading ? (
    <span className="inline-flex items-center text-[#9d9d9d]" aria-label="加载中">
      <RefreshCw size={11} className="animate-spin" />
    </span>
  ) : null;

  const topBar = activeTab ? (
    <EditorBreadcrumbs
      activeTab={activeTab}
      workdir={workdir}
      onRevealInExplorer={onRevealInExplorer}
      rightSlot={actionsSlot}
    />
  ) : actionsSlot ? (
    <div className="flex items-center justify-end gap-1 min-h-[26px] px-3.5 py-0.5 bg-[#1f1f1f] shrink-0">
      {actionsSlot}
    </div>
  ) : null;

  if (loading && !displayPair) {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-[#1f1f1f]">
        {topBar}
        <div className="flex flex-col items-center justify-center flex-1 text-[#868686] text-[13px]">
          加载中…
        </div>
      </div>
    );
  }

  if (!displayPair) {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-[#1f1f1f]">
        {topBar}
        <div className="flex flex-col items-center justify-center flex-1 text-[#868686] text-[13px] gap-1">
          <p className="m-0 text-[#cccccc]">在左侧选择一个变更文件</p>
          <p className="m-0 text-[12px] text-[#868686]">右侧会显示该文件的修改前后对比</p>
        </div>
      </div>
    );
  }

  if (displayPair.binary) {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-[#1f1f1f]">
        {topBar}
        <div className="flex flex-col items-center justify-center flex-1 text-[#868686] text-[13px] gap-1">
          <p className="m-0 text-[#cccccc]">二进制文件，无法以文本方式对比</p>
          <p className="m-0 text-[12px] font-mono text-[#868686]">{displayPair.path}</p>
        </div>
      </div>
    );
  }

  if (displayPair.truncated) {
    return (
      <div className="flex flex-col flex-1 min-h-0 bg-[#1f1f1f]">
        {topBar}
        <div className="flex flex-col items-center justify-center flex-1 text-[#868686] text-[13px] gap-1">
          <p className="m-0 text-[#cccccc]">文件过大，已跳过全文预览</p>
          <p className="m-0 text-[12px] text-[#868686]">
            {displayPair.path} · 共 {displayPair.additions} 行新增、{displayPair.deletions} 行删除
          </p>
        </div>
      </div>
    );
  }

  const totalOverviewHeight = Math.max(
    viewportHeight,
    contentHeight,
    rows.length * ROW_HEIGHT,
  );
  const thumbTopPct =
    totalOverviewHeight > 0
      ? Math.min(100, (scrollTop / totalOverviewHeight) * 100)
      : 0;
  const thumbHeightPct =
    totalOverviewHeight > 0
      ? Math.max(4, Math.min(100 - thumbTopPct, (viewportHeight / totalOverviewHeight) * 100))
      : 100;

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-[#1f1f1f] relative overflow-hidden">
      {topBar}

      {/* Diff 主区域 + 右侧文件变更鸟瞰缩略细条 */}
      <div className="flex flex-1 min-h-0 overflow-hidden relative">
        <FindWidget
          open={findOpen}
          options={findOptions}
          onOptionsChange={setFindOptions}
          totalMatches={diffMatches.length}
          activeIndex={activeMatchIdx}
          regexError={findRegexError}
          focusNonce={findFocusNonce}
          onNext={goNextMatch}
          onPrev={goPrevMatch}
          onClose={closeFind}
        />

        {/* Diff 内容滚动区 */}
        <div
          className="flex-1 min-w-0 overflow-auto bg-[#1f1f1f] font-mono text-[12.5px] leading-[20px]"
          ref={scrollRef}
          onScroll={handleScroll}
        >
        {rows.length === 0 && (
          <div className="flex items-center justify-center h-full text-[#868686] text-[13px] font-sans">
            没有文本差异
          </div>
        )}

        {paddingTop > 0 && <div style={{ height: paddingTop, flexShrink: 0 }} />}

        {visibleRows.map((row, i) => {
          const ri = startIndex + i;
          const showHunkBar = hasHunkActions && row.isHunkStart && row.hunk;

          const tokensFor = (side: "old" | "new", no: number | undefined) => {
            if (no === undefined) return null;
            const source = side === "old" ? oldTokens : newTokens;
            if (!source) return null;
            return source[no - 1] ?? null;
          };

          const hunkBarEl = showHunkBar && (
            <div className="flex items-center justify-between px-3 py-1 bg-[#181818] border-y border-[#2b2b2b] text-[11px] font-sans">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="font-mono text-[#9d9d9d] truncate">{row.hunk!.header}</span>
                <span className="flex items-center gap-1.5 font-mono">
                  {row.hunk!.additions > 0 && (
                    <span className="text-[#73c991]">+{row.hunk!.additions}</span>
                  )}
                  {row.hunk!.deletions > 0 && (
                    <span className="text-[#c74e39]">-{row.hunk!.deletions}</span>
                  )}
                </span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {canStageHunk && (
                  <IconButton
                    size="xs"
                    tooltip="暂存该变更块"
                    icon={<Plus size={12} strokeWidth={2} />}
                    onClick={(e) => {
                      e.stopPropagation();
                      onStageHunk?.(row.hunk!.index);
                    }}
                  />
                )}
                {canUnstageHunk && (
                  <IconButton
                    size="xs"
                    tooltip="取消暂存该变更块"
                    icon={<Minus size={12} strokeWidth={2} />}
                    onClick={(e) => {
                      e.stopPropagation();
                      onUnstageHunk?.(row.hunk!.index);
                    }}
                  />
                )}
                {canDiscardHunk && (
                  <IconButton
                    size="xs"
                    variant="danger"
                    align="right"
                    tooltip="放弃该变更块"
                    icon={<Undo2 size={11.5} strokeWidth={1.85} />}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDiscardHunk?.(row.hunk!.index);
                    }}
                  />
                )}
              </div>
            </div>
          );

          return (
            <React.Fragment key={ri}>
              {hunkBarEl}

              {row.isContext ? (
                <div className="grid grid-cols-2 min-h-[20px]">
                  <div className="flex min-w-0 bg-[#1f1f1f] border-r border-[#2b2b2b]">
                    <span className="w-[54px] shrink-0 text-right pr-3 text-[#6e7681] select-none text-[11.5px]">
                      {row.left?.no}
                    </span>
                    <span className="flex-1 whitespace-pre px-2 text-[#cccccc] min-w-0 overflow-hidden">
                      <CodeLine
                        tokens={tokensFor("old", row.left?.no)}
                        fallback={row.left?.text ?? ""}
                        highlights={leftHighlightsMap.get(ri)}
                      />
                    </span>
                  </div>
                  <div className="flex min-w-0 bg-[#1f1f1f]">
                    <span className="w-[54px] shrink-0 text-right pr-3 text-[#6e7681] select-none text-[11.5px]">
                      {row.right?.no}
                    </span>
                    <span className="flex-1 whitespace-pre px-2 text-[#cccccc] min-w-0 overflow-hidden">
                      <CodeLine
                        tokens={tokensFor("new", row.right?.no)}
                        fallback={row.right?.text ?? ""}
                        highlights={rightHighlightsMap.get(ri)}
                      />
                    </span>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 min-h-[20px]">
                  <div
                    className={`flex min-w-0 border-r border-[#2b2b2b] ${
                      row.left ? "bg-[rgba(255,0,0,0.16)]" : "bg-diff-hatch"
                    }`}
                  >
                    {row.left && (
                      <>
                        <span className="w-[54px] shrink-0 flex items-center justify-end gap-1 pr-1.5 text-[#c74e39] bg-[rgba(255,0,0,0.12)] select-none text-[11.5px]">
                          <span>{row.left.no}</span>
                          <span className="w-2.5 text-center font-bold">-</span>
                        </span>
                        <span className="flex-1 whitespace-pre px-2 text-[#cccccc] min-w-0 overflow-hidden">
                          <CodeLine
                            tokens={tokensFor("old", row.left.no)}
                            fallback={row.left.text}
                            highlights={leftHighlightsMap.get(ri)}
                          />
                        </span>
                      </>
                    )}
                  </div>
                  <div
                    className={`flex min-w-0 ${
                      row.right ? "bg-[rgba(155,185,85,0.16)]" : "bg-diff-hatch"
                    }`}
                  >
                    {row.right && (
                      <>
                        <span className="w-[54px] shrink-0 flex items-center justify-end gap-1 pr-1.5 text-[#73c991] bg-[rgba(155,185,85,0.12)] select-none text-[11.5px]">
                          <span>{row.right.no}</span>
                          <span className="w-2.5 text-center font-bold">+</span>
                        </span>
                        <span className="flex-1 whitespace-pre px-2 text-[#cccccc] min-w-0 overflow-hidden">
                          <CodeLine
                            tokens={tokensFor("new", row.right.no)}
                            fallback={row.right.text}
                            highlights={rightHighlightsMap.get(ri)}
                          />
                        </span>
                      </>
                    )}
                  </div>
                </div>
              )}
            </React.Fragment>
          );
        })}

        {paddingBottom > 0 && <div style={{ height: paddingBottom, flexShrink: 0 }} />}
        </div>

        {/* 右侧变更鸟瞰概览细条 (VS Code Overview Ruler) */}
        {rows.length > 0 && (
          <div
            ref={rulerRef}
            className="w-[14px] shrink-0 bg-[#181818] border-l border-[#2b2b2b] relative select-none cursor-pointer"
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              setDraggingRuler(true);
              jumpToRulerY(e.clientY);
            }}
            onMouseMove={(e) => {
              const ruler = rulerRef.current;
              if (!ruler) return;
              const rect = ruler.getBoundingClientRect();
              if (rect.height <= 0) return;
              const ratio = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
              const idx = Math.min(rows.length - 1, Math.max(0, Math.floor(ratio * rows.length)));
              const r = rows[idx];
              const lineNo = r?.right?.no || r?.left?.no || idx + 1;
              const kindText = r && !r.isContext
                ? !r.left && r.right
                  ? " · 新增"
                  : r.left && !r.right
                    ? " · 删除"
                    : " · 修改"
                : "";
              setRulerHover({
                top: Math.max(12, Math.min(rect.height - 14, e.clientY - rect.top)),
                label: `第 ${lineNo} 行${kindText}`,
              });
            }}
            onMouseLeave={() => setRulerHover(null)}
          >
            {/* 变更色块标记 */}
            {overviewSpans.map((span, idx) => {
              const topPct = (span.start / rows.length) * 100;
              const heightPct = (span.count / rows.length) * 100;
              const barColor =
                span.kind === "add"
                  ? "bg-[#73c991]/90"
                  : span.kind === "del"
                    ? "bg-[#f14c4c]/90"
                    : "bg-[#e2c08d]/90";
              return (
                <div
                  key={idx}
                  className={`pointer-events-none absolute left-[2px] right-[2px] rounded-[1px] min-h-[3px] ${barColor}`}
                  style={{
                    top: `${topPct}%`,
                    height: `${heightPct}%`,
                  }}
                />
              );
            })}

            {/* 查找命中鸟瞰指示点 */}
            {findOpen &&
              diffMatches.slice(0, 400).map((m, i) => {
                const topPct = (m.rowIndex / Math.max(1, rows.length)) * 100;
                const isActive = i === activeMatchIdx;
                return (
                  <div
                    key={`fm-${m.rowIndex}-${m.side}-${i}`}
                    className={`pointer-events-none absolute left-[4px] right-[4px] min-h-[2px] rounded-[1px] ${
                      isActive ? "z-20 min-h-[3px] bg-[#f8c555]" : "z-10 bg-[#3794ff]/90"
                    }`}
                    style={{ top: `${topPct}%` }}
                  />
                );
              })}

            {/* 当前视口范围指示框 */}
            <div
              className={`pointer-events-none absolute left-0 right-0 bg-white/[0.12] border-y border-white/25 ${
                draggingRuler ? "" : "transition-[top] duration-75"
              }`}
              style={{
                top: `${thumbTopPct}%`,
                height: `${thumbHeightPct}%`,
              }}
            />

            {/* 悬浮定位提示 */}
            {rulerHover && (
              <div
                className="pointer-events-none absolute right-[18px] z-30 -translate-y-1/2 whitespace-nowrap rounded-[3px] border border-[#454545] bg-[#252526] px-2 py-1 text-[11px] font-sans text-[#cccccc] shadow-[0_4px_12px_rgba(0,0,0,0.55)]"
                style={{ top: rulerHover.top }}
              >
                {rulerHover.label}
              </div>
            )}
          </div>
        )}
      </div>

      {highlighting && (
        <div className="absolute bottom-2 right-6 px-2.5 py-1 rounded-[3px] bg-[#252526] border border-[#3c3c3c] text-[11px] text-[#9d9d9d] shadow-md pointer-events-none">
          正在应用语法高亮…
        </div>
      )}
    </div>
  );
});
