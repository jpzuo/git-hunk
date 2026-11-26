/**
 * 界面缩放 Hook：把缩放比例应用到当前 webview（Tauri 原生整体缩放），
 * 并持久化到 localStorage。快捷键与命令面板共用同一套方法。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  clampZoom,
  readZoom,
  stepZoom,
  writeZoom,
  ZOOM_DEFAULT,
} from "./zoomUtils";

export interface UseZoom {
  zoom: number;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
}

export function useZoom(): UseZoom {
  const [zoom, setZoom] = useState<number>(() => readZoom());
  // 用 ref 持有当前值，避免在 setState 更新函数里做副作用（StrictMode 下会被调用两次）。
  const zoomRef = useRef<number>(zoom);
  const appliedRef = useRef<number | null>(null);

  // 应用缩放比例到 webview；失败不阻塞 UI（如权限缺失或非 Tauri 环境）。
  const apply = useCallback((next: number) => {
    if (appliedRef.current === next) return;
    appliedRef.current = next;
    void getCurrentWebview()
      .setZoom(next)
      .catch((e) => console.warn("设置缩放失败:", e));
  }, []);

  const commit = useCallback(
    (next: number) => {
      const z = clampZoom(next);
      zoomRef.current = z;
      apply(z);
      writeZoom(z);
      setZoom(z);
    },
    [apply],
  );

  // 挂载时把持久化的比例应用到界面。
  useEffect(() => {
    apply(zoomRef.current);
  }, [apply]);

  const zoomIn = useCallback(() => commit(stepZoom(zoomRef.current, 1)), [commit]);
  const zoomOut = useCallback(() => commit(stepZoom(zoomRef.current, -1)), [commit]);
  const reset = useCallback(() => commit(ZOOM_DEFAULT), [commit]);

  return { zoom, zoomIn, zoomOut, reset };
}
