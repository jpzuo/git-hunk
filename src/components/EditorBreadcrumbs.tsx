/**
 * VS Code Dark Modern 风格的层级面包屑导航栏 (EditorBreadcrumbs)。
 */

import React, { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import type { EditorTab } from "../types";

interface Props {
  activeTab: EditorTab | null;
  workdir: string | null;
  onRevealInExplorer?: (path: string) => void;
  rightSlot?: React.ReactNode;
}

export const EditorBreadcrumbs = React.memo(function EditorBreadcrumbs({
  activeTab,
  workdir,
  onRevealInExplorer,
  rightSlot,
}: Props) {
  const segments = useMemo(() => {
    if (!activeTab || !activeTab.path) return [];

    const normWorkdir = (workdir || "").replace(/\\/g, "/").replace(/\/$/, "");
    const parts: { label: string; fullPath?: string; isFile?: boolean }[] = [];

    if (normWorkdir) {
      const workdirParts = normWorkdir.split("/").filter(Boolean);
      if (workdirParts.length > 0) {
        parts.push({ label: workdirParts[workdirParts.length - 1] });
      }
    }

    const relParts = activeTab.path.replace(/\\/g, "/").split("/").filter(Boolean);
    let accum = "";
    relParts.forEach((part, index) => {
      accum = accum ? `${accum}/${part}` : part;
      parts.push({
        label: part,
        fullPath: accum,
        isFile: index === relParts.length - 1,
      });
    });

    return parts;
  }, [activeTab, workdir]);

  if (!activeTab || segments.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center justify-between gap-2 min-h-[26px] px-3.5 py-0.5 bg-[#1f1f1f] text-[12px] text-[#9d9d9d] shrink-0 select-none">
      <div className="flex items-center overflow-x-auto scrollbar-none min-w-0 flex-1">
        {segments.map((seg, idx) => (
          <React.Fragment key={idx}>
            {idx > 0 && (
              <ChevronRight size={12} className="mx-1 text-[#6e7681] shrink-0" strokeWidth={1.75} />
            )}
            <span
              className={`cursor-pointer whitespace-nowrap transition-colors hover:text-white ${
                seg.isFile ? "text-[#cccccc] font-medium" : "text-[#9d9d9d]"
              }`}
              onClick={() => {
                if (seg.fullPath && onRevealInExplorer) {
                  onRevealInExplorer(seg.fullPath);
                }
              }}
              title={seg.fullPath || seg.label}
            >
              {seg.label}
            </span>
          </React.Fragment>
        ))}

        {activeTab.subtitle && (
          <span className="ml-2 text-[11px] text-[#868686] whitespace-nowrap" title={activeTab.subtitle}>
            {activeTab.subtitle}
          </span>
        )}
      </div>

      {rightSlot && (
        <div className="flex items-center gap-1 shrink-0">
          {rightSlot}
        </div>
      )}
    </div>
  );
});
