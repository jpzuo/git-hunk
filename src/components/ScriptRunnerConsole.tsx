/**
 * 内置多实例流式脚本输出控制台（用于「脚本」主视图）。
 *
 * 支持：
 * - 多并发运行实例标签切换（pnpm dev / cargo test 等可同时运行）
 * - ANSI SGR 彩色输出渲染与可点击 http(s) URL（通过 Tauri opener 打开默认浏览器）
 * - 自动滚动到底部锁定、关键词过滤日志、停止/重启/清空/复制日志
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowDownToLine,
  Check,
  CheckCircle2,
  Copy,
  Eraser,
  Filter,
  Play,
  RotateCw,
  Search,
  Square,
  Terminal as TerminalIcon,
  X,
  XCircle,
} from "lucide-react";
import { IconButton } from "./IconButton";
import { parseAnsiLine, type AnsiSegment } from "../utils/ansi";
import { filterTerminalNoiseLines, stripAnsiCodes } from "../utils/terminalLogFilter";
import type { ScriptItem, ScriptRunRecord } from "../types";

interface Props {
  runs: ScriptRunRecord[];
  activeRunId: string | null;
  onSelectRun: (runId: string) => void;
  onStopRun: (runId: string) => void;
  onRestartRun: (run: ScriptRunRecord) => void;
  onClearLogs: (runId: string) => void;
  onCloseRunTab: (runId: string) => void;
  onRunQuickScript?: (script: ScriptItem) => void;
  quickScripts?: ScriptItem[];
}

function handleOpenExternalUrl(url: string) {
  openUrl(url).catch(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  });
}

function RunStatusDot({ status }: { status: ScriptRunRecord["status"] }) {
  if (status === "running") {
    return <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[#73c991]" />;
  }
  if (status === "success") {
    return <CheckCircle2 size={12} className="shrink-0 text-[#73c991]" />;
  }
  if (status === "failed") {
    return <XCircle size={12} className="shrink-0 text-[#f14c4c]" />;
  }
  return <Square size={10} className="shrink-0 text-[#868686]" />;
}

export const ScriptRunnerConsole = React.memo(function ScriptRunnerConsole({
  runs,
  activeRunId,
  onSelectRun,
  onStopRun,
  onRestartRun,
  onClearLogs,
  onCloseRunTab,
  onRunQuickScript,
  quickScripts = [],
}: Props) {
  const activeRun = useMemo(
    () => runs.find((r) => r.run_id === activeRunId) ?? runs[runs.length - 1] ?? null,
    [runs, activeRunId],
  );

  const [autoScroll, setAutoScroll] = useState(true);
  const [hideNoise, setHideNoise] = useState(true);
  const [logFilter, setLogFilter] = useState("");
  const [copied, setCopied] = useState(false);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const runTabsRef = useRef<HTMLDivElement>(null);

  const { displayedLines, hiddenNoiseCount } = useMemo(() => {
    if (!activeRun) return { displayedLines: [], hiddenNoiseCount: 0 };
    const all = activeRun.partial_line
      ? [
          ...activeRun.lines,
          {
            id: -1,
            stream: "stdout" as const,
            text: activeRun.partial_line,
          },
        ]
      : activeRun.lines;

    const base = hideNoise ? filterTerminalNoiseLines(all) : { lines: all, hiddenCount: 0 };
    const q = logFilter.trim().toLowerCase();
    const filtered = q
      ? base.lines.filter((l) => stripAnsiCodes(l.text).toLowerCase().includes(q))
      : base.lines;
    return {
      displayedLines: filtered,
      hiddenNoiseCount: base.hiddenCount,
    };
  }, [activeRun, hideNoise, logFilter]);

  useEffect(() => {
    if (!autoScroll || !activeRun) return;
    const el = logContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [autoScroll, activeRun?.run_id, displayedLines.length, activeRun?.partial_line]);

  useEffect(() => {
    const container = runTabsRef.current;
    const runId = activeRun?.run_id;
    if (!container || !runId) return;
    for (const child of Array.from(container.children)) {
      if (child instanceof HTMLElement && child.getAttribute("data-run-id") === runId) {
        child.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
        break;
      }
    }
  }, [activeRun?.run_id, runs.length]);

  const handleScroll = useCallback(() => {
    const el = logContainerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance > 36 && autoScroll) {
      setAutoScroll(false);
    } else if (distance <= 8 && !autoScroll) {
      setAutoScroll(true);
    }
  }, [autoScroll]);

  const handleCopyAll = useCallback(() => {
    if (!activeRun) return;
    const plain = displayedLines.map((l) => stripAnsiCodes(l.text)).join("\n");
    void navigator.clipboard.writeText(plain);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }, [activeRun, displayedLines]);

  if (runs.length === 0) {
    return (
      <div className="flex flex-1 min-h-0 flex-col bg-[#1f1f1f]">
        <div className="flex flex-1 select-none flex-col items-center justify-center px-6 text-center">
          <TerminalIcon size={40} className="mb-3 text-[#868686] opacity-55" />
          <h3 className="m-0 mb-1.5 text-[14px] font-medium text-[#cccccc]">
            项目脚本运行控制台
          </h3>
          <p className="m-0 max-w-[380px] text-[12px] leading-relaxed text-[#868686]">
            自动识别前端 pnpm/npm/yarn/bun、Rust Cargo、Python、Go、Java、Makefile 等可执行脚本，点击运行即可在此查看实时彩色日志。
          </p>

          {quickScripts.length > 0 && onRunQuickScript && (
            <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">
              {quickScripts.slice(0, 6).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-[3px] border border-[#3c3c3c] bg-[#252526] px-2.5 py-1 text-[11.5px] text-[#cccccc] transition-colors hover:border-[#505050] hover:bg-[#2a2d2e] hover:text-white"
                  title={s.display_command}
                  onClick={() => onRunQuickScript(s)}
                >
                  <Play size={11} className="text-[#73c991]" />
                  <span>{s.name}</span>
                  <span className="font-mono text-[10px] text-[#868686]">{s.cwd === "." ? "" : s.cwd}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  const statusText =
    activeRun?.status === "running"
      ? "运行中"
      : activeRun?.status === "success"
        ? `已退出 (code ${activeRun.exit_code ?? 0})`
        : activeRun?.status === "stopped"
          ? "已手动停止"
          : `运行失败 (code ${activeRun?.exit_code ?? -1})`;

  const statusBadgeClass =
    activeRun?.status === "running"
      ? "border-[#73c991]/40 bg-[#73c991]/15 text-[#73c991]"
      : activeRun?.status === "success"
        ? "border-[#73c991]/30 bg-[#73c991]/10 text-[#73c991]"
        : activeRun?.status === "stopped"
          ? "border-[#3c3c3c] bg-[#252526] text-[#9d9d9d]"
          : "border-[#f14c4c]/40 bg-[#f14c4c]/15 text-[#f48771]";

  return (
    <div className="flex flex-1 min-h-0 flex-col bg-[#1f1f1f]">
      {/* 顶部运行实例 Tab 条 */}
      <div className="flex h-[32px] shrink-0 items-center border-b border-[#2b2b2b] bg-[#181818]">
        <div
          ref={runTabsRef}
          className="flex min-w-0 flex-1 items-center overflow-x-auto scrollbar-none"
          onWheel={(e) => {
            if (e.deltaY !== 0) {
              e.currentTarget.scrollLeft += e.deltaY;
            }
          }}
        >
          {runs.map((run) => {
            const isActive = run.run_id === activeRun?.run_id;
            return (
              <div
                key={run.run_id}
                data-run-id={run.run_id}
                className={`group flex h-[32px] shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap border-r border-[#2b2b2b] px-2.5 text-[11.5px] transition-colors ${
                  isActive
                    ? "bg-[#1f1f1f] text-white"
                    : "bg-[#181818] text-[#9d9d9d] hover:bg-[#252526] hover:text-[#cccccc]"
                }`}
                title={`${run.script.display_command} (${run.script.cwd})`}
                onClick={() => onSelectRun(run.run_id)}
              >
                <RunStatusDot status={run.status} />
                <span className="whitespace-nowrap font-medium">{run.script.name}</span>
                {run.script.cwd !== "." && (
                  <span className="whitespace-nowrap font-mono text-[10px] text-[#868686]">
                    {run.script.cwd}
                  </span>
                )}
                <button
                  type="button"
                  title={run.status === "running" ? "停止并关闭输出标签" : "关闭输出标签"}
                  className="ml-0.5 flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-[2px] border-none bg-transparent text-[#868686] opacity-70 hover:bg-[#3c3c3c] hover:text-white hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseRunTab(run.run_id);
                  }}
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* 工具栏：命令信息 + 状态 + 过滤 + 纯图标控制 */}
      {activeRun && (
        <div className="flex h-[32px] shrink-0 items-center justify-between gap-2 border-b border-[#2b2b2b] bg-[#181818] px-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className={`shrink-0 rounded-[3px] border px-1.5 py-px text-[10.5px] ${statusBadgeClass}`}>
              {statusText}
            </span>
            <span
              className="truncate font-mono text-[11.5px] text-[#cccccc]"
              title={`${activeRun.script.display_command} (工作目录: ${activeRun.script.cwd})`}
            >
              $ {activeRun.script.display_command}
            </span>
            {activeRun.script.cwd !== "." && (
              <span className="shrink-0 rounded-[2px] border border-[#3c3c3c] bg-[#252526] px-1.5 py-px font-mono text-[10px] text-[#9d9d9d]">
                {activeRun.script.cwd}
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <div className="relative mr-1 flex h-[22px] w-[160px] items-center rounded-[2px] border border-[#3c3c3c] bg-[#313131] px-1.5 focus-within:border-[#0078d4]">
              <Search size={11} className="shrink-0 text-[#868686]" />
              <input
                type="text"
                value={logFilter}
                onChange={(e) => setLogFilter(e.target.value)}
                placeholder="过滤日志…"
                className="ml-1 w-full border-none bg-transparent text-[11px] text-[#cccccc] placeholder-[#868686] outline-none"
              />
              {logFilter && (
                <button
                  type="button"
                  title="清除过滤"
                  className="cursor-pointer border-none bg-transparent p-0 text-[#868686] hover:text-white"
                  onClick={() => setLogFilter("")}
                >
                  <X size={11} />
                </button>
              )}
            </div>

            {activeRun.status === "running" ? (
              <IconButton
                tooltip="停止进程"
                variant="danger"
                icon={<Square size={12} className="fill-current" />}
                onClick={() => onStopRun(activeRun.run_id)}
              />
            ) : null}
            <IconButton
              tooltip="重新运行"
              icon={<RotateCw size={12.5} />}
              onClick={() => onRestartRun(activeRun)}
            />
            <IconButton
              tooltip={
                hideNoise
                  ? hiddenNoiseCount > 0
                    ? `已隐藏 ${hiddenNoiseCount} 条警告与信息（点击展示原始全部输出）`
                    : "已开启隐藏警告与信息类输出（点击切换）"
                  : "点击隐藏警告与信息类输出"
              }
              variant={hideNoise ? "active" : "ghost"}
              icon={<Filter size={12.5} />}
              onClick={() => setHideNoise((v) => !v)}
            />
            <IconButton
              tooltip={autoScroll ? "已锁定自动滚到底部" : "锁定自动滚到底部"}
              variant={autoScroll ? "active" : "ghost"}
              icon={<ArrowDownToLine size={12.5} />}
              onClick={() => {
                setAutoScroll((v) => !v);
                if (!autoScroll && logContainerRef.current) {
                  logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
                }
              }}
            />
            <IconButton
              tooltip={copied ? "已复制日志" : "复制当前日志"}
              icon={copied ? <Check size={12.5} className="text-[#73c991]" /> : <Copy size={12.5} />}
              onClick={handleCopyAll}
            />
            <IconButton
              tooltip="清空日志输出"
              align="right"
              icon={<Eraser size={12.5} />}
              onClick={() => onClearLogs(activeRun.run_id)}
            />
          </div>
        </div>
      )}

      {/* ANSI 彩色日志流输出区 */}
      <div
        ref={logContainerRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-auto bg-[#181818] px-3 py-2 font-mono text-[12px] leading-[19px] text-[#cccccc] select-text"
      >
        {displayedLines.length === 0 ? (
          <div className="py-6 text-[11.5px] text-[#868686]">
            {logFilter
              ? "没有匹配当前过滤条件的日志行"
              : activeRun?.status === "running"
                ? hiddenNoiseCount > 0
                  ? `进程运行中（已自动隐藏 ${hiddenNoiseCount} 条警告与提示信息）…`
                  : "进程已启动，等待输出…"
                : hiddenNoiseCount > 0
                  ? `已自动隐藏 ${hiddenNoiseCount} 条警告与提示信息`
                  : "暂无日志输出"}
          </div>
        ) : (
          displayedLines.map((line) => {
            const segs = parseAnsiLine(line.text);
            const grouped: Array<{ url?: string; items: AnsiSegment[] }> = [];
            for (const seg of segs) {
              const prev = grouped[grouped.length - 1];
              if (seg.url && prev && prev.url === seg.url) {
                prev.items.push(seg);
              } else {
                grouped.push({ url: seg.url, items: [seg] });
              }
            }

            const renderSegSpan = (seg: AnsiSegment, key: number) => {
              const style: React.CSSProperties = {};
              if (seg.style.fg) style.color = seg.style.fg;
              if (seg.style.bold) style.fontWeight = 600;
              if (seg.style.dim) style.opacity = 0.7;
              if (!seg.url && seg.style.underline) style.textDecoration = "underline";
              return (
                <span key={key} style={style}>
                  {seg.text}
                </span>
              );
            };

            return (
              <div
                key={line.id}
                className={`whitespace-pre-wrap break-all ${
                  line.stream === "system" ? "text-[#868686] italic" : ""
                }`}
              >
                {grouped.length === 0
                  ? " "
                  : grouped.map((grp, gi) =>
                      grp.url ? (
                        <a
                          key={gi}
                          href={grp.url}
                          className="cursor-pointer text-[#4ec9b0] underline decoration-1 underline-offset-2 hover:text-[#75beff] hover:brightness-125"
                          title={`在默认浏览器打开 ${grp.url}`}
                          onClick={(e) => {
                            e.preventDefault();
                            handleOpenExternalUrl(grp.url!);
                          }}
                        >
                          {grp.items.map((it, ii) => renderSegSpan(it, ii))}
                        </a>
                      ) : (
                        <React.Fragment key={gi}>
                          {grp.items.map((it, ii) => renderSegSpan(it, ii))}
                        </React.Fragment>
                      ),
                    )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
});
