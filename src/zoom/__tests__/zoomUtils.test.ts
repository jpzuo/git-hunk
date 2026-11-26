// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  clampZoom,
  stepZoom,
  formatZoom,
  isDefaultZoom,
  readZoom,
  writeZoom,
  ZOOM_STORAGE_KEY,
  ZOOM_DEFAULT,
  ZOOM_MIN,
  ZOOM_MAX,
} from "../zoomUtils";

describe("clampZoom", () => {
  it("夹紧到上下限", () => {
    expect(clampZoom(5)).toBe(ZOOM_MAX);
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
  });
  it("消除浮点漂移", () => {
    expect(clampZoom(0.7 + 0.1)).toBe(0.8);
    expect(clampZoom(1.0000001)).toBe(1);
  });
  it("非有限数回落默认值", () => {
    expect(clampZoom(NaN)).toBe(ZOOM_DEFAULT);
    expect(clampZoom(Infinity)).toBe(ZOOM_MAX);
  });
});

describe("stepZoom", () => {
  it("逐级加减", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1.1, -1)).toBe(1);
  });
  it("边界不越界", () => {
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
  });
  it("1.0 附近多次步进无漂移（关键回归）", () => {
    let z = 1;
    for (let i = 0; i < 3; i++) z = stepZoom(z, 1);
    expect(z).toBe(1.3);
    for (let i = 0; i < 3; i++) z = stepZoom(z, -1);
    expect(z).toBe(1);
  });
});

describe("formatZoom / isDefaultZoom", () => {
  it("百分比格式", () => {
    expect(formatZoom(1)).toBe("100%");
    expect(formatZoom(1.2)).toBe("120%");
    expect(formatZoom(0.5)).toBe("50%");
  });
  it("默认值判定", () => {
    expect(isDefaultZoom(1)).toBe(true);
    expect(isDefaultZoom(1.1)).toBe(false);
  });
});

describe("readZoom / writeZoom", () => {
  beforeEach(() => localStorage.clear());

  it("写入后可读回", () => {
    writeZoom(1.4);
    expect(readZoom()).toBe(1.4);
  });

  it("默认值不落盘", () => {
    writeZoom(1.5);
    writeZoom(1);
    expect(localStorage.getItem(ZOOM_STORAGE_KEY)).toBeNull();
    expect(readZoom()).toBe(ZOOM_DEFAULT);
  });

  it("非法存储值回落 100%", () => {
    localStorage.setItem(ZOOM_STORAGE_KEY, "abc");
    expect(readZoom()).toBe(ZOOM_DEFAULT);
    localStorage.setItem(ZOOM_STORAGE_KEY, "999");
    expect(readZoom()).toBe(ZOOM_MAX);
  });
});
