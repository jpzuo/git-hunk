/**
 * 内置命令定义 —— 100% 对齐 VS Code Git 命令规范，并在英文指令后附带精准中文翻译。
 * 按类别分组，统一通过 registry 注册，支持中英文双语搜索及智能别名匹配。
 */

import { api } from "../api";
import type { Command, CommandContext } from "./registry";

export function buildCommands(): Command[] {
  const requireRepo = (ctx: CommandContext) => ctx.repoPath !== null;
  const requireChanges = (ctx: CommandContext) =>
    ctx.repoPath !== null && ctx.hasChanges;

  return [
    // -------------------------------------------------------------------------
    // 1. Git: 提交 (Commit) —— 完全对齐 VS Code
    // -------------------------------------------------------------------------
    {
      id: "git.commit",
      title: "Git: Commit (提交)",
      category: "Git",
      keywords: ["commit", "ci", "提交", "提交已暂存", "commit staged"],
      keybindingHint: "Ctrl+Enter",
      enabled: requireRepo,
      run: async (ctx) => {
        const msg = ctx.getCommitMessage().trim();
        if (!msg) {
          ctx.showView("changes");
          ctx.focusCommitInput?.();
          ctx.showToast?.("info", "请输入提交信息后再执行提交");
          return;
        }
        await api.commit(msg);
        ctx.setCommitMessage("");
        await ctx.refresh();
        await ctx.reloadHistory();
        ctx.showToast?.("info", "已成功提交更改");
      },
    },
    {
      id: "git.commitStaged",
      title: "Git: Commit Staged (提交已暂存)",
      category: "Git",
      keywords: ["commit staged", "提交暂存", "提交暂存区"],
      enabled: requireRepo,
      run: async (ctx) => {
        const msg = ctx.getCommitMessage().trim();
        if (!msg) {
          ctx.showView("changes");
          ctx.focusCommitInput?.();
          ctx.showToast?.("info", "请输入提交信息");
          return;
        }
        await api.commit(msg);
        ctx.setCommitMessage("");
        await ctx.refresh();
        await ctx.reloadHistory();
        ctx.showToast?.("info", "已提交已暂存的更改");
      },
    },
    {
      id: "git.commitAmend",
      title: "Git: Commit (Amend) (修改上一次提交)",
      category: "Git",
      keywords: ["amend", "commit amend", "修改上一次提交", "重写提交"],
      enabled: requireRepo,
      run: async (ctx) => {
        const msg = ctx.getCommitMessage().trim();
        if (!msg) {
          ctx.showView("changes");
          ctx.focusCommitInput?.();
          ctx.showToast?.("info", "请输入修改后的提交信息");
          return;
        }
        await api.amend(msg);
        ctx.setCommitMessage("");
        await ctx.refresh();
        await ctx.reloadHistory();
        ctx.showToast?.("info", "已成功修改上一次提交 (Amend)");
      },
    },
    {
      id: "git.commitStagedAmend",
      title: "Git: Commit Staged (Amend) (修改已暂存提交)",
      category: "Git",
      keywords: ["commit staged amend", "修改已暂存提交", "暂存amend"],
      enabled: requireRepo,
      run: async (ctx) => {
        const msg = ctx.getCommitMessage().trim();
        if (!msg) {
          ctx.showView("changes");
          ctx.focusCommitInput?.();
          ctx.showToast?.("info", "请输入修改后的提交信息");
          return;
        }
        await api.amend(msg);
        ctx.setCommitMessage("");
        await ctx.refresh();
        await ctx.reloadHistory();
        ctx.showToast?.("info", "已修改已暂存的提交 (Amend)");
      },
    },
    {
      id: "git.commitAll",
      title: "Git: Commit All (全部提交)",
      category: "Git",
      keywords: ["commit all", "全部提交", "暂存并提交", "提交所有"],
      enabled: requireChanges,
      run: async (ctx) => {
        const msg = ctx.getCommitMessage().trim();
        if (!msg) {
          ctx.showView("changes");
          ctx.focusCommitInput?.();
          ctx.showToast?.("info", "请输入提交信息");
          return;
        }
        const status = await api.status();
        for (const f of status.unstaged) await api.stageFile(f.path);
        for (const f of status.untracked) await api.stageFile(f.path);
        await api.commit(msg);
        ctx.setCommitMessage("");
        await ctx.refresh();
        await ctx.reloadHistory();
        ctx.showToast?.("info", "已暂存所有文件并完成提交");
      },
    },
    {
      id: "git.commitAllAmend",
      title: "Git: Commit All (Amend) (全部修改提交)",
      category: "Git",
      keywords: ["commit all amend", "全部修改提交", "全部amend"],
      enabled: requireRepo,
      run: async (ctx) => {
        const msg = ctx.getCommitMessage().trim();
        if (!msg) {
          ctx.showView("changes");
          ctx.focusCommitInput?.();
          ctx.showToast?.("info", "请输入修改后的提交信息");
          return;
        }
        const status = await api.status();
        for (const f of status.unstaged) await api.stageFile(f.path);
        for (const f of status.untracked) await api.stageFile(f.path);
        await api.amend(msg);
        ctx.setCommitMessage("");
        await ctx.refresh();
        await ctx.reloadHistory();
        ctx.showToast?.("info", "已暂存所有改动并修改提交 (Amend All)");
      },
    },
    {
      id: "git.undoCommit",
      title: "Git: Undo Last Commit (撤消上次提交)",
      category: "Git",
      keywords: [
        "undo last commit",
        "undo commit",
        "撤消上次提交",
        "撤销提交",
        "reset soft",
        "head~1",
      ],
      enabled: requireRepo,
      run: async (ctx) => {
        await api.undoCommit();
        await ctx.refresh();
        await ctx.reloadHistory();
        ctx.showView("changes");
        ctx.showToast?.(
          "info",
          "已撤消上次提交 (保留所有代码并退回暂存区)",
        );
      },
    },

    // -------------------------------------------------------------------------
    // 2. Git: 暂存与取消暂存 (Stage / Unstage / Discard)
    // -------------------------------------------------------------------------
    {
      id: "git.stageAll",
      title: "Git: Stage All Changes (暂存所有更改)",
      category: "Git",
      keywords: ["stage all", "add all", "git add .", "暂存所有更改", "全部暂存"],
      enabled: requireChanges,
      run: async (ctx) => {
        const status = await api.status();
        for (const f of status.unstaged) await api.stageFile(f.path);
        for (const f of status.untracked) await api.stageFile(f.path);
        await ctx.refresh();
        ctx.showToast?.("info", "已暂存所有更改");
      },
    },
    {
      id: "git.stageAllTracked",
      title: "Git: Stage All Tracked Changes (暂存所有已跟踪文件)",
      category: "Git",
      keywords: ["stage tracked", "暂存已跟踪", "暂存已跟踪文件"],
      enabled: requireChanges,
      run: async (ctx) => {
        const status = await api.status();
        for (const f of status.unstaged) await api.stageFile(f.path);
        await ctx.refresh();
        ctx.showToast?.("info", "已暂存已跟踪文件的更改");
      },
    },
    {
      id: "git.stageAllUntracked",
      title: "Git: Stage All Untracked Changes (暂存所有未跟踪新文件)",
      category: "Git",
      keywords: ["stage untracked", "暂存未跟踪", "暂存新文件"],
      enabled: requireChanges,
      run: async (ctx) => {
        const status = await api.status();
        for (const f of status.untracked) await api.stageFile(f.path);
        await ctx.refresh();
        ctx.showToast?.("info", "已暂存未跟踪的新文件");
      },
    },
    {
      id: "git.unstageAll",
      title: "Git: Unstage All Changes (取消暂存所有更改)",
      category: "Git",
      keywords: ["unstage all", "reset", "取消暂存所有更改", "全部取消暂存"],
      enabled: requireRepo,
      run: async (ctx) => {
        const status = await api.status();
        for (const f of status.staged) await api.unstageFile(f.path);
        await ctx.refresh();
        ctx.showToast?.("info", "已取消暂存所有更改");
      },
    },
    {
      id: "git.cleanAll",
      title: "Git: Discard All Changes (放弃所有更改)",
      category: "Git",
      keywords: [
        "discard all changes",
        "clean all",
        "放弃所有更改",
        "丢弃所有改动",
        "恢复工作区",
      ],
      enabled: requireChanges,
      run: async (ctx) => {
        await api.discardAllChanges();
        await ctx.refresh();
        ctx.showToast?.("info", "已放弃工作区所有更改并清理未跟踪文件");
      },
    },
    {
      id: "git.cleanUntracked",
      title: "Git: Clean (Discard All Untracked) (清理所有未跟踪文件)",
      category: "Git",
      keywords: ["clean untracked", "清理未跟踪", "删除新文件", "git clean"],
      enabled: requireChanges,
      run: async (ctx) => {
        await api.cleanUntracked();
        await ctx.refresh();
        ctx.showToast?.("info", "已清理所有未跟踪文件");
      },
    },
    {
      id: "git.mergeAbort",
      title: "Git: Merge (Abort) (中止合并)",
      category: "Git",
      keywords: ["merge abort", "abort merge", "中止合并", "取消合并", "git merge --abort"],
      enabled: requireRepo,
      run: async (ctx) => {
        const res = await api.abortMerge();
        await ctx.refresh();
        await ctx.reloadHistory();
        ctx.showToast?.("info", res.stdout.trim() || "已中止当前合并并恢复状态");
      },
    },
    {
      id: "git.rebaseAbort",
      title: "Git: Rebase (Abort) (中止变基)",
      category: "Git",
      keywords: ["rebase abort", "abort rebase", "中止变基", "取消变基", "git rebase --abort"],
      enabled: requireRepo,
      run: async (ctx) => {
        const res = await api.abortRebase();
        await ctx.refresh();
        await ctx.reloadHistory();
        ctx.showToast?.("info", res.stdout.trim() || "已中止当前变基并恢复状态");
      },
    },
    {
      id: "git.cherryPickAbort",
      title: "Git: Cherry Pick (Abort) (中止拣选)",
      category: "Git",
      keywords: ["cherry pick abort", "abort cherry pick", "中止拣选", "取消拣选", "git cherry-pick --abort"],
      enabled: requireRepo,
      run: async (ctx) => {
        const res = await api.abortCherryPick();
        await ctx.refresh();
        await ctx.reloadHistory();
        ctx.showToast?.("info", res.stdout.trim() || "已中止当前拣选并恢复状态");
      },
    },

    // -------------------------------------------------------------------------
    // 3. Git: 分支 (Branch) —— 完全对齐 VS Code
    // -------------------------------------------------------------------------
    {
      id: "git.checkout",
      title: "Git: Checkout to... (检出到...)",
      category: "Git",
      keywords: ["checkout", "switch", "检出到", "切换分支", "分支切换"],
      enabled: requireRepo,
      run: (ctx) => {
        ctx.openBranchQuickPick?.();
      },
    },
    {
      id: "git.branch",
      title: "Git: Create Branch... (创建分支...)",
      category: "Git",
      keywords: ["create branch", "new branch", "新建分支", "创建分支"],
      enabled: requireRepo,
      run: (ctx) => {
        ctx.openBranchQuickPick?.();
      },
    },
    {
      id: "git.deleteBranch",
      title: "Git: Delete Branch... (删除分支...)",
      category: "Git",
      keywords: ["delete branch", "删除分支", "移除分支"],
      enabled: requireRepo,
      run: (ctx) => {
        ctx.openBranchQuickPick?.();
      },
    },
    {
      id: "git.renameBranch",
      title: "Git: Rename Branch... (重命名分支...)",
      category: "Git",
      keywords: ["rename branch", "重命名分支", "修改分支名"],
      enabled: requireRepo,
      run: (ctx) => {
        ctx.openBranchQuickPick?.();
      },
    },

    // -------------------------------------------------------------------------
    // 4. Git: 远端网络同步 (Pull / Push / Fetch)
    // -------------------------------------------------------------------------
    {
      id: "git.pull",
      title: "Git: Pull (拉取)",
      category: "Git",
      keywords: ["pull", "拉取", "更新", "git pull"],
      enabled: requireRepo,
      run: async (ctx) => {
        await api.pull();
        await ctx.reloadHistory();
        await ctx.refresh();
        ctx.showToast?.("info", "已完成拉取 (Pull)");
      },
    },
    {
      id: "git.pullRebase",
      title: "Git: Pull (Rebase) (变基拉取)",
      category: "Git",
      keywords: ["pull rebase", "拉取变基", "变基拉取", "pull --rebase"],
      enabled: requireRepo,
      run: async (ctx) => {
        await api.pull(undefined, undefined, true);
        await ctx.reloadHistory();
        await ctx.refresh();
        ctx.showToast?.("info", "已完成变基拉取 (Pull --rebase)");
      },
    },
    {
      id: "git.push",
      title: "Git: Push (推送)",
      category: "Git",
      keywords: ["push", "推送", "上传代码", "git push"],
      enabled: requireRepo,
      run: async (ctx) => {
        await api.push(undefined, undefined, true);
        await ctx.reloadHistory();
        await ctx.refresh();
        ctx.showToast?.("info", "已完成推送 (Push)");
      },
    },
    {
      id: "git.pushForce",
      title: "Git: Push (Force) (强制推送)",
      category: "Git",
      keywords: [
        "push force",
        "强制推送",
        "force with lease",
        "git push -f",
      ],
      enabled: requireRepo,
      run: async (ctx) => {
        await api.push(undefined, undefined, true, true);
        await ctx.reloadHistory();
        await ctx.refresh();
        ctx.showToast?.("info", "已完成强制推送 (Push --force-with-lease)");
      },
    },
    {
      id: "git.pushTags",
      title: "Git: Push Tags (推送所有标签)",
      category: "Git",
      keywords: ["push tags", "推送标签", "推送所有标签", "git push --tags"],
      enabled: requireRepo,
      run: async (ctx) => {
        await api.pushAllTags();
        ctx.showToast?.("info", "已推送所有本地标签至远端");
      },
    },
    {
      id: "git.fetch",
      title: "Git: Fetch (提取)",
      category: "Git",
      keywords: ["fetch", "提取", "提取远端", "拉取元数据"],
      enabled: requireRepo,
      run: async (ctx) => {
        await api.fetch();
        await ctx.reloadHistory();
        await ctx.refresh();
        ctx.showToast?.("info", "已获取远端最新状态 (Fetch)");
      },
    },
    {
      id: "git.fetchPrune",
      title: "Git: Fetch (Prune) (提取并修剪)",
      category: "Git",
      keywords: ["fetch prune", "提取并修剪", "清理远端失效分支", "fetch --prune"],
      enabled: requireRepo,
      run: async (ctx) => {
        await api.fetch();
        await ctx.reloadHistory();
        await ctx.refresh();
        ctx.showToast?.("info", "已提取并修剪远程分支 (Fetch --prune)");
      },
    },
    {
      id: "git.fetchAll",
      title: "Git: Fetch From All Remotes (从所有远端提取)",
      category: "Git",
      keywords: ["fetch all", "从所有远端提取", "获取所有远端"],
      enabled: requireRepo,
      run: async (ctx) => {
        await api.fetch();
        await ctx.reloadHistory();
        await ctx.refresh();
        ctx.showToast?.("info", "已从所有远程仓库获取更新");
      },
    },

    // -------------------------------------------------------------------------
    // 5. Git: Stash 储藏 —— 完全对齐 VS Code
    // -------------------------------------------------------------------------
    {
      id: "git.stash",
      title: "Git: Stash (储藏)",
      category: "Git",
      keywords: ["stash", "储藏", "保存工作区", "git stash"],
      enabled: requireChanges,
      run: async (ctx) => {
        await api.stashSave("stashed from command palette", true, false);
        await ctx.refresh();
        ctx.showToast?.("info", "已储藏工作区变更 (Stash)");
      },
    },
    {
      id: "git.stashIncludeUntracked",
      title: "Git: Stash (Include Untracked) (储藏包含未跟踪文件)",
      category: "Git",
      keywords: [
        "stash include untracked",
        "储藏包括未跟踪",
        "包含未跟踪",
        "stash -u",
      ],
      enabled: requireChanges,
      run: async (ctx) => {
        await api.stashSave("stashed from command palette", true, false);
        await ctx.refresh();
        ctx.showToast?.("info", "已储藏所有更改（包含未跟踪文件）");
      },
    },
    {
      id: "git.stashKeepIndex",
      title: "Git: Stash (Keep Index) (储藏但保留暂存区)",
      category: "Git",
      keywords: ["stash keep index", "储藏保留暂存", "保留暂存区", "keep-index"],
      enabled: requireChanges,
      run: async (ctx) => {
        await api.stashSave("stashed from command palette", true, true);
        await ctx.refresh();
        ctx.showToast?.("info", "已储藏工作区变更并保留暂存区 (Keep Index)");
      },
    },
    {
      id: "git.stashPop",
      title: "Git: Stash Pop (弹出最新储藏)",
      category: "Git",
      keywords: ["stash pop", "弹出储藏", "恢复储藏", "应用并丢弃储藏"],
      enabled: requireRepo,
      run: async (ctx) => {
        await api.stashPop(0);
        await ctx.refresh();
        ctx.showToast?.("info", "已弹出最新的储藏记录 (Pop)");
      },
    },
    {
      id: "git.stashPopLatest",
      title: "Git: Stash Pop Latest (弹出最新储藏)",
      category: "Git",
      keywords: ["stash pop latest", "弹出最新储藏", "恢复最新"],
      enabled: requireRepo,
      run: async (ctx) => {
        await api.stashPop(0);
        await ctx.refresh();
        ctx.showToast?.("info", "已弹出最新的储藏记录 (Pop)");
      },
    },
    {
      id: "git.stashApplyLatest",
      title: "Git: Stash Apply Latest (应用最新储藏)",
      category: "Git",
      keywords: ["stash apply latest", "应用最新储藏", "apply stash"],
      enabled: requireRepo,
      run: async (ctx) => {
        await api.stashApply(0);
        await ctx.refresh();
        ctx.showToast?.("info", "已应用最新储藏记录 (保留在栈中)");
      },
    },
    {
      id: "git.stashDropAll",
      title: "Git: Stash Drop All (清空所有储藏)",
      category: "Git",
      keywords: ["stash drop all", "stash clear", "清空所有储藏", "删除所有储藏"],
      enabled: requireRepo,
      run: async (ctx) => {
        await api.stashClear();
        await ctx.refresh();
        ctx.showToast?.("info", "已清空所有 Stash 储藏记录");
      },
    },
    {
      id: "git.stashView",
      title: "Git: Stash View (查看储藏列表)",
      category: "Git",
      keywords: ["stash view", "查看储藏", "stash list", "储藏列表"],
      enabled: requireRepo,
      run: (ctx) => {
        ctx.showView("stash");
      },
    },

    // -------------------------------------------------------------------------
    // 6. Git: 标签 (Tag) —— 完全对齐 VS Code
    // -------------------------------------------------------------------------
    {
      id: "git.createTag",
      title: "Git: Create Tag (创建标签)",
      category: "Git",
      keywords: ["create tag", "tag", "新建标签", "创建标签", "打标"],
      enabled: requireRepo,
      run: (ctx) => {
        if (ctx.openCreateTagDialog) {
          ctx.openCreateTagDialog();
        } else {
          ctx.openTagManager?.();
        }
      },
    },
    {
      id: "git.deleteTag",
      title: "Git: Delete Tag... (删除标签...)",
      category: "Git",
      keywords: ["delete tag", "删除标签", "移除标签"],
      enabled: requireRepo,
      run: (ctx) => {
        ctx.openTagManager?.();
      },
    },

    // -------------------------------------------------------------------------
    // 7. Git: 视图与全局操作 (View & Global)
    // -------------------------------------------------------------------------
    {
      id: "git.revealInSideBar",
      title: "Git: Focus on Source Control View (聚焦到工作区)",
      category: "Git",
      keywords: ["source control", "changes", "变更", "暂存", "工作区", "源代码管理"],
      keybindingHint: "Ctrl+Shift+G",
      enabled: requireRepo,
      run: (ctx) => {
        ctx.showView("changes");
      },
    },
    {
      id: "git.viewHistory",
      title: "Git: View Commit Graph (History) (查看提交历史图)",
      category: "Git",
      keywords: ["history", "graph", "commit graph", "提交历史", "拓扑图", "关系图"],
      enabled: requireRepo,
      run: (ctx) => {
        ctx.showView("history");
      },
    },
    {
      id: "git.viewFiles",
      title: "View: Show File Explorer (查看文件目录)",
      category: "View",
      keywords: ["files", "explorer", "file tree", "文件目录", "资源管理器", "浏览文件", "预览"],
      enabled: requireRepo,
      run: (ctx) => {
        ctx.showView("files");
      },
    },
    {
      id: "view.searchFiles",
      title: "View: Search in Files (全局搜索文件内容)",
      category: "View",
      keywords: ["search", "find", "grep", "global search", "全局搜索", "查找内容", "正则表达式"],
      keybindingHint: "Ctrl+Shift+F",
      enabled: requireRepo,
      run: (ctx) => {
        if (ctx.openGlobalSearch) {
          ctx.openGlobalSearch();
        } else {
          ctx.showView("search");
        }
      },
    },
    {
      id: "view.findInFile",
      title: "View: Find in Active File (在当前文件/对比中查找)",
      category: "View",
      keywords: ["find", "search", "in file", "查找", "文件内搜索", "正则表达式"],
      keybindingHint: "Ctrl+F",
      enabled: requireRepo,
      run: () => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "f",
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
    },
    {
      id: "view.scripts",
      title: "View: Show Project Scripts (查看并运行项目脚本)",
      category: "View",
      keywords: ["scripts", "tasks", "run", "pnpm", "npm", "cargo", "脚本", "任务", "启动服务"],
      enabled: requireRepo,
      run: (ctx) => {
        ctx.showView("scripts");
      },
    },
    {
      id: "git.viewBranches",
      title: "Git: Manage Branches (打开分支切换与管理)",
      category: "Git",
      keywords: ["branches", "分支管理", "分支列表", "切换分支"],
      enabled: requireRepo,
      run: (ctx) => {
        ctx.openBranchQuickPick?.();
      },
    },
    {
      id: "git.viewTags",
      title: "Git: Manage Tags (打开标签管理)",
      category: "Git",
      keywords: ["tags", "标签管理", "标签列表"],
      enabled: requireRepo,
      run: (ctx) => {
        ctx.openTagManager?.();
      },
    },
    {
      id: "git.refresh",
      title: "Git: Refresh (刷新)",
      category: "Git",
      keywords: ["refresh", "reload", "刷新", "重载状态"],
      enabled: requireRepo,
      run: async (ctx) => {
        await ctx.refresh();
        await ctx.reloadHistory();
        ctx.showToast?.("info", "已刷新 Git 仓库状态");
      },
    },
    {
      id: "git.openDiff",
      title: "Git: Open Changes Diff (查看文件对比)",
      category: "Git",
      keywords: ["diff", "compare", "查看对比", "差异"],
      enabled: requireChanges,
      run: async (ctx) => {
        const status = await api.status();
        const first =
          status.unstaged[0] ?? status.staged[0] ?? status.untracked[0];
        if (first) {
          ctx.showView("changes");
          ctx.openDiff(first.path);
        }
      },
    },

    // -------------------------------------------------------------------------
    // 8. Workspace: 工作区管理
    // -------------------------------------------------------------------------
    {
      id: "workspace.open",
      title: "Workspace: Open Workspace... (打开本地工作区/仓库...)",
      category: "Workspace",
      keywords: ["open", "workspace", "repo", "folder", "工作区", "打开"],
      keybindingHint: "Ctrl+O",
      run: (ctx) => {
        ctx.openWorkspaceDialog?.();
      },
    },
    {
      id: "workspace.close",
      title: "Workspace: Close Workspace (关闭当前工作区)",
      category: "Workspace",
      keywords: ["close", "workspace", "关闭工作区", "关闭"],
      keybindingHint: "Ctrl+W",
      enabled: requireRepo,
      run: (ctx) => {
        ctx.closeCurrentWorkspace?.();
      },
    },
    {
      id: "workspace.next",
      title: "Workspace: Next Workspace (切换到下一个工作区)",
      category: "Workspace",
      keywords: ["next", "workspace", "下一个", "切换工作区"],
      keybindingHint: "Ctrl+Tab",
      enabled: requireRepo,
      run: (ctx) => {
        ctx.nextWorkspace?.();
      },
    },
    {
      id: "workspace.prev",
      title: "Workspace: Previous Workspace (切换到上一个工作区)",
      category: "Workspace",
      keywords: ["prev", "previous", "workspace", "上一个", "切换工作区"],
      keybindingHint: "Ctrl+Shift+Tab",
      enabled: requireRepo,
      run: (ctx) => {
        ctx.prevWorkspace?.();
      },
    },
    {
      id: "workspace.catalog",
      title: "Workspace: Manage Repositories & Groups (打开仓库与项目分组管理中心)",
      category: "Workspace",
      keywords: ["catalog", "manage", "groups", "worktree", "仓库管理", "项目分组"],
      run: (ctx) => {
        ctx.openCatalogPanel?.();
      },
    },
    {
      id: "workspace.closeOthers",
      title: "Workspace: Close Other Workspaces (关闭其他工作区)",
      category: "Workspace",
      keywords: ["close others", "关闭其他工作区", "关闭其他"],
      enabled: requireRepo,
      run: (ctx) => {
        ctx.closeOtherWorkspaces?.();
      },
    },
    // -------------------------------------------------------------------------
    // 应用与更新
    // -------------------------------------------------------------------------
    {
      id: "app.checkUpdates",
      title: "App: Check for Updates (检查更新)",
      category: "App",
      keywords: ["update", "upgrade", "version", "检查更新", "更新", "升级", "版本"],
      run: (ctx) => {
        ctx.openUpdaterDialog?.();
      },
    },
    {
      id: "app.showAbout",
      title: "App: About git-hunk (关于 git-hunk)",
      category: "App",
      keywords: ["about", "version", "关于", "版本", "信息"],
      run: (ctx) => {
        ctx.openUpdaterDialog?.();
      },
    },
    // -------------------------------------------------------------------------
    // 视图缩放
    // -------------------------------------------------------------------------
    {
      id: "view.zoomIn",
      title: "View: Zoom In (放大界面)",
      category: "View",
      keywords: ["zoom in", "zoom", "放大", "缩放", "界面放大", "ctrl+="],
      run: (ctx) => {
        ctx.zoomIn?.();
      },
    },
    {
      id: "view.zoomOut",
      title: "View: Zoom Out (缩小界面)",
      category: "View",
      keywords: ["zoom out", "zoom", "缩小", "缩放", "界面缩小", "ctrl+-"],
      run: (ctx) => {
        ctx.zoomOut?.();
      },
    },
    {
      id: "view.zoomReset",
      title: "View: Reset Zoom (重置缩放)",
      category: "View",
      keywords: ["reset zoom", "zoom", "重置缩放", "默认缩放", "100%", "ctrl+0"],
      run: (ctx) => {
        ctx.resetZoom?.();
      },
    },
  ];
}
