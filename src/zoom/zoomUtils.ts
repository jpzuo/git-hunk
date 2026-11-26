/**
 * 界面缩放的纯函数（无 React / Tauri 依赖，便于单元测试）。
 *
 * 采用 Tauri 原生 webview 缩放（整体等比），步进 10%，范围 50%–300%，
 * 与 VS Code 的窗口缩放行为一致。
 */

export const ZOOM_DEFAULT = 1;
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
export const ZOOM_STEP = 0.1;
export const ZOOM_STORAGE_KEY = "git-hunk.zoom-level";

/** 归整到 10% 的倍数并消除浮点漂移（0.1 + 0.2 之类）。 */
function roundToStep(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 夹紧到 [ZOOM_MIN, ZOOM_MAX]，并归整到两位小数。 */
export function clampZoom(v: number): number {
  if (Number.isNaN(v)) return ZOOM_DEFAULT;
  return roundToStep(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v)));
}

/** 按 10% 逐级步进并夹紧。 */
export function stepZoom(current: number, direction: 1 | -1): number {
  const base = Number.isFinite(current) ? clampZoom(current) : ZOOM_DEFAULT;
  return clampZoom(base + direction * ZOOM_STEP);
}

/** 格式化为百分比文本，如 1.2 → "120%"。 */
export function formatZoom(v: number): string {
  return `${Math.round(clampZoom(v) * 100)}%`;
}

/** 是否为默认 100%。 */
export function isDefaultZoom(v: number): boolean {
  return Math.abs(clampZoom(v) - ZOOM_DEFAULT) < 1e-9;
}

/** 读取持久化的缩放比例；缺失或非法时回落 100%。 */
export function readZoom(): number {
  try {
    const raw = localStorage.getItem(ZOOM_STORAGE_KEY);
    if (!raw) return ZOOM_DEFAULT;
    const v = Number(raw);
    if (!Number.isFinite(v)) return ZOOM_DEFAULT;
    return clampZoom(v);
  } catch {
    return ZOOM_DEFAULT;
  }
}

/** 写入缩放比例（默认值会被清除，保持存储干净）。 */
export function writeZoom(v: number): void {
  try {
    const z = clampZoom(v);
    if (isDefaultZoom(z)) localStorage.removeItem(ZOOM_STORAGE_KEY);
    else localStorage.setItem(ZOOM_STORAGE_KEY, String(z));
  } catch {
    /* localStorage 不可用时静默忽略 */
  }
}
