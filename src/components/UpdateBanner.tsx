/**
 * 「发现新版本」提示条：位于标题栏下方，用于展示更新并触发下载安装。
 */

import React from "react";
import { Download, Sparkles, X, Loader2 } from "lucide-react";
import type { UpdateInfo } from "../types";
import type { UpdaterStatus } from "../updater/useUpdater";
import { progressPercent, type UpdaterProgress } from "../updater/updateUtils";

interface UpdateBannerProps {
  info: UpdateInfo;
  status: UpdaterStatus;
  progress: UpdaterProgress | null;
  onInstall: () => void;
  onSkip: () => void;
  onDismiss: () => void;
}

export const UpdateBanner = React.memo(function UpdateBanner({
  info,
  status,
  progress,
  onInstall,
  onSkip,
  onDismiss,
}: UpdateBannerProps) {
  const busy = status === "downloading" || status === "installing";
  const pct = progressPercent(progress);

  const label =
    status === "installing"
      ? "正在安装，应用即将重启…"
      : status === "downloading"
        ? pct !== null
          ? `正在下载更新… ${pct}%`
          : "正在下载更新…"
        : `发现新版本 v${info.version}`;

  return (
    <div className="flex shrink-0 items-center gap-2.5 border-b border-[#2b2b2b] bg-[#0f2d4a] px-3 py-1.5 text-[12px] text-[#cfe4ff]">
      <Sparkles size={14} strokeWidth={1.9} className="shrink-0 text-[#4daafc]" />
      <span className="shrink-0 font-medium text-white">{label}</span>
      {busy && pct !== null && (
        <span className="h-1 w-28 shrink-0 overflow-hidden rounded-full bg-[#1b4b73]">
          <span
            className="block h-full rounded-full bg-[#4daafc] transition-[width] duration-150"
            style={{ width: `${pct}%` }}
          />
        </span>
      )}
      {!busy && (
        <span className="truncate text-[#9dc4ea]">
          当前 v{info.current_version}
          {info.body ? ` · ${info.body.split("\n")[0]}` : ""}
        </span>
      )}
      <span className="flex-1" />
      {busy ? (
        <Loader2 size={14} className="animate-spin text-[#9dc4ea]" />
      ) : (
        <>
          <button
            type="button"
            className="cursor-pointer rounded-[3px] border border-[#0078d4] bg-[#0078d4] px-2.5 py-[3px] text-[11.5px] font-medium text-white transition-colors hover:border-[#026ec1] hover:bg-[#026ec1]"
            onClick={onInstall}
          >
            <Download size={12} className="mr-1 inline" />
            下载并安装
          </button>
          <button
            type="button"
            className="cursor-pointer rounded-[3px] border border-[#3c3c3c] bg-transparent px-2.5 py-[3px] text-[11.5px] text-[#cfe4ff] transition-colors hover:bg-white/10"
            onClick={onSkip}
            title="不再提示这个版本"
          >
            忽略此版本
          </button>
        </>
      )}
      <button
        type="button"
        className="ml-0.5 flex h-5 w-5 cursor-pointer items-center justify-center rounded-[3px] border-none bg-transparent text-[#9dc4ea] transition-colors hover:bg-white/10 hover:text-white"
        onClick={onDismiss}
        title="稍后再说"
      >
        <X size={13} />
      </button>
    </div>
  );
});
