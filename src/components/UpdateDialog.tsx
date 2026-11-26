/**
 * 「关于 / 检查更新」弹窗：展示应用信息，并承载手动检查与安装的完整流程。
 */

import React, { useState } from "react";
import { Loader2, RefreshCw, Download, CheckCircle2, AlertTriangle, ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { UpdateInfo } from "../types";
import type { CheckResult, UpdaterStatus } from "../updater/useUpdater";
import { progressPercent, type UpdaterProgress } from "../updater/updateUtils";

const REPO_URL = "https://github.com/jpzuo/git-hunk";
const IDENTIFIER = "com.tauri-app.git-hunk";

interface UpdateDialogProps {
  currentVersion: string | null;
  status: UpdaterStatus;
  info: UpdateInfo | null;
  progress: UpdaterProgress | null;
  error: string | null;
  onClose: () => void;
  onCheck: () => Promise<CheckResult>;
  onInstall: () => Promise<void>;
  onSkip: () => void;
}

type ManualMsg = null | "checking" | "uptodate";

export const UpdateDialog = React.memo(function UpdateDialog({
  currentVersion,
  status,
  info,
  progress,
  error,
  onClose,
  onCheck,
  onInstall,
  onSkip,
}: UpdateDialogProps) {
  const [manualMsg, setManualMsg] = useState<ManualMsg>(null);
  const busy = status === "checking" || status === "downloading" || status === "installing";
  const pct = progressPercent(progress);

  const runCheck = async () => {
    setManualMsg("checking");
    const res = await onCheck();
    if (res.ok && !res.update) setManualMsg("uptodate");
    else setManualMsg(null);
  };

  const showAvailable = status === "available" || status === "downloading" || status === "installing" || status === "ready";
  const showUpToDate = status === "idle" && manualMsg === "uptodate";
  const showError = status === "error" && error;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[1px]"
      onClick={onClose}
    >
      <div
        className="w-[460px] max-w-[92vw] rounded-[6px] border border-[#454545] bg-[#252526] p-5 text-[#cccccc] shadow-[0_12px_36px_rgba(0,0,0,0.65)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 text-[15px] font-semibold text-white">git-hunk</div>
        <div className="mb-4 text-[12px] text-[#9d9d9d]">
          当前版本 v{currentVersion ?? "…"} · 以 Git 为主要工作入口的桌面工具
        </div>

        <div className="mb-4 space-y-1 rounded-[4px] border border-[#2b2b2b] bg-[#1f1f1f] px-3 py-2 text-[11.5px] text-[#9d9d9d]">
          <div className="flex justify-between gap-2">
            <span>应用标识</span>
            <span className="font-mono text-[#cccccc]">{IDENTIFIER}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span>更新通道</span>
            <span className="text-[#cccccc]">正式版（v* 标签）</span>
          </div>
        </div>

        {/* 状态区 */}
        {showError && (
          <div className="mb-3 flex items-start gap-2 rounded-[4px] border border-[#f14c4c]/50 bg-[#3a1d1d] px-3 py-2 text-[12px] text-[#f48771]">
            <AlertTriangle size={14} className="mt-[1px] shrink-0" />
            <span className="break-all">检查或安装更新失败：{error}</span>
          </div>
        )}

        {showUpToDate && (
          <div className="mb-3 flex items-center gap-2 rounded-[4px] border border-[#2e5c3a] bg-[#17271b] px-3 py-2 text-[12px] text-[#73c991]">
            <CheckCircle2 size={14} className="shrink-0" />
            已是最新版本
          </div>
        )}

        {showAvailable && info && (
          <div className="mb-3 rounded-[4px] border border-[#2b4b6b] bg-[#102234] px-3 py-2.5 text-[12px]">
            <div className="mb-1 font-medium text-white">
              发现新版本 v{info.version}
              <span className="ml-2 text-[11px] font-normal text-[#9dc4ea]">
                当前 v{info.current_version}
              </span>
            </div>
            {info.body && (
              <div className="mb-2 max-h-[120px] overflow-auto whitespace-pre-wrap text-[11.5px] leading-relaxed text-[#b9cfe6]">
                {info.body}
              </div>
            )}
            {(status === "downloading" || status === "installing") && (
              <div className="mt-1">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#1b4b73]">
                  <div
                    className="h-full rounded-full bg-[#4daafc] transition-[width] duration-150"
                    style={{ width: `${pct ?? 5}%` }}
                  />
                </div>
                <div className="mt-1 text-[11px] text-[#9dc4ea]">
                  {status === "installing"
                    ? "正在安装，应用即将重启…"
                    : pct !== null
                      ? `正在下载… ${pct}%`
                      : "正在下载…"}
                </div>
              </div>
            )}
            {status === "ready" && (
              <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-[#73c991]">
                <CheckCircle2 size={13} /> 已安装，如未自动重启请手动重启应用。
              </div>
            )}
          </div>
        )}

        {/* 操作区 */}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            className="mr-auto inline-flex cursor-pointer items-center gap-1 border-none bg-transparent px-1 py-1 text-[11.5px] text-[#9d9d9d] transition-colors hover:text-[#cccccc]"
            onClick={() => void openUrl(REPO_URL).catch(() => {})}
          >
            <ExternalLink size={12} /> 项目主页
          </button>
          <button
            type="button"
            className="cursor-pointer rounded-[3px] border border-[#3c3c3c] bg-[#313131] px-3 py-1.5 text-[12px] text-[#cccccc] transition-colors hover:bg-[#3c3c3c] hover:text-white"
            onClick={onClose}
          >
            关闭
          </button>
          {showAvailable && info && status === "available" && (
            <>
              <button
                type="button"
                className="cursor-pointer rounded-[3px] border border-[#3c3c3c] bg-transparent px-3 py-1.5 text-[12px] text-[#cccccc] transition-colors hover:bg-white/10"
                onClick={onSkip}
              >
                忽略此版本
              </button>
              <button
                type="button"
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-[3px] border border-[#0078d4] bg-[#0078d4] px-3.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:border-[#026ec1] hover:bg-[#026ec1]"
                onClick={() => void onInstall()}
              >
                <Download size={13} /> 下载并安装
              </button>
            </>
          )}
          {!showAvailable && (
            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-[3px] border border-[#0078d4] bg-[#0078d4] px-3.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:border-[#026ec1] hover:bg-[#026ec1] disabled:cursor-wait disabled:opacity-60"
              disabled={busy}
              onClick={() => void runCheck()}
            >
              {status === "checking" || manualMsg === "checking" ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <RefreshCw size={13} />
              )}
              检查更新
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
