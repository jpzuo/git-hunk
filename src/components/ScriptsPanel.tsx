/**
 * 项目可执行脚本管理面板（左栏 `scripts` 视图，Tailwind v4 + VS Code Dark Modern）。
 */

import React, { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FileCode,
  Play,
  RefreshCw,
  RotateCw,
  Search,
  Square,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { IconButton } from "./IconButton";
import type { ScriptGroup, ScriptItem, ScriptRunRecord } from "../types";

interface Props {
  workdir: string | null;
  groups: ScriptGroup[];
  loading: boolean;
  runs: ScriptRunRecord[];
  activeRunId: string | null;
  onRefresh: () => void;
  onRunScript: (script: ScriptItem) => void;
  onStopRun: (runId: string) => void;
  onRestartScript: (script: ScriptItem, activeRunId?: string) => void;
  onSelectRun: (runId: string) => void;
  onOpenConfigFile: (relPath: string) => void;
  onOpenExternalTerminal: (cwdRel: string) => void;
}

const ECOSYSTEM_BADGE: Record<string, { label: string; cls: string }> = {
  node: { label: "JS/TS", cls: "border-[#3178c6]/40 bg-[#3178c6]/15 text-[#75beff]" },
  rust: { label: "Rust", cls: "border-[#ce9178]/40 bg-[#ce9178]/15 text-[#e2c08d]" },
  python: { label: "Python", cls: "border-[#73c991]/40 bg-[#73c991]/15 text-[#73c991]" },
  go: { label: "Go", cls: "border-[#4ec9b0]/40 bg-[#4ec9b0]/15 text-[#4ec9b0]" },
  java: { label: "Java", cls: "border-[#e2c08d]/40 bg-[#e2c08d]/15 text-[#e2c08d]" },
  dotnet: { label: ".NET", cls: "border-[#c586c0]/40 bg-[#c586c0]/15 text-[#c586c0]" },
  php: { label: "PHP", cls: "border-[#c586c0]/40 bg-[#c586c0]/15 text-[#c586c0]" },
  make: { label: "Task", cls: "border-[#868686]/40 bg-[#333333] text-[#cccccc]" },
  vscode: { label: "Tasks", cls: "border-[#0078d4]/40 bg-[#04395e] text-[#75beff]" },
  docker: { label: "Docker", cls: "border-[#3794ff]/40 bg-[#3794ff]/15 text-[#75beff]" },
};

export const ScriptsPanel = React.memo(function ScriptsPanel({
  workdir,
  groups,
  loading,
  runs,
  activeRunId,
  onRefresh,
  onRunScript,
  onStopRun,
  onRestartScript,
  onSelectRun,
  onOpenConfigFile,
  onOpenExternalTerminal,
}: Props) {
  const [filterText, setFilterText] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const activeRunByScriptId = useMemo(() => {
    const map = new Map<string, ScriptRunRecord>();
    for (const r of runs) {
      if (r.status === "running") {
        map.set(r.script.id, r);
      }
    }
    return map;
  }, [runs]);

  const filteredGroups = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => {
        const groupMatch =
          g.source_label.toLowerCase().includes(q) ||
          g.ecosystem.toLowerCase().includes(q) ||
          (g.package_manager?.toLowerCase().includes(q) ?? false);
        const scripts = groupMatch
          ? g.scripts
          : g.scripts.filter(
              (s) =>
                s.name.toLowerCase().includes(q) ||
                s.display_command.toLowerCase().includes(q) ||
                (s.detail?.toLowerCase().includes(q) ?? false),
            );
        return { ...g, scripts };
      })
      .filter((g) => g.scripts.length > 0);
  }, [groups, filterText]);

  const totalScripts = useMemo(
    () => groups.reduce((acc, g) => acc + g.scripts.length, 0),
    [groups],
  );
  const runningCount = activeRunByScriptId.size;

  const allCollapsed =
    filteredGroups.length > 0 && filteredGroups.every((g) => collapsedGroups.has(g.key));

  const toggleAllGroups = () => {
    if (allCollapsed) {
      setCollapsedGroups(new Set());
    } else {
      setCollapsedGroups(new Set(filteredGroups.map((g) => g.key)));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#181818]">
      {/* 头部标题 + 纯图标工具栏 */}
      <div className="flex min-h-[35px] shrink-0 items-center justify-between border-b border-[#2b2b2b] px-3 py-2">
        <div className="flex items-center gap-2 overflow-hidden">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[#cccccc]">
            项目脚本
          </span>
          {totalScripts > 0 && (
            <span className="rounded-full bg-[#252526] border border-[#3c3c3c] px-1.5 py-px text-[10px] tabular-nums text-[#9d9d9d]">
              {totalScripts}
            </span>
          )}
          {runningCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#73c991]/15 border border-[#73c991]/40 px-1.5 py-px text-[10px] font-medium tabular-nums text-[#73c991]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#73c991]" />
              {runningCount}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            tooltip={allCollapsed ? "全部展开" : "全部折叠"}
            disabled={filteredGroups.length === 0}
            icon={allCollapsed ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
            onClick={toggleAllGroups}
          />
          <IconButton
            tooltip="重新扫描项目脚本"
            align="right"
            disabled={!workdir || loading}
            icon={<RefreshCw size={13} className={loading ? "animate-spin" : ""} />}
            onClick={onRefresh}
          />
        </div>
      </div>

      {/* 过滤框 */}
      <div className="shrink-0 border-b border-[#2b2b2b] bg-[#181818] px-2.5 py-1.5">
        <div className="relative flex h-[26px] items-center rounded-[2px] border border-[#3c3c3c] bg-[#313131] px-2 focus-within:border-[#0078d4]">
          <Search size={12} className="shrink-0 text-[#868686]" />
          <input
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && filterText) {
                e.stopPropagation();
                setFilterText("");
              }
            }}
            placeholder="筛选脚本名、命令或语言…"
            className="ml-1.5 w-full border-none bg-transparent text-[12px] text-[#cccccc] placeholder-[#868686] outline-none"
          />
          {filterText && (
            <button
              type="button"
              title="清除筛选"
              className="flex cursor-pointer items-center justify-center border-none bg-transparent p-0.5 text-[#9d9d9d] hover:text-white"
              onClick={() => setFilterText("")}
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* 脚本分组列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {!workdir ? (
          <div className="px-4 py-9 text-center text-[12px] text-[#868686]">
            请先打开一个工作区
          </div>
        ) : loading && groups.length === 0 ? (
          <div className="px-4 py-9 text-center text-[12px] text-[#868686]">
            正在解析项目可执行脚本…
          </div>
        ) : filteredGroups.length === 0 ? (
          <div className="px-4 py-9 text-center text-[12px] leading-relaxed text-[#868686]">
            {groups.length === 0
              ? "未在当前项目发现常见脚本配置（支持 package.json、Cargo.toml、pyproject.toml、go.mod、Makefile 等）"
              : `未找到匹配 "${filterText.trim()}" 的脚本`}
          </div>
        ) : (
          <div className="py-1">
            {filteredGroups.map((group) => {
              const isCollapsed = collapsedGroups.has(group.key) && !filterText.trim();
              const badge = ECOSYSTEM_BADGE[group.ecosystem] ?? ECOSYSTEM_BADGE.make;

              return (
                <div key={group.key} className="select-none border-b border-[#2b2b2b]/60 last:border-b-0">
                  {/* 分组头 */}
                  <div
                    className="group flex h-[28px] cursor-pointer items-center gap-1.5 px-2 text-[11.5px] text-[#cccccc] hover:bg-[#2a2d2e]"
                    title={`${group.source_label}\n目录: ${group.cwd}`}
                    onClick={() => {
                      setCollapsedGroups((prev) => {
                        const next = new Set(prev);
                        if (next.has(group.key)) next.delete(group.key);
                        else next.add(group.key);
                        return next;
                      });
                    }}
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[#9d9d9d]">
                      {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    </span>
                    <span
                      className={`shrink-0 rounded-[3px] border px-1 py-[1px] text-[9.5px] font-semibold leading-none ${badge.cls}`}
                    >
                      {group.package_manager?.toUpperCase() || badge.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium text-[#cccccc]">
                      {group.source_label}
                    </span>

                    <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                      <IconButton
                        size="xs"
                        tooltip={`打开配置文件 (${group.source_file})`}
                        icon={<FileCode size={12} />}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenConfigFile(group.source_file);
                        }}
                      />
                    </div>
                    <span className="shrink-0 rounded-full bg-[#252526] px-1.5 py-px text-[10px] tabular-nums text-[#868686]">
                      {group.scripts.length}
                    </span>
                  </div>

                  {/* 脚本条目 */}
                  {!isCollapsed && (
                    <div className="pb-1">
                      {group.scripts.map((script) => {
                        const activeRun = activeRunByScriptId.get(script.id);
                        const isSelected = activeRun && activeRun.run_id === activeRunId;

                        return (
                          <div
                            key={script.id}
                            className={`group flex min-h-[34px] cursor-pointer items-center gap-2 py-1 pl-6 pr-2 transition-colors ${
                              isSelected
                                ? "bg-[#04395e] text-white"
                                : "text-[#cccccc] hover:bg-[#2a2d2e]"
                            }`}
                            title={`${script.display_command}${script.detail ? `\n${script.detail}` : ""}\n工作目录: ${script.cwd}`}
                            onClick={() => {
                              if (activeRun) {
                                onSelectRun(activeRun.run_id);
                              } else {
                                onRunScript(script);
                              }
                            }}
                          >
                            {/* 状态点或图标 */}
                            <span className="flex w-3 shrink-0 items-center justify-center">
                              {activeRun ? (
                                <span
                                  className="h-2 w-2 animate-pulse rounded-full bg-[#73c991]"
                                  title="正在运行"
                                />
                              ) : (
                                <span className="h-1.5 w-1.5 rounded-full bg-[#505050] group-hover:bg-[#868686]" />
                              )}
                            </span>

                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-[12px] font-medium">
                                  {script.name}
                                </span>
                                {script.is_long_running && (
                                  <span
                                    className={`shrink-0 rounded-[2px] border px-1 py-0 text-[9px] leading-[13px] ${
                                      isSelected
                                        ? "border-white/30 bg-white/15 text-white"
                                        : "border-[#3c3c3c] bg-[#252526] text-[#9d9d9d]"
                                    }`}
                                  >
                                    服务
                                  </span>
                                )}
                              </div>
                              <div
                                className={`truncate font-mono text-[10.5px] ${
                                  isSelected ? "text-white/75" : "text-[#868686]"
                                }`}
                              >
                                {script.detail || script.display_command}
                              </div>
                            </div>

                            {/* 右侧纯图标悬浮操作按钮 */}
                            <div
                              className={`flex shrink-0 items-center gap-0.5 ${
                                activeRun ? "flex" : "hidden group-hover:flex"
                              }`}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {activeRun ? (
                                <>
                                  <IconButton
                                    size="xs"
                                    variant="danger"
                                    tooltip="停止运行"
                                    icon={<Square size={11} className="fill-current" />}
                                    onClick={() => onStopRun(activeRun.run_id)}
                                  />
                                  <IconButton
                                    size="xs"
                                    tooltip="重启脚本"
                                    icon={<RotateCw size={12} />}
                                    onClick={() => onRestartScript(script, activeRun.run_id)}
                                  />
                                </>
                              ) : (
                                <IconButton
                                  size="xs"
                                  tooltip={`运行 (${script.display_command})`}
                                  icon={<Play size={12} className="text-[#73c991]" />}
                                  onClick={() => onRunScript(script)}
                                />
                              )}
                              <IconButton
                                size="xs"
                                align="right"
                                tooltip="在外部终端打开所在目录"
                                icon={<TerminalIcon size={12} />}
                                onClick={() => onOpenExternalTerminal(script.cwd)}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});
