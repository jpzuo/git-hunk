/** 命令面板：Ctrl+Shift+P 唤起，模糊匹配，键盘导航。 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  matchCommands,
  type CommandContext,
  type CommandRegistry,
} from "../commands/registry";

interface Props {
  open: boolean;
  registry: CommandRegistry;
  ctx: CommandContext;
  onClose: () => void;
  onError: (message: string) => void;
}

export function CommandPalette({ open, registry, ctx, onClose, onError }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(
    () => matchCommands(registry.all(), query, ctx),
    [registry, query, ctx, open],
  );

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  useEffect(() => {
    setActive((a) => (a >= matches.length ? 0 : a));
  }, [matches.length]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const run = async (id: string) => {
    onClose();
    try {
      await registry.execute(id, ctx);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (matches.length ? (a + 1) % matches.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (matches.length ? (a - 1 + matches.length) % matches.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = matches[active];
      if (m) void run(m.command.id);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[48px] bg-black/45"
      onMouseDown={onClose}
    >
      <div
        className="w-[620px] max-w-[92vw] bg-[#252526] border border-[#454545] rounded-[6px] shadow-[0_12px_36px_rgba(0,0,0,0.7)] overflow-hidden flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="p-2 border-b border-[#2b2b2b]">
          <input
            ref={inputRef}
            className="w-full bg-[#313131] text-[#cccccc] placeholder-[#868686] border border-[#3c3c3c] focus:border-[#0078d4] outline-none text-[13px] px-2.5 py-1.5 rounded-[2px]"
            placeholder="输入命令名，或直接描述你想做什么…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
          />
        </div>
        <div className="max-h-[360px] overflow-y-auto py-1" ref={listRef}>
          {matches.length === 0 && (
            <div className="py-6 text-center text-[#868686] text-[12px]">没有匹配的命令</div>
          )}
          {matches.map((m, i) => (
            <button
              key={m.command.id}
              data-index={i}
              className={`flex items-center justify-between w-full px-3 py-1.5 text-left text-[12.5px] border-none cursor-pointer transition-colors ${
                i === active
                  ? "bg-[#04395e] text-white"
                  : "bg-transparent text-[#cccccc] hover:bg-[#2a2d2e]"
              }`}
              onMouseEnter={() => setActive(i)}
              onClick={() => void run(m.command.id)}
            >
              <span className="truncate">{m.command.title}</span>
              <span className="flex items-center gap-2 shrink-0 ml-3">
                {m.command.keybindingHint && (
                  <kbd className="px-1.5 py-0.5 text-[10.5px] font-mono bg-[#181818] border border-[#3c3c3c] rounded-[3px] text-[#cccccc]">
                    {m.command.keybindingHint}
                  </kbd>
                )}
                <span className={`text-[11px] ${i === active ? "text-[#cccccc]" : "text-[#868686]"}`}>
                  {m.command.category}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
