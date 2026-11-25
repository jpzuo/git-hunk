import { describe, expect, it } from "vitest";
import { parseAnsiLine } from "../ansi";

describe("parseAnsiLine", () => {
  it("keeps split Vite URL and bold port as a single clickable link", () => {
    const line = "  \x1b[32m➜\x1b[39m  Local:   \x1b[36mhttp://localhost:\x1b[1m8889\x1b[22m/\x1b[39m";
    const segs = parseAnsiLine(line);
    const linked = segs.filter((s) => s.url === "http://localhost:8889/");
    expect(linked.map((s) => s.text).join("")).toBe("http://localhost:8889/");
    expect(linked.some((s) => s.style.bold)).toBe(true);
  });

  it("strips trailing punctuation from detected URLs", () => {
    const segs = parseAnsiLine("See (https://example.com/docs?a=1).");
    const urlSeg = segs.find((s) => s.url);
    expect(urlSeg?.url).toBe("https://example.com/docs?a=1");
  });
});
