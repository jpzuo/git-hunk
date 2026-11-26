/**
 * 自动更新的纯工具函数（无 React / Tauri 依赖，便于单元测试）。
 */

import type { UpdateProgress } from "../types";

/** 用户选择「忽略此版本」时记录到 localStorage 的键。 */
export const SKIP_VERSION_KEY = "git-hunk.update-skip-version";

/** 启动后延迟多久再进行静默检查（毫秒），避免与首屏渲染争抢。 */
export const INITIAL_DELAY_MS = 4000;

export interface UpdaterProgress {
  /** 已下载字节数。 */
  downloaded: number;
  /** 总字节数（服务器未提供时为 null）。 */
  total: number | null;
}

/** 按进度事件累加下载进度。 */
export function applyProgress(
  prev: UpdaterProgress,
  evt: UpdateProgress,
): UpdaterProgress {
  switch (evt.event) {
    case "Started":
      return { downloaded: 0, total: evt.data.contentLength ?? null };
    case "Progress":
      return { downloaded: prev.downloaded + evt.data.chunkLength, total: prev.total };
    case "Finished":
      return prev;
  }
}

/** 下载百分比（0-100）；总大小未知时返回 null。 */
export function progressPercent(p: UpdaterProgress | null): number | null {
  if (!p || !p.total || p.total <= 0) return null;
  return Math.min(100, Math.round((p.downloaded / p.total) * 100));
}

/** 读取被忽略的版本号。 */
export function readSkipVersion(): string | null {
  try {
    return localStorage.getItem(SKIP_VERSION_KEY);
  } catch {
    return null;
  }
}

/** 写入 / 清除被忽略的版本号。 */
export function writeSkipVersion(version: string | null): void {
  try {
    if (version) localStorage.setItem(SKIP_VERSION_KEY, version);
    else localStorage.removeItem(SKIP_VERSION_KEY);
  } catch {
    /* 忽略 localStorage 不可用的情况 */
  }
}

/** 该版本是否已被用户忽略（静默检查时跳过）。 */
export function isSkippedVersion(version: string, skip: string | null): boolean {
  return skip !== null && skip === version;
}
