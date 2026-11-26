// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  applyProgress,
  progressPercent,
  isSkippedVersion,
  readSkipVersion,
  writeSkipVersion,
  SKIP_VERSION_KEY,
  type UpdaterProgress,
} from "../updateUtils";

describe("applyProgress", () => {
  it("Started 重置并记录总大小", () => {
    const p = applyProgress({ downloaded: 999, total: 1 }, {
      event: "Started",
      data: { contentLength: 2048 },
    });
    expect(p).toEqual({ downloaded: 0, total: 2048 });
  });

  it("Started 无总大小时 total 为 null", () => {
    const p = applyProgress({ downloaded: 0, total: null }, {
      event: "Started",
      data: { contentLength: null },
    });
    expect(p.total).toBeNull();
  });

  it("Progress 累加 chunkLength", () => {
    let p: UpdaterProgress = { downloaded: 0, total: 1000 };
    p = applyProgress(p, { event: "Progress", data: { chunkLength: 200 } });
    p = applyProgress(p, { event: "Progress", data: { chunkLength: 300 } });
    expect(p).toEqual({ downloaded: 500, total: 1000 });
  });

  it("Finished 不改动进度", () => {
    const before = { downloaded: 1000, total: 1000 };
    expect(applyProgress(before, { event: "Finished" })).toEqual(before);
  });
});

describe("progressPercent", () => {
  it("已知总大小时返回四舍五入百分比", () => {
    expect(progressPercent({ downloaded: 25, total: 100 })).toBe(25);
    expect(progressPercent({ downloaded: 1, total: 3 })).toBe(33);
  });

  it("总大小未知或为 0 时返回 null", () => {
    expect(progressPercent({ downloaded: 10, total: null })).toBeNull();
    expect(progressPercent({ downloaded: 10, total: 0 })).toBeNull();
    expect(progressPercent(null)).toBeNull();
  });

  it("完成度封顶 100", () => {
    expect(progressPercent({ downloaded: 200, total: 100 })).toBe(100);
  });
});

describe("skip version persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("写入后可读回，清除后为空", () => {
    writeSkipVersion("0.3.0");
    expect(localStorage.getItem(SKIP_VERSION_KEY)).toBe("0.3.0");
    expect(readSkipVersion()).toBe("0.3.0");
    writeSkipVersion(null);
    expect(readSkipVersion()).toBeNull();
  });
});

describe("isSkippedVersion", () => {
  it("版本号一致才算忽略", () => {
    expect(isSkippedVersion("0.3.0", "0.3.0")).toBe(true);
    expect(isSkippedVersion("0.3.0", "0.2.0")).toBe(false);
    expect(isSkippedVersion("0.3.0", null)).toBe(false);
  });
});
