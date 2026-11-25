import { describe, expect, it } from "vitest";
import { filterTerminalNoiseLines } from "../terminalLogFilter";
import type { ScriptLogLine } from "../../types";

function line(id: number, text: string, stream: ScriptLogLine["stream"] = "stdout"): ScriptLogLine {
  return { id, text, stream };
}

describe("filterTerminalNoiseLines", () => {
  it("filters warnings, Sass continuation blocks, and info noise while keeping errors and URLs", () => {
    const input: ScriptLogLine[] = [
      line(1, "> pnpm run dev", "system"),
      line(2, "npm warn deprecated pkg@1.0.0: old"),
      line(3, "WARNING: Sass @import rules are deprecated"),
      line(4, "  ╷"),
      line(5, "1 │ @import 'vars';"),
      line(6, "  ╵"),
      line(7, "[info] building modules..."),
      line(8, "  ➜  Local: http://localhost:8889/"),
      line(9, "ERROR: TS2304: Cannot find name 'foo'", "stderr"),
    ];

    const out = filterTerminalNoiseLines(input);
    expect(out.hiddenCount).toBe(7);
    expect(out.lines.map((l) => l.text)).toEqual([
      "  ➜  Local: http://localhost:8889/",
      "ERROR: TS2304: Cannot find name 'foo'",
    ]);
  });
});
