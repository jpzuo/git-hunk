/**
 * 自动更新状态机 Hook：把「检查 → 下载 → 安装」的副作用集中在这里，
 * 供 App 组合到状态栏 / 提示条 / 命令面板。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { api } from "../api";
import type { UpdateInfo } from "../types";
import {
  INITIAL_DELAY_MS,
  applyProgress,
  isSkippedVersion,
  readSkipVersion,
  type UpdaterProgress,
  writeSkipVersion,
} from "./updateUtils";

export type UpdaterStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "ready"
  | "error";

export interface CheckResult {
  ok: boolean;
  /** 有新版本时的元数据。 */
  update: UpdateInfo | null;
  /** 被用户忽略（静默检查时不弹提示）。 */
  skipped?: boolean;
  error?: string;
}

export interface UseUpdater {
  status: UpdaterStatus;
  currentVersion: string | null;
  info: UpdateInfo | null;
  progress: UpdaterProgress | null;
  error: string | null;
  /** 是否展示「发现新版本」提示条。 */
  bannerVisible: boolean;
  check: (manual?: boolean) => Promise<CheckResult>;
  install: () => Promise<void>;
  /** 忽略当前版本（不再就该版本提示）。 */
  skip: () => void;
  /** 本次会话暂时关闭提示条。 */
  dismiss: () => void;
}

export function useUpdater(): UseUpdater {
  const [status, setStatus] = useState<UpdaterStatus>("idle");
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<UpdaterProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bannerVisible, setBannerVisible] = useState(false);

  // 进行中的检查/安装 Promise，避免重复触发。
  const checkInFlight = useRef<Promise<CheckResult> | null>(null);
  const installInFlight = useRef<Promise<void> | null>(null);

  useEffect(() => {
    void getVersion()
      .then(setCurrentVersion)
      .catch(() => setCurrentVersion(null));
  }, []);

  const check = useCallback(
    (manual = false): Promise<CheckResult> => {
      if (checkInFlight.current) return checkInFlight.current;

      setStatus("checking");
      setError(null);

      const task = (async (): Promise<CheckResult> => {
        try {
          const update = await api.checkUpdate();
          if (!update) {
            setStatus("idle");
            return { ok: true, update: null };
          }
          // 静默检查时：若用户已忽略该版本，则不打扰。
          if (!manual && isSkippedVersion(update.version, readSkipVersion())) {
            setStatus("idle");
            return { ok: true, update, skipped: true };
          }
          setInfo(update);
          setStatus("available");
          setBannerVisible(true);
          return { ok: true, update };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setStatus("error");
          setError(msg);
          return { ok: false, update: null, error: msg };
        } finally {
          checkInFlight.current = null;
        }
      })();

      checkInFlight.current = task;
      return task;
    },
    [],
  );

  const install = useCallback((): Promise<void> => {
    if (installInFlight.current) return installInFlight.current;

    setStatus("downloading");
    setError(null);
    setProgress({ downloaded: 0, total: null });

    const task = (async () => {
      try {
        await api.installUpdate((evt) => {
          setProgress((prev) => applyProgress(prev ?? { downloaded: 0, total: null }, evt));
          if (evt.event === "Finished") setStatus("installing");
        });
        // macOS / Linux：安装完成后由后端主动重启；若能返回则标记为就绪。
        setStatus("ready");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setStatus("error");
        setError(msg);
      } finally {
        installInFlight.current = null;
      }
    })();

    installInFlight.current = task;
    return task;
  }, []);

  const skip = useCallback(() => {
    setInfo((cur) => {
      if (cur) writeSkipVersion(cur.version);
      return cur;
    });
    setBannerVisible(false);
    setStatus("idle");
  }, []);

  const dismiss = useCallback(() => setBannerVisible(false), []);

  // 启动静默检查（仅生产构建，且只自动触发一次）。
  const autoChecked = useRef(false);
  useEffect(() => {
    if (import.meta.env.DEV) return;
    if (autoChecked.current) return;
    autoChecked.current = true;
    const timer = window.setTimeout(() => void check(false), INITIAL_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [check]);

  return {
    status,
    currentVersion,
    info,
    progress,
    error,
    bannerVisible,
    check,
    install,
    skip,
    dismiss,
  };
}
