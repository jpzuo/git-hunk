/**
 * 命令注册框架。
 *
 * 设计目标：让「所有操作都可通过命令面板触达」这条原则在架构层成立 ——
 * 任何功能（Git / Diff / 脚本 / 导航）只需注册一个 Command，就自动获得
 * 命令面板入口、快捷键与可发现的元数据。
 */

import type { ReactNode } from "react";

export interface CommandContext {
  /** 当前打开的仓库（未打开时为 null）。 */
  repoPath: string | null;
  /** 当前是否有进行中的变更。 */
  hasChanges: boolean;
  /** 由 App 注入：刷新状态的统一入口。 */
  refresh: () => Promise<void>;
  /** 由 App 注入：打开某个文件的 diff。 */
  openDiff: (path: string) => void;
  /** 由 App 注入：提交信息草稿读写。 */
  getCommitMessage: () => string;
  setCommitMessage: (v: string) => void;
  /** 由 App 注入：切换左侧导航视图。 */
  showView: (view: "files" | "search" | "changes" | "history" | "stash" | "scripts") => void;
  /** 由 App 注入：打开全局文件内容搜索并聚焦输入框。 */
  openGlobalSearch?: () => void;
  /** 由 App 注入：重新加载提交历史。 */
  reloadHistory: () => Promise<void>;
  /** 由 App 注入：打开分支快速切换/管理弹窗。 */
  openBranchQuickPick?: () => void;
  /** 由 App 注入：打开标签管理弹窗/浮层。 */
  openTagManager?: () => void;
  /** 由 App 注入：打开新建标签弹窗。 */
  openCreateTagDialog?: (oid?: string) => void;
  /** 由 App 注入：弹出 Toast 通知。 */
  showToast?: (kind: "info" | "error", text: string) => void;
  /** 由 App 注入：聚焦提交信息输入框。 */
  focusCommitInput?: () => void;
  /** 由 App 注入：打开新工作区。 */
  openWorkspaceDialog?: () => void;
  /** 由 App 注入：关闭当前工作区。 */
  closeCurrentWorkspace?: () => void;
  /** 由 App 注入：切换至下一个工作区。 */
  nextWorkspace?: () => void;
  /** 由 App 注入：切换至上一个工作区。 */
  prevWorkspace?: () => void;
  /** 由 App 注入：打开仓库与项目分组管理中心。 */
  openCatalogPanel?: () => void;
  /** 由 App 注入：关闭其他工作区。 */
  closeOtherWorkspaces?: () => void;
  /** 由 App 注入：打开「关于 / 检查更新」弹窗。 */
  openUpdaterDialog?: () => void;
}

export interface Command {
  /** 唯一标识，例如 `git.stageAll`。 */
  id: string;
  /** 命令面板中显示的名称。 */
  title: string;
  /** 分组，用于命令面板分类展示（例如 "Git"、"View"、"Terminal"）。 */
  category: string;
  /** 额外搜索关键词（别名），提升模糊匹配命中率。 */
  keywords?: string[];
  /** 展示用快捷键文本，例如 "Ctrl+Shift+P"。 */
  keybindingHint?: string;
  /** 是否在当前上下文可用；返回 false 时置灰。 */
  enabled?: (ctx: CommandContext) => boolean;
  /** 执行逻辑。 */
  run: (ctx: CommandContext) => void | Promise<void>;
}

export class CommandRegistry {
  private commands = new Map<string, Command>();
  private listeners = new Set<() => void>();

  register(...commands: Command[]): void {
    for (const cmd of commands) {
      if (this.commands.has(cmd.id)) {
        // 重复注册直接覆盖，便于插件式扩展与 HMR
        this.commands.delete(cmd.id);
      }
      this.commands.set(cmd.id, cmd);
    }
    this.emit();
  }

  unregister(id: string): void {
    if (this.commands.delete(id)) this.emit();
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  all(): Command[] {
    return [...this.commands.values()];
  }

  async execute(id: string, ctx: CommandContext): Promise<void> {
    const cmd = this.commands.get(id);
    if (!cmd) throw new Error(`unknown command: ${id}`);
    if (cmd.enabled && !cmd.enabled(ctx)) {
      throw new Error(`command not available in current context: ${id}`);
    }
    await cmd.run(ctx);
  }

  /** 订阅变更，供 UI 重新渲染。返回取消订阅函数。 */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

/** 简单模糊匹配：按字符顺序命中，连续命中与开头命中加权。 */
export function fuzzyScore(query: string, target: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // 直接子串命中优先级最高
  const idx = t.indexOf(q);
  if (idx >= 0) {
    return 1000 - idx + (idx === 0 ? 100 : 0);
  }

  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      streak += 1;
      score += 10 + streak * 2;
      qi += 1;
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? score : 0;
}

export interface CommandMatch {
  command: Command;
  score: number;
}

/** 按查询串过滤并排序命令。 */
export function matchCommands(
  commands: Command[],
  query: string,
  ctx: CommandContext,
): CommandMatch[] {
  const trimmed = query.trim();
  const cleanQuery = trimmed.startsWith(">") ? trimmed.slice(1).trimStart() : trimmed;

  const results: CommandMatch[] = [];
  for (const cmd of commands) {
    if (cmd.enabled && !cmd.enabled(ctx)) continue;
    const haystacks = [cmd.title, cmd.category, ...(cmd.keywords ?? [])];
    let best = 0;
    for (const h of haystacks) {
      best = Math.max(best, fuzzyScore(cleanQuery, h));
    }
    if (best > 0) results.push({ command: cmd, score: best });
  }
  results.sort((a, b) => b.score - a.score || a.command.title.localeCompare(b.command.title));
  return results;
}

export type { ReactNode };