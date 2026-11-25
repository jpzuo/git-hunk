/**
 * 提交关系图（DAG）—— VS Code Dark Modern 100% 原子化实现
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CommitRef, GraphCommit } from "../historyTypes";

const ROW_HEIGHT = 30;
const LANE_WIDTH = 14;
const LANE_PADDING = 10;
const OVERSCAN = 12;
const DOT_RADIUS = 4;

const LANE_COLORS = [
  "#3794ff",
  "#e2c08d",
  "#73c991",
  "#f14c4c",
  "#c586c0",
  "#4ec9b0",
  "#ce9178",
  "#ec407a",
  "#26c6da",
  "#8d6e63",
];

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

function laneX(lane: number): number {
  return LANE_PADDING + lane * LANE_WIDTH;
}

function formatTime(ts: number): string {
  const now = Date.now() / 1000;
  const diff = now - ts;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function refBadgeClass(kind: CommitRef["kind"]): string {
  if (kind === "head") return "bg-[#0078d4] text-white font-semibold border border-[#3794ff]";
  if (kind === "local_branch") return "bg-[#04395e] text-[#75beff] border border-[#0078d4]/60";
  if (kind === "remote_branch") return "bg-[#73c991]/15 text-[#73c991] border border-[#73c991]/40";
  return "bg-[#e2c08d]/15 text-[#e2c08d] border border-[#e2c08d]/40";
}

function renderMatchHighlight(
  text: string,
  query: string,
  isSelected: boolean,
): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  const end = idx + query.length;
  return (
    <>
      {text.slice(0, idx)}
      <span
        className={
          isSelected
            ? "rounded-[2px] bg-white/25 px-[1px] font-semibold text-white"
            : "rounded-[2px] bg-[#613214] px-[1px] font-semibold text-[#f8c555]"
        }
      >
        {text.slice(idx, end)}
      </span>
      {text.slice(end)}
    </>
  );
}

interface Props {
  commits: GraphCommit[];
  laneCount: number;
  selectedOid: string | null;
  loading: boolean;
  hasMore: boolean;
  searchQuery?: string;
  initialScrollTop?: number;
  onScrollTopChange?: (scrollTop: number) => void;
  onSelect: (oid: string) => void;
  onDoubleClick?: (oid: string) => void;
  onLoadMore: () => void;
}

export const CommitGraph = memo(function CommitGraph({
  commits,
  laneCount,
  selectedOid,
  loading,
  hasMore,
  searchQuery = "",
  initialScrollTop = 0,
  onScrollTopChange,
  onSelect,
  onDoubleClick,
  onLoadMore,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollRaf = useRef<number | null>(null);
  const restoredRef = useRef(false);
  const prevSearchQueryRef = useRef(searchQuery);
  const [scrollTop, setScrollTop] = useState(initialScrollTop);
  const [viewportHeight, setViewportHeight] = useState(600);

  const normalizedSearch = searchQuery.trim();
  const isSearchMode = normalizedSearch.length > 0;
  const onScrollTopChangeRef = useRef(onScrollTopChange);
  onScrollTopChangeRef.current = onScrollTopChange;

  // 仅当筛选词变化时重置滚动条回顶部；切回视图恢复 initialScrollTop 不受影响
  useEffect(() => {
    if (prevSearchQueryRef.current === searchQuery) return;
    prevSearchQueryRef.current = searchQuery;
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = 0;
    }
    setScrollTop(0);
    onScrollTopChangeRef.current?.(0);
  }, [searchQuery]);

  useLayoutEffect(() => {
    if (restoredRef.current || commits.length === 0) return;
    const el = scrollRef.current;
    if (!el || el.clientHeight <= 0) return;
    const vh = el.clientHeight;
    if (initialScrollTop > 0) {
      const maxTop = Math.max(0, commits.length * ROW_HEIGHT - vh);
      const clamped = Math.min(maxTop, Math.max(0, initialScrollTop));
      el.scrollTop = clamped;
      setScrollTop(clamped);
    }
    setViewportHeight(vh);
    restoredRef.current = true;
  }, [commits.length, initialScrollTop]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    ro.observe(el);
    setViewportHeight(el.clientHeight);
    return () => ro.disconnect();
  }, [commits.length]);

  const { start, end } = useMemo(() => {
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visible = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
    return { start: first, end: Math.min(commits.length, first + visible) };
  }, [scrollTop, viewportHeight, commits.length]);

  const visible = useMemo(() => commits.slice(start, end), [commits, start, end]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      onScrollTopChange?.(el.scrollTop);
    }
    if (scrollRaf.current !== null) return;
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = null;
      const currentEl = scrollRef.current;
      if (!currentEl) return;
      setScrollTop(currentEl.scrollTop);
      onScrollTopChange?.(currentEl.scrollTop);
      if (hasMore && !loading) {
        const bottom = currentEl.scrollHeight - currentEl.scrollTop - currentEl.clientHeight;
        if (bottom < ROW_HEIGHT * 10) onLoadMore();
      }
    });
  }, [hasMore, loading, onLoadMore, onScrollTopChange]);

  useEffect(() => {
    return () => {
      if (scrollRaf.current !== null) {
        cancelAnimationFrame(scrollRaf.current);
      }
    };
  }, []);

  const graphWidth = Math.max(LANE_WIDTH * Math.max(laneCount, 1), 20) + LANE_PADDING * 2;

  if (loading && commits.length === 0) {
    return (
      <div className="flex items-center justify-center flex-1 h-full bg-[#1f1f1f] text-[#868686] text-[13px]">
        加载提交历史…
      </div>
    );
  }

  if (commits.length === 0) {
    if (isSearchMode) {
      return (
        <div className="flex flex-col items-center justify-center flex-1 h-full bg-[#1f1f1f] text-[#868686] text-[13px] gap-1 px-6 text-center">
          <p className="m-0 text-[#cccccc]">未找到匹配的提交记录</p>
          <p className="m-0 text-[12px] text-[#868686]">
            当前分支范围内没有包含 “{normalizedSearch}” 的提交、作者、哈希或引用
          </p>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center flex-1 h-full bg-[#1f1f1f] text-[#868686] text-[13px] gap-1">
        <p className="m-0 text-[#cccccc]">这个仓库还没有任何提交</p>
        <p className="m-0 text-[12px] text-[#868686]">做一次提交后，这里会显示提交关系图</p>
      </div>
    );
  }

  return (
    <div
      className="flex-1 overflow-auto min-h-0 bg-[#1f1f1f] relative select-none"
      ref={scrollRef}
      onScroll={onScroll}
    >
      <div className="relative" style={{ height: commits.length * ROW_HEIGHT }}>
        <div
          className="absolute left-0 right-0 top-0"
          style={{ transform: `translateY(${start * ROW_HEIGHT}px)` }}
        >
          {visible.map((c) => {
            const isSelected = selectedOid === c.oid;
            const dotLane = isSearchMode ? 0 : c.lane;
            return (
              <div
                key={c.oid}
                className={`flex items-center px-3 cursor-pointer transition-colors ${
                  isSelected
                    ? "bg-[#04395e] text-white"
                    : "hover:bg-[#2a2d2e] text-[#cccccc]"
                }`}
                style={{ height: ROW_HEIGHT }}
                onClick={() => onSelect(c.oid)}
                onDoubleClick={() => onDoubleClick?.(c.oid)}
              >
                <div className="relative h-full shrink-0" style={{ width: graphWidth }}>
                  {!isSearchMode && (
                    <svg width={graphWidth} height={ROW_HEIGHT} className="block absolute inset-0">
                      {c.segments.map((seg, si) => {
                        const x1 = laneX(seg.from_lane);
                        const x2 = laneX(seg.to_lane);
                        const color = laneColor(seg.from_lane);
                        if (seg.from_lane === seg.to_lane) {
                          return (
                            <line
                              key={si}
                              x1={x1}
                              y1={ROW_HEIGHT / 2}
                              x2={x1}
                              y2={ROW_HEIGHT}
                              stroke={color}
                              strokeWidth={1.5}
                            />
                          );
                        }
                        return (
                          <path
                            key={si}
                            d={`M ${x1} ${ROW_HEIGHT / 2} C ${x1} ${ROW_HEIGHT * 0.8}, ${x2} ${ROW_HEIGHT * 0.2}, ${x2} ${ROW_HEIGHT / 2}`}
                            stroke={color}
                            strokeWidth={1.5}
                            fill="none"
                          />
                        );
                      })}
                    </svg>
                  )}
                  <svg width={graphWidth} height={ROW_HEIGHT} className="block absolute inset-0">
                    <circle
                      cx={laneX(dotLane)}
                      cy={ROW_HEIGHT / 2}
                      r={c.parents.length > 1 ? DOT_RADIUS + 1 : DOT_RADIUS}
                      fill={c.is_head ? "#ffffff" : "#1f1f1f"}
                      stroke={laneColor(dotLane)}
                      strokeWidth={2}
                    />
                  </svg>
                </div>

                <div className="flex items-center gap-2 flex-1 min-w-0 pl-2">
                  {c.refs.length > 0 && (
                    <span className="inline-flex items-center gap-1 shrink-0">
                      {c.refs.map((r, ri) => (
                        <span
                          key={`${r.kind}-${r.name}-${ri}`}
                          className={`px-1.5 py-0.5 text-[10.5px] leading-none rounded-[3px] font-medium ${refBadgeClass(r.kind)}`}
                          title={
                            r.kind === "local_branch"
                              ? "本地分支"
                              : r.kind === "remote_branch"
                                ? "远程分支"
                                : r.kind === "tag"
                                  ? "标签"
                                  : "HEAD"
                          }
                        >
                          {isSearchMode
                            ? renderMatchHighlight(r.name, normalizedSearch, isSelected)
                            : r.name}
                        </span>
                      ))}
                    </span>
                  )}
                  <span
                    className={`text-[12.5px] truncate flex-1 ${
                      isSelected ? "text-white font-medium" : "text-[#cccccc]"
                    }`}
                    title={c.summary}
                  >
                    {c.summary
                      ? isSearchMode
                        ? renderMatchHighlight(c.summary, normalizedSearch, isSelected)
                        : c.summary
                      : "(无提交信息)"}
                  </span>
                  <span className="inline-flex items-center gap-3 text-[11.5px] shrink-0 ml-2">
                    <span className={isSelected ? "text-white/85" : "text-[#9d9d9d]"}>
                      {isSearchMode
                        ? renderMatchHighlight(c.author_name, normalizedSearch, isSelected)
                        : c.author_name}
                    </span>
                    <span className={`w-[72px] text-right ${isSelected ? "text-white/75" : "text-[#868686]"}`}>
                      {formatTime(c.timestamp)}
                    </span>
                    <span className={`font-mono w-[58px] text-right ${isSelected ? "text-[#75beff]" : "text-[#3794ff]"}`}>
                      {isSearchMode
                        ? renderMatchHighlight(c.short_oid, normalizedSearch, isSelected)
                        : c.short_oid}
                    </span>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {loading && commits.length > 0 && (
        <div className="sticky bottom-2 mx-auto w-fit px-3 py-1 rounded-[4px] bg-[#252526] border border-[#3c3c3c] text-[11px] text-[#cccccc]">
          加载中…
        </div>
      )}
    </div>
  );
});
