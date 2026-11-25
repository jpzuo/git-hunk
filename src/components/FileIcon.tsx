/** 文件类型图标映射（供文件树与全局搜索面板共用）。 */

import { File, FileCode, FileText, Image as ImageIcon } from "lucide-react";

const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "go", "java", "kt",
  "c", "cpp", "h", "hpp", "cs", "html", "css", "scss", "less", "vue", "svelte",
  "json", "jsonc", "yaml", "yml", "toml", "xml", "sql", "sh", "bash", "ps1",
  "bat", "cmd", "dockerfile",
]);

export function FileTypeIcon({
  name,
  isMarkdown = false,
  isImage = false,
}: {
  name: string;
  isMarkdown?: boolean;
  isImage?: boolean;
}) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "vue") {
    return (
      <span className="font-mono text-[10px] font-extrabold text-[#42b883] w-3.5 text-center shrink-0">
        V
      </span>
    );
  }
  if (ext === "ts" || ext === "tsx") {
    return (
      <span className="font-mono text-[9.5px] font-extrabold text-[#3178c6] w-3.5 text-center shrink-0">
        TS
      </span>
    );
  }
  if (ext === "js" || ext === "jsx") {
    return (
      <span className="font-mono text-[9.5px] font-extrabold text-[#f7df1e] w-3.5 text-center shrink-0">
        JS
      </span>
    );
  }
  if (isMarkdown) return <FileText size={14} className="text-[#3794ff] shrink-0" />;
  if (isImage) return <ImageIcon size={14} className="text-[#c586c0] shrink-0" />;
  if (CODE_EXTENSIONS.has(ext)) return <FileCode size={14} className="text-[#73c991] shrink-0" />;
  return <File size={14} className="text-[#9d9d9d] shrink-0" />;
}
