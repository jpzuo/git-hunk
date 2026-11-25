/**
 * Markdown HTML 安全消毒工具：防止第三方仓库文档触发 DOM XSS。
 */

import DOMPurify from "dompurify";

/**
 * 过滤不可信 Markdown 编译生成的危险标签与事件属性（如 script/iframe/on* / javascript: URI），
 * 同时保留标准 GFM 文档排版标签（标题、代码块、表格、任务列表复选框等）。
 */
export function sanitizeMarkdownHtml(rawHtml: string): string {
  if (!rawHtml) return "";
  return DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      "style",
      "iframe",
      "object",
      "embed",
      "form",
      "textarea",
      "select",
      "button",
    ],
    FORBID_ATTR: ["style"],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
}
