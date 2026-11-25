// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeMarkdownHtml } from "../sanitizeHtml";

describe("sanitizeMarkdownHtml", () => {
  it("strips dangerous XSS vectors while preserving safe GFM markdown markup", () => {
    const dirty = [
      "<h1>Title</h1>",
      "<script>alert(1)</script>",
      '<img src="x" onerror="alert(2)">',
      '<a href="javascript:alert(3)">evil</a>',
      '<a href="https://example.com">safe</a>',
      "<pre><code>const x = 1;</code></pre>",
      '<ul><li><input type="checkbox" disabled checked> task</li></ul>',
    ].join("\n");

    const clean = sanitizeMarkdownHtml(dirty);
    expect(clean).not.toContain("<script");
    expect(clean).not.toContain("onerror");
    expect(clean).not.toContain("javascript:");
    expect(clean).toContain("<h1>Title</h1>");
    expect(clean).toContain('href="https://example.com"');
    expect(clean).toContain("<code>const x = 1;</code>");
    expect(clean).toContain('type="checkbox"');
  });
});
