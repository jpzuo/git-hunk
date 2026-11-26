/**
 * git-hunk 主应用壳。
 *
 * 布局取向：**以 Git 为中心，而不是以编辑器为中心**。
 * - 默认视图是提交关系图（DAG），不是空白编辑器区
 * - 左栏是带文字的功能导航（提交 / 变更 / 分支 / Stash / 标签 / 远程），
 *   不再需要用户猜图标含义
 * - 提交图在上、选中提交的详情与 diff 在下，形成「历史 → 变更 → 内容」的阅读动线
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  FolderGit2,
  GitGraph,
  FileDiff,
  FolderTree,
  GitBranch,
  Archive,
  Tag,
  FolderOpen,
  Folder,
  GitFork,
  Command as CommandIcon,
  RefreshCw,
  ChevronDown,
  Search,
  X,
  Check,
  Globe,
  Play,
} from "lucide-react";
import "./index.css";

import { api, GitHunkError } from "./api";
import type { Command, CommandContext } from "./commands/registry";
import { CommandRegistry } from "./commands/registry";
import { buildCommands } from "./commands/builtin";
import { CommandPalette } from "./components/CommandPalette";
import { SourceControlPanel } from "./components/SourceControlPanel";
import { SideBySideDiff } from "./components/SideBySideDiff";
import { CommitGraph } from "./components/CommitGraph";
import { BranchQuickPick } from "./components/BranchQuickPick";
import { IconButton } from "./components/IconButton";
import { StashPanel } from "./components/StashPanel";
import { StashReviewPage } from "./components/StashReviewPage";
import { TagsPanel } from "./components/TagsPanel";
import { WorkspaceTabs } from "./components/WorkspaceTabs";
import { WindowControls } from "./components/WindowControls";
import { RepositoriesPanel } from "./components/RepositoriesPanel";
import { FileExplorerPanel } from "./components/FileExplorerPanel";
import { ScriptsPanel } from "./components/ScriptsPanel";
import { ScriptRunnerConsole } from "./components/ScriptRunnerConsole";
import {
  GlobalSearchPanel,
  createDefaultGlobalSearchState,
  type GlobalSearchState,
} from "./components/GlobalSearchPanel";
import { FilePreviewPage } from "./components/FilePreviewPage";
import { EditorTabBar } from "./components/EditorTabBar";
import { UpdateBanner } from "./components/UpdateBanner";
import { UpdateDialog } from "./components/UpdateDialog";
import { useUpdater } from "./updater/useUpdater";
import { useZoom } from "./zoom/useZoom";
import { formatZoom, isDefaultZoom } from "./zoom/zoomUtils";
import { CommitDetailSidebar } from "./components/CommitDetailSidebar";
import type {
  BranchInfo,
  CatalogItemSummary,
  EditorTab,
  FileStatus,
  RepoStatus,
  ScriptExitEvent,
  ScriptGroup,
  ScriptItem,
  ScriptOutputEvent,
  ScriptRunRecord,
  SearchHighlightSpec,
  StageArea,
  StashInfo,
  TagInfo,
  WorkspaceSummary,
} from "./types";
import type { CommitDetail, FilePair, GraphCommit } from "./historyTypes";

const RECENT_REPO_KEY = "git-hunk.recent-repo";
const RECENT_WORKSPACES_KEY = "git-hunk.open-workspaces";
const ACTIVE_WORKSPACE_KEY = "git-hunk.active-workspace";

interface WorkspaceViewCache {
  nav: NavView;
  commitMessage: string;
  selectedOid: string | null;
  reviewingOid: string | null;
  selectedFile: string | null;
  workdirSelection: { path: string; area: StageArea } | null;
  selectedPreviewFile: string | null;
  tabs: EditorTab[];
  activeTabId: string | null;
  graphScrollTop?: number;
  historyBranchScope?: string;
  historyFilterQuery?: string;
  globalSearchState?: GlobalSearchState;
}

const STATUS_LABEL: Record<FileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "!",
  type_change: "T",
};

function getWorkdirFileStatus(st: RepoStatus | null, path: string): FileStatus | undefined {
  if (!st) return undefined;
  const norm = path.replace(/\\/g, "/");
  const unstaged = st.unstaged.find((f) => f.path === norm);
  if (unstaged) return unstaged.status;
  const untracked = st.untracked.find((f) => f.path === norm);
  if (untracked) return untracked.status;
  const staged = st.staged.find((f) => f.path === norm);
  if (staged) return staged.status;
  return undefined;
}

const PAGE_SIZE = 200;

const MAX_SCRIPT_LOG_LINES = 4000;

function appendScriptChunkToRecord(
  rec: ScriptRunRecord,
  stream: "stdout" | "stderr" | "system",
  chunk: string,
  allocLineId: () => number,
): ScriptRunRecord {
  const normalized = chunk.replace(/\r\n/g, "\n");
  const lines = [...rec.lines];
  let partial = rec.partial_line;

  const segments = normalized.split("\n");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const crParts = seg.split("\r");
    const lastCr = crParts[crParts.length - 1];
    partial = crParts.length > 1 ? lastCr : `${partial}${lastCr}`;

    if (i < segments.length - 1) {
      lines.push({
        id: allocLineId(),
        stream,
        text: partial,
      });
      partial = "";
    }
  }

  const trimmed =
    lines.length > MAX_SCRIPT_LOG_LINES
      ? lines.slice(lines.length - MAX_SCRIPT_LOG_LINES)
      : lines;

  return {
    ...rec,
    lines: trimmed,
    partial_line: partial,
  };
}

/** 左栏导航项。 */
type NavView = "files" | "search" | "changes" | "history" | "stash" | "scripts";

interface NavItem {
  id: NavView;
  label: string;
  icon: React.ReactNode;
  /** 是否已实现；未实现的给出提示。 */
  ready: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { id: "files", label: "文件目录", icon: <FolderTree size={18} strokeWidth={1.75} />, ready: true },
  { id: "search", label: "搜索 (Ctrl+Shift+F)", icon: <Search size={18} strokeWidth={1.75} />, ready: true },
  { id: "changes", label: "工作区", icon: <FileDiff size={18} strokeWidth={1.75} />, ready: true },
  { id: "history", label: "提交历史", icon: <GitGraph size={18} strokeWidth={1.75} />, ready: true },
  { id: "stash", label: "Stash", icon: <Archive size={18} strokeWidth={1.75} />, ready: true },
  { id: "scripts", label: "脚本", icon: <Play size={18} strokeWidth={1.75} />, ready: true },
];

export default function App() {
  const registryRef = useRef<CommandRegistry | null>(null);
  if (!registryRef.current) registryRef.current = new CommandRegistry();
  const registry = registryRef.current;

  // ---------------- 仓库与变更状态 ----------------
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const workspaceCacheRef = useRef<Map<string, WorkspaceViewCache>>(new Map());
  const [catalog, setCatalog] = useState<CatalogItemSummary[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [reposDropdownOpen, setReposDropdownOpen] = useState(false);
  const reposDropdownOpenRef = useRef(false);
  reposDropdownOpenRef.current = reposDropdownOpen;
  const reposDropdownRef = useRef<HTMLDivElement>(null);
  const hasStatusRef = useRef(false);
  hasStatusRef.current = !!status;
  const [tabRenameModal, setTabRenameModal] = useState<{
    path: string;
    alias: string;
    originalName: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [toast, setToast] = useState<{ kind: "info" | "error"; text: string } | null>(
    null,
  );
  // 自动更新：检查 / 下载 / 安装状态机 + 关于弹窗开关
  const updater = useUpdater();
  const [updaterOpen, setUpdaterOpen] = useState(false);
  // 界面缩放（Ctrl+= / Ctrl+- / Ctrl+0）
  const {
    zoom: zoomLevel,
    zoomIn,
    zoomOut,
    reset: resetZoom,
  } = useZoom();
  const [explorerRefreshNonce, setExplorerRefreshNonce] = useState(0);
  const tabPairReqRef = useRef<Map<string, number>>(new Map());

  // ---------------- 导航 ----------------
  const [nav, setNav] = useState<NavView>("files");

  // ---------------- 提交历史 ----------------
  const [commits, setCommits] = useState<GraphCommit[]>([]);
  const [laneCount, setLaneCount] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedOid, setSelectedOid] = useState<string | null>(null);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  /** 正在审查的提交 oid；非空表示侧栏展示提交详情与变更树。 */
  const [reviewingOid, setReviewingOid] = useState<string | null>(null);
  const graphScrollTopRef = useRef<number>(0);
  const [historyBranchScope, setHistoryBranchScope] = useState<string>("HEAD");
  const [historyFilterQuery, setHistoryFilterQuery] = useState("");
  const [appliedHistoryQuery, setAppliedHistoryQuery] = useState("");
  const appliedHistoryQueryRef = useRef("");
  const historyDebounceRef = useRef<number | null>(null);
  const historyReqSeqRef = useRef(0);
  const [historyScopeOpen, setHistoryScopeOpen] = useState(false);
  const [historyScopeQuery, setHistoryScopeQuery] = useState("");
  const historyScopeRef = useRef<HTMLDivElement>(null);
  const [tagsPopoverOpen, setTagsPopoverOpen] = useState(false);
  const tagsPopoverRef = useRef<HTMLDivElement>(null);

  // ---------------- diff 查看 ----------------
  const [workdirPair, setWorkdirPair] = useState<FilePair | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [workdirSelection, setWorkdirSelection] = useState<{
    path: string;
    area: StageArea;
  } | null>(null);

  // ---------------- 文件目录预览 & 全局搜索 ----------------
  const [selectedPreviewFile, setSelectedPreviewFile] = useState<string | null>(null);
  const [globalSearchState, setGlobalSearchState] = useState<GlobalSearchState>(() =>
    createDefaultGlobalSearchState(),
  );
  const [globalSearchFocusNonce, setGlobalSearchFocusNonce] = useState(0);
  const previewJumpSeqRef = useRef(0);

  // ---------------- 全局多标签页系统 (VS Code 风格) ----------------
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [tabPairs, setTabPairs] = useState<Record<string, FilePair>>({});
  const [tabLoadingMap, setTabLoadingMap] = useState<Record<string, boolean>>({});
  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );

  // ---------------- 扩展能力状态 ----------------
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [stashes, setStashes] = useState<StashInfo[]>([]);
  const [stashesLoading, setStashesLoading] = useState(false);
  const [selectedStash, setSelectedStash] = useState<StashInfo | null>(null);
  const [stashDetail, setStashDetail] = useState<CommitDetail | null>(null);
  const [stashDetailLoading, setStashDetailLoading] = useState(false);
  const [stashPair, setStashPair] = useState<FilePair | null>(null);
  const [stashPairLoading, setStashPairLoading] = useState(false);
  const [selectedStashFile, setSelectedStashFile] = useState<string | null>(null);
  const [branchingStash, setBranchingStash] = useState<StashInfo | null>(null);
  const [stashBranchInput, setStashBranchInput] = useState("");
  const [deletingStashModal, setDeletingStashModal] = useState<StashInfo | null>(null);
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [tagsLoading, setTagsLoading] = useState(false);
  const [creatingTagModal, setCreatingTagModal] = useState<{
    open: boolean;
    targetOid?: string;
  }>({ open: false });
  const [newTagName, setNewTagName] = useState("");
  const [newTagMessage, setNewTagMessage] = useState("");
  const [newTagTargetOid, setNewTagTargetOid] = useState("");
  const [newTagPushRemote, setNewTagPushRemote] = useState(false);
  const [newTagForce, setNewTagForce] = useState(false);
  const [deletingTagModal, setDeletingTagModal] = useState<TagInfo | null>(null);
  const [deleteTagRemote, setDeleteTagRemote] = useState(false);
  const [branchingTagModal, setBranchingTagModal] = useState<TagInfo | null>(null);
  const [branchFromTagInput, setBranchFromTagInput] = useState("");
  const [branchQuickPickOpen, setBranchQuickPickOpen] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);

  // ---------------- 项目可执行脚本与并发控制台 ----------------
  const [scriptGroups, setScriptGroups] = useState<ScriptGroup[]>([]);
  const [scriptsLoading, setScriptsLoading] = useState(false);
  const [scriptRuns, setScriptRuns] = useState<ScriptRunRecord[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const scriptLineSeqRef = useRef(0);

  // ---------------- 其他 ----------------
  const [paletteOpen, setPaletteOpen] = useState(false);
  const busyRef = useRef(false);

  const repoPath = status?.workdir ?? null;
  const hasChanges = useMemo(
    () =>
      !!status &&
      status.staged.length + status.unstaged.length + status.untracked.length > 0,
    [status],
  );

  const showToast = useCallback((kind: "info" | "error", text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), kind === "error" ? 6000 : 2500);
  }, []);

  const handleError = useCallback(
    (e: unknown) => {
      let msg =
        e instanceof GitHunkError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e);
      msg = msg.replace(/^(state error:\s*|git error:\s*)/i, "");

      // 智能识别高频 Git 异常，并转换为精准的中文说明与操作指引
      if (/you need to resolve your current index first/i.test(msg) || /needs merge/i.test(msg)) {
        msg = "切换分支失败：当前工作区存在未解决的代码冲突（如合并、储藏还原或变基留下的冲突文件）。请先在“变更”面板中解决冲突并暂存（或放弃修改），再切换分支。";
      } else if (/local changes to the following files would be overwritten/i.test(msg)) {
        msg = "切换分支失败：当前未提交的本地修改与目标分支存在文件冲突。请先提交（Commit）或储藏（Stash）当前修改后再切换。";
      } else if (/already exists/i.test(msg)) {
        msg = `操作失败：同名的分支或标签已经存在 (${msg})`;
      } else if (/not a valid object name/i.test(msg)) {
        msg = `操作失败：指定的目标提交或引用对象不存在 (${msg})`;
      } else if (/no merge in progress/i.test(msg)) {
        msg = "当前并没有正在进行的合并操作 (No merge in progress)";
      } else if (/no rebase in progress/i.test(msg)) {
        msg = "当前并没有正在进行的变基操作 (No rebase in progress)";
      } else if (/no cherry-pick or revert in progress/i.test(msg)) {
        msg = "当前并没有正在进行的拣选或还原操作";
      }

      showToast("error", msg);
    },
    [showToast],
  );

  // ---------------- 数据加载 ----------------

  const loadHistory = useCallback(
    async (
      skip: number,
      append: boolean,
      scopeOverride?: string,
      queryOverride?: string,
    ) => {
      const scope = scopeOverride ?? historyBranchScope;
      const queryText = (queryOverride ?? appliedHistoryQueryRef.current).trim();
      const reqSeq = ++historyReqSeqRef.current;
      setHistoryLoading(true);
      try {
        const page = await api.history(
          PAGE_SIZE,
          skip,
          scope,
          queryText || null,
        );
        if (reqSeq !== historyReqSeqRef.current) {
          return null;
        }
        setCommits((prev) => (append ? [...prev, ...page.commits] : page.commits));
        setLaneCount((prev) =>
          append ? Math.max(prev, page.lane_count) : page.lane_count,
        );
        setHasMore(page.has_more);
        return page;
      } catch (e) {
        if (reqSeq !== historyReqSeqRef.current) {
          return null;
        }
        handleError(e);
        return null;
      } finally {
        if (reqSeq === historyReqSeqRef.current) {
          setHistoryLoading(false);
        }
      }
    },
    [handleError, historyBranchScope],
  );

  const loadBranches = useCallback(async () => {
    setBranchesLoading(true);
    try {
      const b = await api.branches();
      setBranches(b);
      return b;
    } catch (e) {
      handleError(e);
      return [];
    } finally {
      setBranchesLoading(false);
    }
  }, [handleError]);

  const loadStashes = useCallback(async () => {
    setStashesLoading(true);
    try {
      const s = await api.stashes();
      setStashes(s);
      return s;
    } catch (e) {
      handleError(e);
      return [];
    } finally {
      setStashesLoading(false);
    }
  }, [handleError]);

  const loadTags = useCallback(async () => {
    setTagsLoading(true);
    try {
      const t = await api.tags();
      setTags(t);
      return t;
    } catch (e) {
      handleError(e);
      return [];
    } finally {
      setTagsLoading(false);
    }
  }, [handleError]);

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const list = await api.catalogList();
      setCatalog(list);
      return list;
    } catch (e) {
      handleError(e);
      return [];
    } finally {
      setCatalogLoading(false);
    }
  }, [handleError]);

  const loadScripts = useCallback(async () => {
    setScriptsLoading(true);
    try {
      const groups = await api.discoverScripts();
      setScriptGroups(groups);
      return groups;
    } catch (e) {
      handleError(e);
      setScriptGroups([]);
      return [];
    } finally {
      setScriptsLoading(false);
    }
  }, [handleError]);

  const handleRunScript = useCallback(
    async (script: ScriptItem) => {
      try {
        const session = await api.runScript(script);
        setScriptRuns((prev) => {
          const existing = prev.find((r) => r.run_id === session.run_id);
          if (existing) {
            return prev.map((r) =>
              r.run_id === session.run_id
                ? {
                    ...r,
                    workdir: session.workdir,
                    script,
                    started_at: session.started_at,
                  }
                : r,
            );
          }
          const created: ScriptRunRecord = {
            run_id: session.run_id,
            workdir: session.workdir,
            script,
            status: "running",
            exit_code: null,
            started_at: session.started_at,
            lines: [
              {
                id: ++scriptLineSeqRef.current,
                stream: "system",
                text: `> ${script.display_command}  (目录: ${script.cwd})`,
              },
            ],
            partial_line: "",
          };
          return [...prev, created];
        });
        setActiveRunId(session.run_id);
        if (nav === "scripts") {
          setActiveTabId(null);
        }
      } catch (e) {
        handleError(e);
      }
    },
    [handleError, nav],
  );

  const handleStopRun = useCallback(
    async (runId: string) => {
      try {
        await api.stopScript(runId);
      } catch (e) {
        handleError(e);
      }
    },
    [handleError],
  );

  const handleRestartScript = useCallback(
    async (script: ScriptItem, prevRunId?: string) => {
      if (prevRunId) {
        try {
          await api.stopScript(prevRunId);
        } catch {}
      }
      await handleRunScript(script);
    },
    [handleRunScript],
  );

  const handleClearScriptLogs = useCallback((runId: string) => {
    setScriptRuns((prev) =>
      prev.map((r) =>
        r.run_id === runId ? { ...r, lines: [], partial_line: "" } : r,
      ),
    );
  }, []);

  const handleCloseScriptRunTab = useCallback((runId: string) => {
    setScriptRuns((prev) => {
      const target = prev.find((r) => r.run_id === runId);
      if (target?.status === "running") {
        void api.stopScript(runId).catch(() => {});
      }
      const idx = prev.findIndex((r) => r.run_id === runId);
      const next = prev.filter((r) => r.run_id !== runId);
      setActiveRunId((cur) => {
        if (cur !== runId) return cur;
        const pick = next[idx] ?? next[idx - 1] ?? null;
        return pick ? pick.run_id : null;
      });
      return next;
    });
  }, []);

  const putBoundedTabPair = useCallback(
    (key: string, pair: FilePair, currentTabs: EditorTab[]) => {
      const MAX_TAB_PAIR_CACHE = 24;
      setTabPairs((prev) => {
        const next: Record<string, FilePair> = {};
        const openIds = new Set(currentTabs.map((t) => t.id));
        const keys = Object.keys(prev).filter((k) => k !== key);
        const keptOpen = keys.filter((k) => openIds.has(k));
        const keptClosed = keys.filter((k) => !openIds.has(k));
        const allowedClosed = Math.max(0, MAX_TAB_PAIR_CACHE - 1 - keptOpen.length);
        for (const k of keptOpen) {
          next[k] = prev[k];
        }
        for (const k of keptClosed.slice(-allowedClosed)) {
          next[k] = prev[k];
        }
        next[key] = pair;
        return next;
      });
    },
    [],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const st = await api.status();
      setStatus(st);
      void api.listWorkspaces().then(setWorkspaces).catch(() => {});
      if (reposDropdownOpenRef.current || !hasStatusRef.current) {
        void api.catalogList().then(setCatalog).catch(() => {});
      }
      return st;
    } finally {
      setLoading(false);
    }
  }, []);

  /** 命令上下文要求的 `Promise<void>` 版本。 */
  const refreshCtx = useCallback(async () => {
    await refresh();
  }, [refresh]);

  const loadFilePair = useCallback(
    async (oid: string, path: string, tabId?: string) => {
      const cacheKey = tabId ?? `commit:${oid}:${path}`;
      const reqSeq = (tabPairReqRef.current.get(cacheKey) ?? 0) + 1;
      tabPairReqRef.current.set(cacheKey, reqSeq);
      setTabLoadingMap((prev) => ({ ...prev, [cacheKey]: true }));
      setSelectedFile(path);
      try {
        const p = await api.commitFilePair(oid, path);
        if (tabPairReqRef.current.get(cacheKey) !== reqSeq) return;
        putBoundedTabPair(cacheKey, p, tabs);
      } catch (e) {
        if (tabPairReqRef.current.get(cacheKey) !== reqSeq) return;
        handleError(e);
      } finally {
        if (tabPairReqRef.current.get(cacheKey) === reqSeq) {
          setTabLoadingMap((prev) => ({ ...prev, [cacheKey]: false }));
        }
      }
    },
    [handleError, putBoundedTabPair, tabs],
  );

  const loadStashFilePair = useCallback(
    async (oid: string, path: string, tabId?: string) => {
      const cacheKey = tabId ?? `stash:${oid}:${path}`;
      const reqSeq = (tabPairReqRef.current.get(cacheKey) ?? 0) + 1;
      tabPairReqRef.current.set(cacheKey, reqSeq);
      setStashPairLoading(true);
      setTabLoadingMap((prev) => ({ ...prev, [cacheKey]: true }));
      setSelectedStashFile(path);
      try {
        const p = await api.commitFilePair(oid, path);
        if (tabPairReqRef.current.get(cacheKey) !== reqSeq) return;
        setStashPair(p);
        putBoundedTabPair(cacheKey, p, tabs);
      } catch (e) {
        if (tabPairReqRef.current.get(cacheKey) !== reqSeq) return;
        handleError(e);
        setStashPair(null);
      } finally {
        if (tabPairReqRef.current.get(cacheKey) === reqSeq) {
          setStashPairLoading(false);
          setTabLoadingMap((prev) => ({ ...prev, [cacheKey]: false }));
        }
      }
    },
    [handleError, putBoundedTabPair, tabs],
  );

  const loadStashDetail = useCallback(
    async (s: StashInfo) => {
      setSelectedStash(s);
      setStashDetailLoading(true);
      setSelectedStashFile(null);
      setStashPair(null);
      try {
        const d = await api.commitDetail(s.oid);
        setStashDetail(d);
        const first = d.files[0];
        if (first) {
          void loadStashFilePair(s.oid, first.path);
        }
      } catch (e) {
        handleError(e);
        setStashDetail(null);
      } finally {
        setStashDetailLoading(false);
      }
    },
    [handleError, loadStashFilePair],
  );

  const openWorkdirDiff = useCallback(
    async (path: string, area: StageArea, tabId?: string) => {
      const cacheKey = tabId ?? `workdir:${area}:${path}`;
      const reqSeq = (tabPairReqRef.current.get(cacheKey) ?? 0) + 1;
      tabPairReqRef.current.set(cacheKey, reqSeq);
      setDiffLoading(true);
      setTabLoadingMap((prev) => ({ ...prev, [cacheKey]: true }));
      setWorkdirSelection({ path, area });
      setSelectedFile(path);
      try {
        const p = await api.workdirFilePair(path, area);
        if (tabPairReqRef.current.get(cacheKey) !== reqSeq) return;
        setWorkdirPair(p);
        putBoundedTabPair(cacheKey, p, tabs);
      } catch (e) {
        if (tabPairReqRef.current.get(cacheKey) !== reqSeq) return;
        handleError(e);
        setWorkdirPair(null);
      } finally {
        if (tabPairReqRef.current.get(cacheKey) === reqSeq) {
          setDiffLoading(false);
          setTabLoadingMap((prev) => ({ ...prev, [cacheKey]: false }));
        }
      }
    },
    [handleError, putBoundedTabPair, tabs],
  );

  // ---------------- 全局多标签页动作 ----------------

  const openPreviewTab = useCallback(
    (
      path: string,
      options?: {
        targetLine?: number;
        targetColumn?: number;
        searchHighlight?: SearchHighlightSpec;
      },
    ) => {
      const id = `preview:${path}`;
      const filename = path.split("/").pop() ?? path;
      const fileStatus = getWorkdirFileStatus(status, path);
      const statusLabel = fileStatus ? STATUS_LABEL[fileStatus] : undefined;
      const hasJump = options?.targetLine !== undefined;
      const nextJumpNonce = hasJump ? ++previewJumpSeqRef.current : undefined;
      setTabs((prev) => {
        const existing = prev.find((t) => t.id === id);
        if (existing) {
          if (
            !hasJump &&
            existing.statusKind === fileStatus &&
            existing.statusLabel === statusLabel &&
            !existing.targetLine &&
            !existing.searchHighlight
          ) {
            return prev;
          }
          return prev.map((t) =>
            t.id === id
              ? {
                  ...t,
                  statusKind: fileStatus,
                  statusLabel,
                  targetLine: hasJump ? options?.targetLine : undefined,
                  targetColumn: hasJump ? options?.targetColumn : undefined,
                  jumpNonce: hasJump ? nextJumpNonce : undefined,
                  searchHighlight: hasJump ? options?.searchHighlight : undefined,
                }
              : t,
          );
        }
        return [
          ...prev,
          {
            id,
            kind: "preview",
            title: filename,
            path,
            isReadOnly: true,
            statusKind: fileStatus,
            statusLabel,
            targetLine: options?.targetLine,
            targetColumn: options?.targetColumn,
            jumpNonce: nextJumpNonce,
            searchHighlight: options?.searchHighlight,
          },
        ];
      });
      setActiveTabId(id);
      setSelectedPreviewFile(path);
    },
    [status],
  );

  const openWorkdirDiffTab = useCallback(
    (path: string, area: StageArea, fileStatus?: FileStatus) => {
      const id = `workdir:${area}:${path}`;
      const filename = path.split("/").pop() ?? path;
      const subtitle =
        area === "staged"
          ? "(暂存区)"
          : area === "unstaged"
            ? "(工作区)"
            : "(未跟踪)";
      const resolvedStatus = fileStatus ?? getWorkdirFileStatus(status, path);
      const statusLabel = resolvedStatus ? STATUS_LABEL[resolvedStatus] : undefined;

      setTabs((prev) => {
        if (prev.some((t) => t.id === id)) return prev;
        return [
          ...prev,
          {
            id,
            kind: "workdir-diff",
            title: filename,
            subtitle,
            path,
            workdirArea: area,
            statusKind: resolvedStatus,
            statusLabel,
          },
        ];
      });
      setActiveTabId(id);
      void openWorkdirDiff(path, area, id);
    },
    [openWorkdirDiff, status],
  );

  const openCommitDiffTab = useCallback(
    (oid: string, path: string, status?: FileStatus, parentOid?: string) => {
      const id = `commit:${oid}:${path}`;
      const filename = path.split("/").pop() ?? path;
      const shortOid = oid.slice(0, 7);
      const shortParent = parentOid ? parentOid.slice(0, 7) : null;
      let subtitle = "";
      if (status === "added") {
        subtitle = `(在 ${shortOid} 中添加)`;
      } else if (status === "deleted") {
        subtitle = `(在 ${shortOid} 中删除)`;
      } else if (shortParent) {
        subtitle = `(${shortParent} ↔ ${shortOid})`;
      } else {
        subtitle = `(${shortOid})`;
      }

      setTabs((prev) => {
        if (prev.some((t) => t.id === id)) return prev;
        return [
          ...prev,
          {
            id,
            kind: "commit-diff",
            title: filename,
            subtitle,
            path,
            commitOid: oid,
            commitOldOid: parentOid,
            isReadOnly: true,
            statusKind: status,
            statusLabel: status ? STATUS_LABEL[status] : undefined,
          },
        ];
      });
      setActiveTabId(id);
      void loadFilePair(oid, path, id);
    },
    [loadFilePair],
  );

  const openStashDiffTab = useCallback(
    (index: number, oid: string, path: string, fileStatus?: FileStatus) => {
      const id = `stash:${oid}:${path}`;
      const filename = path.split("/").pop() ?? path;
      setTabs((prev) => {
        if (prev.some((t) => t.id === id)) return prev;
        return [
          ...prev,
          {
            id,
            kind: "stash-diff",
            title: filename,
            subtitle: `(stash@{${index}})`,
            path,
            stashOid: oid,
            stashIndex: index,
            isReadOnly: true,
            statusKind: fileStatus,
            statusLabel: fileStatus ? STATUS_LABEL[fileStatus] : undefined,
          },
        ];
      });
      setActiveTabId(id);
      void loadStashFilePair(oid, path, id);
    },
    [loadStashFilePair],
  );

  const loadCommitDetail = useCallback(
    async (oid: string, openFirstTab = false) => {
      setDetailLoading(true);
      setSelectedOid(oid);
      setReviewingOid(oid);
      setSelectedFile(null);
      setWorkdirPair(null);
      try {
        const d = await api.commitDetail(oid);
        setDetail(d);
        const first = d.files[0];
        if (openFirstTab && first) {
          openCommitDiffTab(oid, first.path, first.status, d.parents?.[0]);
        }
      } catch (e) {
        handleError(e);
        setDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [handleError, openCommitDiffTab],
  );

  // 打开或切换仓库加载提交历史后，默认选中第一条提交展示详情
  useEffect(() => {
    if (!status || commits.length === 0) return;
    if (!reviewingOid) {
      void loadCommitDetail(commits[0].oid, false);
    }
  }, [status?.workdir, commits, reviewingOid, loadCommitDetail]);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx === -1) return prev;
      const next = prev.filter((t) => t.id !== id);
      setActiveTabId((currentActive) => {
        if (currentActive !== id) return currentActive;
        const nextActive = next[idx] || next[idx - 1] || null;
        return nextActive ? nextActive.id : null;
      });
      return next;
    });
    setTabPairs((prev) => {
      if (!(id in prev)) return prev;
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });
  }, []);

  const closeOtherTabs = useCallback((id: string) => {
    setTabs((prev) => prev.filter((t) => t.id === id));
    setActiveTabId(id);
    setTabPairs((prev) => (prev[id] ? { [id]: prev[id] } : {}));
  }, []);

  const closeTabsToRight = useCallback((id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx === -1) return prev;
      const next = prev.slice(0, idx + 1);
      setActiveTabId((currentActive) => {
        if (next.some((t) => t.id === currentActive)) return currentActive;
        return id;
      });
      return next;
    });
  }, []);

  const closeAllTabs = useCallback(() => {
    setTabs([]);
    setActiveTabId(null);
    setTabPairs({});
    setTabLoadingMap({});
  }, []);

  // 监听激活标签切换并同步加载数据（若命中缓存则直接展示并在必要时静默刷新工作区对比）
  useEffect(() => {
    if (!activeTab) return;
    if (activeTab.kind === "preview") {
      setSelectedPreviewFile(activeTab.path);
    } else if (activeTab.kind === "workdir-diff" && activeTab.workdirArea) {
      void openWorkdirDiff(activeTab.path, activeTab.workdirArea, activeTab.id);
    } else if (activeTab.kind === "commit-diff" && activeTab.commitOid) {
      setSelectedFile(activeTab.path);
      if (!tabPairs[activeTab.id]) {
        void loadFilePair(activeTab.commitOid, activeTab.path, activeTab.id);
      }
    } else if (activeTab.kind === "stash-diff" && activeTab.stashOid) {
      setSelectedStashFile(activeTab.path);
      if (!tabPairs[activeTab.id]) {
        void loadStashFilePair(activeTab.stashOid, activeTab.path, activeTab.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // ---------------- 多工作区管理与状态隔离 ----------------

  const saveCurrentWorkspaceState = useCallback(() => {
    if (!status?.workdir) return;
    workspaceCacheRef.current.set(status.workdir, {
      nav,
      commitMessage,
      selectedOid,
      reviewingOid,
      selectedFile,
      workdirSelection,
      selectedPreviewFile,
      tabs,
      activeTabId,
      graphScrollTop: graphScrollTopRef.current,
      historyBranchScope,
      historyFilterQuery: appliedHistoryQueryRef.current,
      globalSearchState,
    });
  }, [
    status?.workdir,
    nav,
    commitMessage,
    selectedOid,
    reviewingOid,
    selectedFile,
    workdirSelection,
    selectedPreviewFile,
    tabs,
    activeTabId,
    historyBranchScope,
    globalSearchState,
  ]);

  const restoreWorkspaceState = useCallback(
    (targetPath: string): { scope: string; query: string } => {
      if (historyDebounceRef.current !== null) {
        window.clearTimeout(historyDebounceRef.current);
        historyDebounceRef.current = null;
      }
      historyReqSeqRef.current += 1;
      void api.cancelHistorySearch().catch(() => {});
      void api.cancelContentSearch().catch(() => {});
      setTabPairs({});
      setTabLoadingMap({});
      setCommits([]);
      setHistoryScopeOpen(false);
      setHistoryScopeQuery("");
      setTagsPopoverOpen(false);
      const cached = workspaceCacheRef.current.get(targetPath);
      if (cached) {
        const safeNav: NavView =
          cached.nav === "history" ||
          cached.nav === "changes" ||
          cached.nav === "files" ||
          cached.nav === "search" ||
          cached.nav === "stash" ||
          cached.nav === "scripts"
            ? cached.nav
            : "files";
        const restoredScope = cached.historyBranchScope ?? "HEAD";
        const restoredQuery = (cached.historyFilterQuery ?? "").trim();
        setNav(safeNav);
        setCommitMessage(cached.commitMessage);
        setSelectedOid(cached.selectedOid);
        setReviewingOid(cached.reviewingOid);
        setSelectedFile(cached.selectedFile);
        setWorkdirSelection(cached.workdirSelection);
        setSelectedPreviewFile(cached.selectedPreviewFile ?? null);
        setTabs(cached.tabs || []);
        setActiveTabId(cached.activeTabId || null);
        graphScrollTopRef.current = cached.graphScrollTop ?? 0;
        setHistoryBranchScope(restoredScope);
        setHistoryFilterQuery(restoredQuery);
        setAppliedHistoryQuery(restoredQuery);
        appliedHistoryQueryRef.current = restoredQuery;
        setGlobalSearchState(
          cached.globalSearchState ?? createDefaultGlobalSearchState(),
        );
        if (cached.reviewingOid) {
          void loadCommitDetail(cached.reviewingOid, false);
        } else if (cached.workdirSelection) {
          void api
            .workdirFilePair(cached.workdirSelection.path, cached.workdirSelection.area)
            .then(setWorkdirPair)
            .catch(() => setWorkdirPair(null));
        } else {
          setWorkdirPair(null);
          setDetail(null);
        }
        return { scope: restoredScope, query: restoredQuery };
      } else {
        setNav("files");
        setCommitMessage("");
        setSelectedOid(null);
        setReviewingOid(null);
        setSelectedFile(null);
        setSelectedPreviewFile(null);
        setWorkdirSelection(null);
        setWorkdirPair(null);
        setDetail(null);
        setTabs([]);
        setActiveTabId(null);
        graphScrollTopRef.current = 0;
        setHistoryBranchScope("HEAD");
        setHistoryFilterQuery("");
        setAppliedHistoryQuery("");
        appliedHistoryQueryRef.current = "";
        setGlobalSearchState(createDefaultGlobalSearchState());
        return { scope: "HEAD", query: "" };
      }
    },
    [loadCommitDetail],
  );

  const persistWorkspaces = useCallback(
    (list: WorkspaceSummary[], active: string | null) => {
      try {
        localStorage.setItem(
          RECENT_WORKSPACES_KEY,
          JSON.stringify(list.map((w) => w.path)),
        );
        if (active) {
          localStorage.setItem(ACTIVE_WORKSPACE_KEY, active);
          localStorage.setItem(RECENT_REPO_KEY, active);
        } else {
          localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
        }
      } catch {
        /* ignore localStorage quota/disabled errors */
      }
    },
    [],
  );

  const switchWorkspace = useCallback(
    async (path: string) => {
      if (status?.workdir && path.toLowerCase() === status.workdir.toLowerCase()) return;
      saveCurrentWorkspaceState();
      setLoading(true);
      try {
        const isAlreadyOpen = workspaces.some(
          (w) => w.path.toLowerCase() === path.toLowerCase(),
        );
        const st = isAlreadyOpen
          ? await api.switchWorkspace(path)
          : await api.openWorkspace(path);

        setStatus(st);
        const restored = restoreWorkspaceState(path);
        const list = await api.listWorkspaces();
        setWorkspaces(list);
        persistWorkspaces(list, st.workdir);
        void loadCatalog();
        await Promise.all([
          loadHistory(0, false, restored.scope, restored.query),
          loadBranches(),
          loadStashes(),
          loadTags(),
          loadScripts(),
        ]);
      } catch (e) {
        handleError(e);
      } finally {
        setLoading(false);
      }
    },
    [
      status?.workdir,
      workspaces,
      saveCurrentWorkspaceState,
      restoreWorkspaceState,
      persistWorkspaces,
      loadHistory,
      loadBranches,
      loadStashes,
      loadTags,
      loadCatalog,
      handleError,
    ],
  );

  const closeWorkspace = useCallback(
    async (path: string) => {
      try {
        workspaceCacheRef.current.delete(path);
        const nextStatus = await api.closeWorkspace(path);
        const list = await api.listWorkspaces();
        setWorkspaces(list);
        if (nextStatus) {
          setStatus(nextStatus);
          const restored = restoreWorkspaceState(nextStatus.workdir);
          persistWorkspaces(list, nextStatus.workdir);
          await Promise.all([
            loadHistory(0, false, restored.scope, restored.query),
            loadBranches(),
            loadStashes(),
            loadTags(),
            loadScripts(),
          ]);
        } else {
          if (historyDebounceRef.current !== null) {
            window.clearTimeout(historyDebounceRef.current);
            historyDebounceRef.current = null;
          }
          historyReqSeqRef.current += 1;
          void api.cancelHistorySearch().catch(() => {});
          void api.cancelContentSearch().catch(() => {});
          setStatus(null);
          setSelectedOid(null);
          setReviewingOid(null);
          setDetail(null);
          setWorkdirPair(null);
          setSelectedFile(null);
          setWorkdirSelection(null);
          setTabs([]);
          setActiveTabId(null);
          setTabPairs({});
          setTabLoadingMap({});
          setCommits([]);
          setBranches([]);
          setStashes([]);
          setTags([]);
          setScriptGroups([]);
          graphScrollTopRef.current = 0;
          setHistoryBranchScope("HEAD");
          setHistoryFilterQuery("");
          setAppliedHistoryQuery("");
          appliedHistoryQueryRef.current = "";
          setGlobalSearchState(createDefaultGlobalSearchState());
          setHistoryScopeOpen(false);
          setTagsPopoverOpen(false);
          persistWorkspaces([], null);
        }
      } catch (e) {
        handleError(e);
      }
    },
    [
      restoreWorkspaceState,
      persistWorkspaces,
      loadHistory,
      loadBranches,
      loadStashes,
      loadTags,
      handleError,
    ],
  );

  const openWorkspace = useCallback(
    async (path: string) => {
      setLoading(true);
      try {
        saveCurrentWorkspaceState();
        const st = await api.openWorkspace(path);
        setStatus(st);
        const restored = restoreWorkspaceState(st.workdir);
        const list = await api.listWorkspaces();
        setWorkspaces(list);
        persistWorkspaces(list, st.workdir);
        void loadCatalog();
        await Promise.all([
          loadHistory(0, false, restored.scope, restored.query),
          loadBranches(),
          loadStashes(),
          loadTags(),
          loadScripts(),
        ]);
        showToast("info", `已打开工作区 ${st.workdir}`);
      } catch (e) {
        handleError(e);
      } finally {
        setLoading(false);
      }
    },
    [
      saveCurrentWorkspaceState,
      restoreWorkspaceState,
      persistWorkspaces,
      loadHistory,
      loadBranches,
      loadStashes,
      loadTags,
      loadCatalog,
      showToast,
      handleError,
    ],
  );

  const closeOtherWorkspaces = useCallback(
    async (keepPath: string) => {
      const toClose = workspaces.filter((w) => w.path !== keepPath);
      for (const ws of toClose) {
        workspaceCacheRef.current.delete(ws.path);
        await api.closeWorkspace(ws.path);
      }
      const list = await api.listWorkspaces();
      setWorkspaces(list);
      persistWorkspaces(list, keepPath);
      showToast("info", "已关闭其他工作区");
    },
    [workspaces, persistWorkspaces, showToast],
  );

  // ---------------- 仓库管理中心 CRUD 回调 ----------------

  const onRenameCatalogRepo = useCallback(
    async (path: string, alias: string | null) => {
      try {
        await api.renameCatalogRepo(path, alias);
        await loadCatalog();
        const list = await api.listWorkspaces();
        setWorkspaces(list);
        showToast("info", "工作区别名已更新");
      } catch (e) {
        handleError(e);
      }
    },
    [loadCatalog, showToast, handleError],
  );

  const onRemoveCatalogRepo = useCallback(
    async (path: string, deleteDiskFiles: boolean) => {
      try {
        await api.removeCatalogRepo(path, deleteDiskFiles);
        await loadCatalog();
        const list = await api.listWorkspaces();
        setWorkspaces(list);
        const remainingActive =
          list.find((w) => w.path.toLowerCase() !== path.toLowerCase())
            ?.path ?? null;
        persistWorkspaces(list, remainingActive);

        // 如果被删除的工作区是当前活跃工作区，则自动切换或清空状态
        if (status?.workdir && path.toLowerCase() === status.workdir.toLowerCase()) {
          if (remainingActive) {
            void switchWorkspace(remainingActive);
          } else {
            setStatus(null);
            setSelectedOid(null);
            setReviewingOid(null);
            setDetail(null);
            setWorkdirPair(null);
            setTabs([]);
            setActiveTabId(null);
            setTabPairs({});
            setTabLoadingMap({});
          }
        }
        showToast(
          "info",
          deleteDiskFiles
            ? "已彻底删除工作区及硬盘物理文件"
            : "已从工作区列表中移除",
        );
      } catch (e) {
        handleError(e);
      }
    },
    [
      loadCatalog,
      persistWorkspaces,
      status?.workdir,
      switchWorkspace,
      showToast,
      handleError,
    ],
  );

  const onDeleteCatalogGroup = useCallback(
    async (name: string) => {
      try {
        await api.deleteCatalogGroup(name);
        await loadCatalog();
        showToast("info", `已删除分组 "${name}"`);
      } catch (e) {
        handleError(e);
      }
    },
    [loadCatalog, showToast, handleError],
  );

  const onImportWorktrees = useCallback(
    async (repoPath: string, targetGroup: string) => {
      try {
        const count = await api.importWorktrees(repoPath, targetGroup);
        await loadCatalog();
        showToast("info", `已成功发现并导入 ${count} 个关联工作树`);
      } catch (e) {
        handleError(e);
      }
    },
    [loadCatalog, showToast, handleError],
  );

  const nextWorkspace = useCallback(() => {
    if (workspaces.length <= 1) return;
    const idx = workspaces.findIndex((w) => w.path === status?.workdir);
    const nextIdx = (idx + 1) % workspaces.length;
    void switchWorkspace(workspaces[nextIdx].path);
  }, [workspaces, status?.workdir, switchWorkspace]);

  const prevWorkspace = useCallback(() => {
    if (workspaces.length <= 1) return;
    const idx = workspaces.findIndex((w) => w.path === status?.workdir);
    const prevIdx = (idx - 1 + workspaces.length) % workspaces.length;
    void switchWorkspace(workspaces[prevIdx].path);
  }, [workspaces, status?.workdir, switchWorkspace]);

  const closeCurrentWorkspace = useCallback(() => {
    if (status?.workdir) {
      void closeWorkspace(status.workdir);
    }
  }, [status?.workdir, closeWorkspace]);

  /** 轻量只读状态刷新：可选择是否显示 loading 遮罩（高频操作静默刷新以防掉帧） */
  const refreshStatus = useCallback(async (silent = true) => {
    if (!silent) setLoading(true);
    try {
      const st = await api.status();
      setStatus(st);
      return st;
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  /** 当仓库 status 变化时，自动同步所有已打开只读预览标签页的 Git 修改/新增状态 (M/U/A/D) */
  useEffect(() => {
    if (!status) return;
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((tab) => {
        if (tab.kind !== "preview") return tab;
        const fileStatus = getWorkdirFileStatus(status, tab.path);
        const nextLabel = fileStatus ? STATUS_LABEL[fileStatus] : undefined;
        if (tab.statusKind === fileStatus && tab.statusLabel === nextLabel) {
          return tab;
        }
        changed = true;
        return {
          ...tab,
          statusKind: fileStatus,
          statusLabel: nextLabel,
        };
      });
      return changed ? next : prev;
    });
  }, [status]);

  /** 暂存/取消暂存/丢弃专用极速局部刷新：同步更新工作区标签页状态并仅刷新必要对比 */
  const syncWorkdirTabs = useCallback(
    async (st: RepoStatus) => {
      const findEntry = (path: string, preferredArea?: StageArea) => {
        if (preferredArea === "staged") {
          const s = st.staged.find((f) => f.path === path);
          if (s) return { area: "staged" as StageArea, status: s.status };
        } else if (preferredArea === "unstaged") {
          const u = st.unstaged.find((f) => f.path === path);
          if (u) return { area: "unstaged" as StageArea, status: u.status };
        } else if (preferredArea === "untracked") {
          const ut = st.untracked.find((f) => f.path === path);
          if (ut) return { area: "untracked" as StageArea, status: ut.status };
        }
        const s = st.staged.find((f) => f.path === path);
        if (s) return { area: "staged" as StageArea, status: s.status };
        const u = st.unstaged.find((f) => f.path === path);
        if (u) return { area: "unstaged" as StageArea, status: u.status };
        const ut = st.untracked.find((f) => f.path === path);
        if (ut) return { area: "untracked" as StageArea, status: ut.status };
        return null;
      };

      const currentTabs = tabs;
      const workdirTabs = currentTabs.filter((t) => t.kind === "workdir-diff");
      if (workdirTabs.length > 0) {
        const remappedIds = new Map<string, string>();
        const updatedTabs: EditorTab[] = [];
        for (const tab of currentTabs) {
          if (tab.kind !== "workdir-diff") {
            updatedTabs.push(tab);
            continue;
          }
          const found = findEntry(tab.path, tab.workdirArea);
          if (!found) continue;
          const newId = `workdir:${found.area}:${tab.path}`;
          if (updatedTabs.some((t) => t.id === newId)) {
            remappedIds.set(tab.id, newId);
            continue;
          }
          const subtitle =
            found.area === "staged"
              ? "(暂存区)"
              : found.area === "unstaged"
                ? "(工作区)"
                : "(未跟踪)";
          remappedIds.set(tab.id, newId);
          updatedTabs.push({
            ...tab,
            id: newId,
            workdirArea: found.area,
            subtitle,
            statusKind: found.status,
            statusLabel: STATUS_LABEL[found.status],
          });
        }
        setTabs(updatedTabs);

        const nextActiveId = activeTabId
          ? currentTabs.find((t) => t.id === activeTabId)?.kind === "workdir-diff"
            ? (remappedIds.get(activeTabId) ??
              updatedTabs[updatedTabs.length - 1]?.id ??
              null)
            : activeTabId
          : null;
        if (nextActiveId !== activeTabId) {
          setActiveTabId(nextActiveId);
        }

        const activeWorkdirTab = updatedTabs.find(
          (t) => t.id === nextActiveId && t.kind === "workdir-diff",
        );
        if (activeWorkdirTab?.workdirArea) {
          setWorkdirSelection({
            path: activeWorkdirTab.path,
            area: activeWorkdirTab.workdirArea,
          });
          try {
            const p = await api.workdirFilePair(
              activeWorkdirTab.path,
              activeWorkdirTab.workdirArea,
            );
            setWorkdirPair(p);
            setTabPairs((prev) => ({ ...prev, [activeWorkdirTab.id]: p }));
          } catch {
            setWorkdirPair(null);
          }
          return;
        }
      }

      if (workdirSelection) {
        const found = findEntry(workdirSelection.path, workdirSelection.area);
        if (!found) {
          setWorkdirSelection(null);
          setSelectedFile(null);
          setWorkdirPair(null);
        } else {
          setWorkdirSelection({ path: workdirSelection.path, area: found.area });
          try {
            const p = await api.workdirFilePair(workdirSelection.path, found.area);
            setWorkdirPair(p);
          } catch {
            setWorkdirPair(null);
          }
        }
      }
    },
    [tabs, activeTabId, workdirSelection],
  );

  /** 暂存/取消暂存/丢弃专用极速局部刷新：仅刷新 status 与当前文件对比，不打扰 history/branches/stashes/tags */
  const reloadAfterStaging = useCallback(
    async (_targetPath?: string) => {
      const st = await refreshStatus(true);
      await syncWorkdirTabs(st);
    },
    [refreshStatus, syncWorkdirTabs],
  );

  /** 提交/修改提交/撤销提交后刷新：刷新 status + 当前对比 + history */
  const reloadAfterCommit = useCallback(async () => {
    const st = await refreshStatus(true);
    await syncWorkdirTabs(st);
    const page = await loadHistory(0, false);
    if (page?.commits[0]) {
      void loadCommitDetail(page.commits[0].oid, false);
    }
    void loadBranches();
  }, [refreshStatus, syncWorkdirTabs, loadHistory, loadCommitDetail, loadBranches]);

  /** 分支切换/创建/重命名后刷新：刷新 status + branches + history */
  const reloadAfterBranchChange = useCallback(async () => {
    const st = await refreshStatus(true);
    await syncWorkdirTabs(st);
    const branchList = await loadBranches();
    let effectiveScope = historyBranchScope;
    if (
      effectiveScope !== "HEAD" &&
      effectiveScope !== "__ALL__" &&
      !branchList.some((b) => b.name === effectiveScope)
    ) {
      effectiveScope = "HEAD";
      setHistoryBranchScope("HEAD");
    }
    const page = await loadHistory(0, false, effectiveScope);
    if (page?.commits[0]) {
      void loadCommitDetail(page.commits[0].oid, false);
    }
  }, [
    refreshStatus,
    syncWorkdirTabs,
    loadBranches,
    loadHistory,
    loadCommitDetail,
    historyBranchScope,
  ]);

  /** Stash 保存/弹出/应用/丢弃后刷新：刷新 status + stashes */
  const reloadAfterStashChange = useCallback(async () => {
    await Promise.all([refreshStatus(true), loadStashes()]);
    if (workdirSelection) {
      void reloadAfterStaging();
    }
  }, [refreshStatus, loadStashes, reloadAfterStaging, workdirSelection]);

  /** 标签创建/删除/推送后刷新：刷新 tags */
  const reloadAfterTagChange = useCallback(async () => {
    await loadTags();
  }, [loadTags]);

  /** 全量操作后刷新兜底：状态 + 当前 diff + 历史 + 分支/stash/tag/remote。 */
  const reloadAfterWrite = useCallback(async () => {
    const st = await refresh();
    if (workdirSelection) {
      const findArea = (p: string): StageArea | null => {
        if (st.staged.some((f) => f.path === p)) return "staged";
        if (st.unstaged.some((f) => f.path === p)) return "unstaged";
        if (st.untracked.some((f) => f.path === p)) return "untracked";
        return null;
      };
      const area = findArea(workdirSelection.path);
      if (!area) {
        setWorkdirSelection(null);
        setSelectedFile(null);
        setWorkdirPair(null);
      } else {
        setWorkdirSelection({ path: workdirSelection.path, area });
        const pair = await api.workdirFilePair(workdirSelection.path, area);
        setWorkdirPair(pair);
      }
    }
    await Promise.all([
      loadHistory(0, false),
      loadBranches(),
      loadStashes(),
      loadTags(),
    ]);
  }, [
    refresh,
    workdirSelection,
    loadHistory,
    loadBranches,
    loadStashes,
    loadTags,
  ]);

  // ---------------- 启动会话恢复 ----------------

  useEffect(() => {
    void (async () => {
      let savedPaths: string[] = [];
      try {
        const raw = localStorage.getItem(RECENT_WORKSPACES_KEY);
        if (raw) savedPaths = JSON.parse(raw);
      } catch {
        /* ignore json parse error */
      }
      if (!savedPaths || savedPaths.length === 0) {
        const legacy = localStorage.getItem(RECENT_REPO_KEY);
        if (legacy) savedPaths = [legacy];
      }
      if (savedPaths.length === 0) return;

      const savedActive =
        localStorage.getItem(ACTIVE_WORKSPACE_KEY) ?? savedPaths[0];

      // 按序打开所有保存的工作区
      for (const p of savedPaths) {
        try {
          const found = await api.discoverRepo(p);
          if (found) await api.openWorkspace(found);
        } catch {
          /* 忽略失效路径 */
        }
      }

      // 切换至上次活跃的工作区
      if (savedActive) {
        try {
          await api.switchWorkspace(savedActive);
        } catch {}
      }

      try {
        const st = await api.status();
        setStatus(st);
        const list = await api.listWorkspaces();
        setWorkspaces(list);
        await Promise.all([
          loadHistory(0, false),
          loadBranches(),
          loadStashes(),
          loadTags(),
          loadScripts(),
        ]);
      } catch {}
      // 总是加载管理清单
      void loadCatalog();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 点击外部关闭仓库管理悬浮框
  useEffect(() => {
    if (!reposDropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.(".modal-backdrop, .modal-card")) {
        return;
      }
      if (
        reposDropdownRef.current &&
        !reposDropdownRef.current.contains(e.target as Node)
      ) {
        setReposDropdownOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [reposDropdownOpen]);

  // 点击外部关闭提交图分支范围 & 标签浮层
  useEffect(() => {
    if (!historyScopeOpen && !tagsPopoverOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        historyScopeOpen &&
        historyScopeRef.current &&
        !historyScopeRef.current.contains(target)
      ) {
        setHistoryScopeOpen(false);
      }
      if (
        tagsPopoverOpen &&
        tagsPopoverRef.current &&
        !tagsPopoverRef.current.contains(target)
      ) {
        setTagsPopoverOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [historyScopeOpen, tagsPopoverOpen]);

  // ---------------- 导航切换时按需拉取数据 ----------------

  useEffect(() => {
    if (!status) return;
    if (nav === "history") {
      void loadBranches();
      void loadTags();
    } else if (nav === "stash") {
      void loadStashes();
    } else if (nav === "scripts") {
      void loadScripts();
    }
  }, [nav, status, loadBranches, loadTags, loadStashes, loadScripts]);

  useEffect(() => {
    if (nav === "stash") {
      if (stashes.length > 0) {
        if (!selectedStash || !stashes.some((s) => s.oid === selectedStash.oid)) {
          void loadStashDetail(stashes[0]);
        }
      } else {
        setSelectedStash(null);
        setStashDetail(null);
        setStashPair(null);
        setSelectedStashFile(null);
      }
    }
  }, [nav, stashes, selectedStash, loadStashDetail]);

  // ---------------- 外部变更监听（防抖合并避免脚本构建期间触发状态刷新风暴） ----------------

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let debounceTimer: number | null = null;
    let shouldRefreshActive = false;

    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<string>("repo://changed", (event) => {
          if (disposed || busyRef.current) return;
          const changedPath = event.payload;
          if (!changedPath || changedPath === status?.workdir) {
            shouldRefreshActive = true;
          }
          if (debounceTimer !== null) {
            window.clearTimeout(debounceTimer);
          }
          debounceTimer = window.setTimeout(() => {
            debounceTimer = null;
            if (disposed || busyRef.current) return;
            const refreshActive = shouldRefreshActive;
            shouldRefreshActive = false;
            void api.listWorkspaces().then(setWorkspaces).catch(() => {});
            if (reposDropdownOpenRef.current || !hasStatusRef.current) {
              void loadCatalog();
            }
            if (refreshActive) {
              setExplorerRefreshNonce((n) => n + 1);
              void refresh().catch(() => {});
            }
          }, 350);
        });
      } catch {
        /* 非 Tauri 环境忽略 */
      }
    })();

    return () => {
      disposed = true;
      if (debounceTimer !== null) {
        window.clearTimeout(debounceTimer);
      }
      unlisten?.();
    };
  }, [refresh, loadCatalog, status?.workdir]);

  // 监听后端流式脚本输出与退出事件
  useEffect(() => {
    let disposed = false;
    let unlistenOutput: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;

    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlistenOutput = await listen<ScriptOutputEvent>("script://output", (event) => {
          if (disposed) return;
          const { run_id, stream, chunk } = event.payload;
          const safeStream = stream === "stderr" ? "stderr" : "stdout";
          setScriptRuns((prev) => {
            const idx = prev.findIndex((r) => r.run_id === run_id);
            const alloc = () => ++scriptLineSeqRef.current;
            if (idx === -1) {
              const stub: ScriptRunRecord = appendScriptChunkToRecord(
                {
                  run_id,
                  workdir: "",
                  script: {
                    id: run_id,
                    name: run_id,
                    ecosystem: "make",
                    source_label: "",
                    source_file: "",
                    cwd: ".",
                    program: "",
                    args: [],
                    display_command: "",
                    is_long_running: false,
                  },
                  status: "running",
                  exit_code: null,
                  started_at: Math.floor(Date.now() / 1000),
                  lines: [],
                  partial_line: "",
                },
                safeStream,
                chunk,
                alloc,
              );
              return [...prev, stub];
            }
            return prev.map((r) =>
              r.run_id === run_id ? appendScriptChunkToRecord(r, safeStream, chunk, alloc) : r,
            );
          });
        });

        unlistenExit = await listen<ScriptExitEvent>("script://exit", (event) => {
          if (disposed) return;
          const { run_id, exit_code, success, stopped_by_user } = event.payload;
          setScriptRuns((prev) => {
            const nextStatus = stopped_by_user
              ? "stopped"
              : success
                ? "success"
                : "failed";
            const summaryLine = stopped_by_user
              ? "[进程已停止]"
              : `[进程已退出，状态码: ${exit_code ?? 0}]`;

            const finishRecord = (r: ScriptRunRecord): ScriptRunRecord => {
              const lines = [...r.lines];
              if (r.partial_line) {
                lines.push({
                  id: ++scriptLineSeqRef.current,
                  stream: "stdout",
                  text: r.partial_line,
                });
              }
              lines.push({
                id: ++scriptLineSeqRef.current,
                stream: "system",
                text: summaryLine,
              });
              return {
                ...r,
                status: nextStatus,
                exit_code,
                ended_at: Math.floor(Date.now() / 1000),
                lines:
                  lines.length > MAX_SCRIPT_LOG_LINES
                    ? lines.slice(lines.length - MAX_SCRIPT_LOG_LINES)
                    : lines,
                partial_line: "",
              };
            };

            if (!prev.some((r) => r.run_id === run_id)) {
              return [
                ...prev,
                finishRecord({
                  run_id,
                  workdir: "",
                  script: {
                    id: run_id,
                    name: run_id,
                    ecosystem: "make",
                    source_label: "",
                    source_file: "",
                    cwd: ".",
                    program: "",
                    args: [],
                    display_command: "",
                    is_long_running: false,
                  },
                  status: nextStatus,
                  exit_code,
                  started_at: Math.floor(Date.now() / 1000),
                  lines: [],
                  partial_line: "",
                }),
              ];
            }
            return prev.map((r) => (r.run_id === run_id ? finishRecord(r) : r));
          });
        });
      } catch {
        /* 非 Tauri 环境忽略 */
      }
    })();

    return () => {
      disposed = true;
      unlistenOutput?.();
      unlistenExit?.();
    };
  }, []);

  const openFolder = useCallback(async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === "string") await openWorkspace(picked);
    } catch (e) {
      handleError(e);
    }
  }, [openWorkspace, handleError]);

  const openCreateTagModal = useCallback((targetOid?: string) => {
    setCreatingTagModal({ open: true, targetOid });
    setNewTagName("");
    setNewTagMessage("");
    setNewTagTargetOid(targetOid || "");
    setNewTagPushRemote(false);
    setNewTagForce(false);
  }, []);

  const openGlobalSearch = useCallback(() => {
    const sel = window.getSelection()?.toString().trim() ?? "";
    if (sel && !sel.includes("\n") && sel.length <= 120) {
      setGlobalSearchState((prev) => ({ ...prev, query: sel }));
    }
    setNav("search");
    setGlobalSearchFocusNonce((n) => n + 1);
  }, []);

  // ---------------- 命令注册 ----------------

  const ctx: CommandContext = useMemo(
    () => ({
      repoPath,
      hasChanges,
      refresh: refreshCtx,
      openDiff: (p: string) => {
        const stagedItem = status?.staged.find((f) => f.path === p);
        const unstagedItem = status?.unstaged.find((f) => f.path === p);
        const untrackedItem = status?.untracked.find((f) => f.path === p);
        const area: StageArea = stagedItem
          ? "staged"
          : untrackedItem
            ? "untracked"
            : "unstaged";
        const fileStatus = stagedItem?.status ?? unstagedItem?.status ?? untrackedItem?.status;
        openWorkdirDiffTab(p, area, fileStatus);
      },
      getCommitMessage: () => commitMessage,
      setCommitMessage,
      showView: (v) => {
        setNav(v);
        if (v === "search") {
          setGlobalSearchFocusNonce((n) => n + 1);
        } else if (v === "history" || v === "stash" || v === "scripts") {
          setActiveTabId(null);
        }
      },
      openGlobalSearch,
      reloadHistory: async () => {
        await loadHistory(0, false);
      },
      openBranchQuickPick: () => {
        setBranchQuickPickOpen(true);
        void loadBranches();
      },
      openTagManager: () => {
        setNav("history");
        setActiveTabId(null);
        setTagsPopoverOpen(true);
        void loadTags();
      },
      openCreateTagDialog: (oid?: string) => openCreateTagModal(oid),
      showToast: (kind, text) => showToast(kind, text),
      focusCommitInput: () => {
        const el = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(".commit-box textarea, .commit-input");
        el?.focus();
      },
      openWorkspaceDialog: () => void openFolder(),
      closeCurrentWorkspace: () => closeCurrentWorkspace(),
      nextWorkspace: () => nextWorkspace(),
      prevWorkspace: () => prevWorkspace(),
      openCatalogPanel: () => {
        void loadCatalog();
        setReposDropdownOpen(true);
      },
      closeOtherWorkspaces: () => {
        if (status?.workdir) void closeOtherWorkspaces(status.workdir);
      },
      openUpdaterDialog: () => setUpdaterOpen(true),
      zoomIn,
      zoomOut,
      resetZoom,
    }),
    [
      repoPath,
      hasChanges,
      refreshCtx,
      openWorkdirDiffTab,
      commitMessage,
      status,
      loadHistory,
      loadBranches,
      loadTags,
      openGlobalSearch,
      openFolder,
      closeCurrentWorkspace,
      nextWorkspace,
      prevWorkspace,
      closeOtherWorkspaces,
    ],
  );

  // ---------------- 提交历史视图筛选与分支范围 ----------------

  useEffect(() => {
    return () => {
      if (historyDebounceRef.current !== null) {
        window.clearTimeout(historyDebounceRef.current);
      }
    };
  }, []);

  const isHistoryDebouncePending = historyFilterQuery.trim() !== appliedHistoryQuery;

  const runHistorySearch = useCallback(
    async (rawQuery: string) => {
      if (historyDebounceRef.current !== null) {
        window.clearTimeout(historyDebounceRef.current);
        historyDebounceRef.current = null;
      }
      const trimmed = rawQuery.trim();
      if (trimmed === appliedHistoryQueryRef.current) {
        return;
      }
      appliedHistoryQueryRef.current = trimmed;
      setAppliedHistoryQuery(trimmed);
      graphScrollTopRef.current = 0;
      if (!status) return;
      const page = await loadHistory(0, false, historyBranchScope, trimmed);
      if (page?.commits[0] && (!selectedOid || !page.commits.some((c) => c.oid === selectedOid))) {
        void loadCommitDetail(page.commits[0].oid, false);
      }
    },
    [status, historyBranchScope, loadHistory, selectedOid, loadCommitDetail],
  );

  const scheduleHistorySearch = useCallback(
    (rawQuery: string) => {
      if (historyDebounceRef.current !== null) {
        window.clearTimeout(historyDebounceRef.current);
        historyDebounceRef.current = null;
      }
      const trimmed = rawQuery.trim();
      if (trimmed === appliedHistoryQueryRef.current) {
        return;
      }
      historyDebounceRef.current = window.setTimeout(() => {
        historyDebounceRef.current = null;
        void runHistorySearch(rawQuery);
      }, 300);
    },
    [runHistorySearch],
  );

  const scopeBranches = useMemo(() => {
    const q = historyScopeQuery.trim().toLowerCase();
    return {
      local: branches.filter(
        (b) => !b.is_remote && (!q || b.name.toLowerCase().includes(q)),
      ),
      remote: branches.filter(
        (b) => b.is_remote && (!q || b.name.toLowerCase().includes(q)),
      ),
    };
  }, [branches, historyScopeQuery]);

  const historyScopeLabel =
    historyBranchScope === "HEAD"
      ? status?.branch
        ? `当前分支 (${status.branch})`
        : "当前分支 (HEAD)"
      : historyBranchScope === "__ALL__"
        ? "全部分支"
        : historyBranchScope;

  const handleSelectHistoryScope = useCallback(
    async (scope: string) => {
      setHistoryBranchScope(scope);
      setHistoryScopeOpen(false);
      setHistoryScopeQuery("");
      graphScrollTopRef.current = 0;
      const page = await loadHistory(0, false, scope, appliedHistoryQueryRef.current);
      if (page?.commits[0] && (!selectedOid || !page.commits.some((c) => c.oid === selectedOid))) {
        void loadCommitDetail(page.commits[0].oid, false);
      }
    },
    [loadHistory, selectedOid, loadCommitDetail],
  );

  useEffect(() => {
    registry.register(...buildCommands());
    return () => {
      for (const c of registry.all()) registry.unregister(c.id);
    };
  }, [registry]);

  // 变动文件列表导航
  const allChangedFiles = useMemo(() => {
    if (!status) return [];
    const list: Array<{ path: string; area: StageArea; status: FileStatus }> = [];
    for (const f of status.staged) list.push({ path: f.path, area: "staged", status: f.status });
    for (const f of status.unstaged) list.push({ path: f.path, area: "unstaged", status: f.status });
    for (const f of status.untracked) list.push({ path: f.path, area: "untracked", status: f.status });
    return list;
  }, [status]);

  const currentFileIndex = useMemo(() => {
    if (!workdirSelection) return -1;
    return allChangedFiles.findIndex(
      (f) => f.path === workdirSelection.path && f.area === workdirSelection.area,
    );
  }, [allChangedFiles, workdirSelection]);

  const hasPrevFile = currentFileIndex > 0;
  const hasNextFile =
    currentFileIndex >= 0 && currentFileIndex < allChangedFiles.length - 1;

  const onPrevFile = useCallback(() => {
    if (hasPrevFile) {
      const prev = allChangedFiles[currentFileIndex - 1];
      openWorkdirDiffTab(prev.path, prev.area, prev.status);
    }
  }, [allChangedFiles, currentFileIndex, hasPrevFile, openWorkdirDiffTab]);

  const onNextFile = useCallback(() => {
    if (hasNextFile) {
      const next = allChangedFiles[currentFileIndex + 1];
      openWorkdirDiffTab(next.path, next.area, next.status);
    }
  }, [allChangedFiles, currentFileIndex, hasNextFile, openWorkdirDiffTab]);

  // ---------------- 快捷键 ----------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      // 界面缩放：与 VS Code 一致（Ctrl+= 放大 / Ctrl+- 缩小 / Ctrl+0 重置）
      if (mod && !e.altKey && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        zoomIn();
        return;
      }
      if (mod && !e.altKey && (e.key === "-" || e.key === "_")) {
        e.preventDefault();
        zoomOut();
        return;
      }
      if (mod && !e.altKey && e.key === "0") {
        e.preventDefault();
        resetZoom();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "f") {
        if (status) {
          e.preventDefault();
          openGlobalSearch();
        }
      } else if (mod && e.key.toLowerCase() === "o" && !e.shiftKey) {
        e.preventDefault();
        void openFolder();
      } else if (mod && e.key.toLowerCase() === "w" && !e.shiftKey) {
        e.preventDefault();
        if (activeTabId) {
          closeTab(activeTabId);
        } else {
          closeCurrentWorkspace();
        }
      } else if (e.ctrlKey && (e.key === "PageDown" || e.key === "PageUp")) {
        if (tabs.length > 1) {
          e.preventDefault();
          const idx = tabs.findIndex((t) => t.id === activeTabId);
          const step = e.key === "PageDown" ? 1 : -1;
          const nextIdx =
            idx === -1 ? 0 : (idx + step + tabs.length) % tabs.length;
          setActiveTabId(tabs[nextIdx].id);
        }
      } else if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        if (e.shiftKey) {
          prevWorkspace();
        } else {
          nextWorkspace();
        }
      } else if (e.altKey && !e.ctrlKey && !e.shiftKey) {
        if (e.key === "ArrowUp" && nav === "changes") {
          e.preventDefault();
          onPrevFile();
        } else if (e.key === "ArrowDown" && nav === "changes") {
          e.preventDefault();
          onNextFile();
        } else {
          const digit = parseInt(e.key, 10);
          if (!isNaN(digit) && digit >= 1 && digit <= 9) {
            const target = workspaces[digit - 1];
            if (target) {
              e.preventDefault();
              void switchWorkspace(target.path);
            }
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    paletteOpen,
    openFolder,
    closeCurrentWorkspace,
    nextWorkspace,
    prevWorkspace,
    workspaces,
    switchWorkspace,
    nav,
    onPrevFile,
    onNextFile,
    tabs,
    activeTabId,
    closeTab,
    status,
    openGlobalSearch,
    zoomIn,
    zoomOut,
    resetZoom,
  ]);

  // ---------------- 工作区写操作 ----------------

  // ---------------- 领域级精准重载包装器 ----------------

  const withStaging =
    <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
    async (...args: A) => {
      busyRef.current = true;
      try {
        await fn(...args);
        await reloadAfterStaging();
      } catch (e) {
        handleError(e);
        try {
          await reloadAfterStaging();
        } catch {
          /* 忽略异常后的重载错误 */
        }
      } finally {
        busyRef.current = false;
      }
    };

  const withCommit =
    <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
    async (...args: A) => {
      busyRef.current = true;
      try {
        await fn(...args);
        await reloadAfterCommit();
      } catch (e) {
        handleError(e);
        try {
          await reloadAfterCommit();
        } catch {}
      } finally {
        busyRef.current = false;
      }
    };

  const withBranch =
    <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
    async (...args: A) => {
      busyRef.current = true;
      try {
        await fn(...args);
        await reloadAfterBranchChange();
      } catch (e) {
        handleError(e);
        try {
          await reloadAfterBranchChange();
        } catch {}
      } finally {
        busyRef.current = false;
      }
    };

  const withStash =
    <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
    async (...args: A) => {
      busyRef.current = true;
      try {
        await fn(...args);
        await reloadAfterStashChange();
      } catch (e) {
        handleError(e);
        try {
          await reloadAfterStashChange();
        } catch {}
      } finally {
        busyRef.current = false;
      }
    };

  const withTag =
    <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
    async (...args: A) => {
      busyRef.current = true;
      try {
        await fn(...args);
        await reloadAfterTagChange();
      } catch (e) {
        handleError(e);
        try {
          await reloadAfterTagChange();
        } catch {}
      } finally {
        busyRef.current = false;
      }
    };

  const withReload =
    <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
    async (...args: A) => {
      busyRef.current = true;
      try {
        await fn(...args);
        await reloadAfterWrite();
      } catch (e) {
        handleError(e);
        try {
          await reloadAfterWrite();
        } catch {
          /* 忽略异常后的重载错误 */
        }
      } finally {
        busyRef.current = false;
      }
    };

  const onStageFile = withStaging(async (path: string) => {
    await api.stageFile(path);
  });
  const onUnstageFile = withStaging(async (path: string) => {
    await api.unstageFile(path);
  });
  const onDiscardFile = withStaging(async (path: string, area: StageArea) => {
    await api.discardFile(path, area);
  });

  const onStageHunk = withStaging(async (idx: number) => {
    if (!workdirSelection) return;
    await api.stageHunk(workdirSelection.path, idx);
  });
  const onUnstageHunk = withStaging(async (idx: number) => {
    if (!workdirSelection) return;
    await api.unstageHunk(workdirSelection.path, idx);
  });
  const onDiscardHunk = withStaging(async (idx: number) => {
    if (!workdirSelection) return;
    await api.discardHunk(workdirSelection.path, idx);
  });

  const doCommitWithMessage = withCommit(async (msg: string) => {
    if (!msg.trim()) return;
    const res = await api.commit(msg);
    setCommitMessage("");
    showToast("info", `已提交 ${res.short_oid} ${res.summary}`);
  });

  const doAmendWithMessage = withCommit(async (msg: string) => {
    if (!msg.trim()) return;
    const res = await api.amend(msg);
    setCommitMessage("");
    showToast("info", `已 amend 为 ${res.short_oid}`);
  });

  const doStageAll = withStaging(async () => {
    if (!status) return;
    const allPaths = [
      ...status.unstaged.map((f) => f.path),
      ...status.untracked.map((f) => f.path),
    ];
    if (allPaths.length > 0) {
      await api.stagePaths(allPaths);
    }
  });

  // 分支操作
  const onCheckoutBranch = withBranch(async (name: string) => {
    const res = await api.checkoutBranch(name);
    showToast("info", res.stdout.trim() || `已切换到分支 ${name}`);
  });

  const onCreateBranch = withBranch(
    async (name: string, checkoutImmediately: boolean) => {
      await api.createBranch(name);
      if (checkoutImmediately) {
        await api.checkoutBranch(name);
        showToast("info", `已创建并切换到新分支 ${name}`);
      } else {
        showToast("info", `已创建新分支 ${name}`);
      }
    },
  );

  const onDeleteBranch = withBranch(
    async (name: string, force: boolean, deleteRemote?: boolean) => {
      const res = await api.deleteBranch(name, force, Boolean(deleteRemote));
      showToast(
        "info",
        deleteRemote
          ? `已删除本地分支 ${name} 及对应的远程分支`
          : res.stdout.trim() || `已删除分支 ${name}`,
      );
    },
  );

  const onRenameBranch = withBranch(
    async (oldName: string, newName: string) => {
      await api.renameBranch(oldName, newName);
      showToast("info", `分支已重命名为 ${newName}`);
    },
  );

  // 远程同步操作
  const onFetch = withReload(async (remote?: string) => {
    setSyncLoading(true);
    try {
      const res = await api.fetch(remote);
      showToast("info", res.stdout.trim() || "Fetch 完成");
    } finally {
      setSyncLoading(false);
    }
  });

  const onPull = withReload(async (remote?: string) => {
    setSyncLoading(true);
    try {
      const res = await api.pull(remote);
      showToast("info", res.stdout.trim() || "Pull 成功");
    } finally {
      setSyncLoading(false);
    }
  });

  const onPush = withReload(async (remote?: string) => {
    setSyncLoading(true);
    try {
      const res = await api.push(remote, undefined, true);
      showToast("info", res.stdout.trim() || "Push 成功");
    } finally {
      setSyncLoading(false);
    }
  });

  const onSync = withReload(async () => {
    setSyncLoading(true);
    try {
      const res = await api.sync();
      showToast("info", res.stdout.trim() || "同步完成");
    } catch (e: any) {
      showToast("error", `同步失败: ${e.message || String(e)}`);
    } finally {
      setSyncLoading(false);
    }
  });

  // Stash 操作
  const onStashSave = withStash(
    async (msg: string, includeUntracked: boolean, keepIndex?: boolean) => {
      const res = await api.stashSave(msg, includeUntracked, Boolean(keepIndex));
      showToast("info", res.stdout.trim() || "工作区变更已储藏");
    },
  );

  const onStashPop = withStash(async (index: number) => {
    const res = await api.stashPop(index);
    showToast("info", res.stdout.trim() || `已恢复 stash@{${index}}`);
    setSelectedStash(null);
  });

  const onStashApply = withStash(async (index: number) => {
    const res = await api.stashApply(index);
    showToast("info", res.stdout.trim() || `已应用 stash@{${index}}`);
  });

  const onStashDrop = withStash(async (index: number) => {
    const res = await api.stashDrop(index);
    showToast("info", res.stdout.trim() || `已丢弃 stash@{${index}}`);
    setSelectedStash(null);
  });

  const onStashClear = withStash(async () => {
    const res = await api.stashClear();
    showToast("info", res.stdout.trim() || "已清空所有 Stash 储藏记录");
    setSelectedStash(null);
  });

  const onStashBranch = withBranch(async (branchName: string, index: number) => {
    const res = await api.stashBranch(branchName, index);
    showToast(
      "info",
      res.stdout.trim() || `已基于储藏检出新分支 ${branchName}`,
    );
    setSelectedStash(null);
  });

  // 标签操作
  const onCreateTagSubmit = withTag(async () => {
    const name = newTagName.trim();
    if (!name) return;
    const target = newTagTargetOid.trim() || undefined;
    const msg = newTagMessage.trim() || undefined;
    await api.createTag(name, target, msg, newTagForce, newTagPushRemote);
    setCreatingTagModal({ open: false });
    showToast(
      "info",
      newTagPushRemote
        ? `已创建标签 "${name}" 并推送至远端`
        : `已创建标签 "${name}"`,
    );
  });

  const onDeleteTagSubmit = withTag(async () => {
    if (!deletingTagModal) return;
    const name = deletingTagModal.name;
    await api.deleteTag(name, deleteTagRemote);
    setDeletingTagModal(null);
    showToast(
      "info",
      deleteTagRemote
        ? `已删除本地标签 "${name}" 及其远程标签`
        : `已删除标签 "${name}"`,
    );
  });

  const onPushTag = withTag(async (tag: TagInfo) => {
    await api.pushTag(tag.name);
    showToast("info", `已将标签 "${tag.name}" 推送至远端`);
  });

  const onPushAllTags = withTag(async () => {
    await api.pushAllTags();
    showToast("info", "已将所有本地标签推送至远端");
  });

  const onCheckoutTag = withBranch(async (tag: TagInfo) => {
    await api.checkoutTag(tag.name);
    showToast("info", `已检出标签 "${tag.name}" (游离头指针状态)`);
  });

  const openBranchFromTagModal = useCallback((tag: TagInfo) => {
    setBranchingTagModal(tag);
    const safeName = tag.name.replace(/[^a-zA-Z0-9._-]/g, "-");
    setBranchFromTagInput(`branch-${safeName}`);
  }, []);

  const onBranchFromTagSubmit = withBranch(async () => {
    if (!branchingTagModal) return;
    const branchName = branchFromTagInput.trim();
    if (!branchName) return;
    await api.createBranch(branchName, branchingTagModal.target_oid);
    await api.checkoutBranch(branchName);
    setBranchingTagModal(null);
    showToast(
      "info",
      `已基于标签 "${branchingTagModal.name}" 创建并检出分支 "${branchName}"`,
    );
  });

  // 顶栏原生拖动与双击最大化控制
  const lastToggleMaximizeRef = useRef<number>(0);
  const handleToggleMaximize = useCallback(async () => {
    const now = Date.now();
    if (now - lastToggleMaximizeRef.current < 350) return;
    lastToggleMaximizeRef.current = now;
    try {
      await api.windowToggleMaximize();
    } catch {}
  }, []);

  const handleTitlebarMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // 仅在单数次初次点击（e.detail === 1）触发原生拖动，第2次双击点击由 onDoubleClick 统一处理，避免二者重复冲突
    if (e.detail === 1) {
      void api.windowStartDragging().catch(() => {});
    }
  }, []);

  // ---------------- 渲染 ----------------

  const selectedArea = workdirSelection?.area;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#1f1f1f] text-[#cccccc]">
      <header
        className="flex h-[35px] shrink-0 select-none items-center border-b border-[#2b2b2b] bg-[#181818] pl-2"
        data-tauri-drag-region
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            handleTitlebarMouseDown(e);
          }
        }}
        onDoubleClick={(e) => {
          if (e.target === e.currentTarget) {
            void handleToggleMaximize();
          }
        }}
      >
        {/* 顶部最左侧：仓库与项目管理中心图标及悬浮框 */}
        <div
          className="relative mr-1.5 flex items-center [-webkit-app-region:no-drag]"
          ref={reposDropdownRef}
        >
          <button
            type="button"
            className={`flex h-[26px] w-[28px] cursor-pointer items-center justify-center rounded border-none transition-colors ${
              reposDropdownOpen
                ? "bg-[#37373d] text-white"
                : "bg-transparent text-[#9d9d9d] hover:bg-[#2a2d2e] hover:text-white"
            }`}
            title="仓库与项目管理中心 (点击展开/收起)"
            onClick={() => {
              setReposDropdownOpen((prev) => {
                const next = !prev;
                if (next) void loadCatalog();
                return next;
              });
            }}
          >
            <FolderGit2 size={17} strokeWidth={1.75} />
          </button>
          {reposDropdownOpen && (
            <div
              className="fixed left-2 top-[38px] z-50 flex max-h-[calc(100vh-76px)] w-[380px] flex-col overflow-hidden rounded-[6px] border border-[#454545] bg-[#252526] shadow-[0_8px_28px_rgba(0,0,0,0.65)]"
              onClick={(e) => e.stopPropagation()}
            >
              <RepositoriesPanel
                catalog={catalog}
                loading={catalogLoading}
                activePath={status?.workdir ?? null}
                onOpenRepo={async (p) => {
                  setReposDropdownOpen(false);
                  await switchWorkspace(p);
                }}
                onRefresh={async () => {
                  await loadCatalog();
                }}
                onRenameRepo={onRenameCatalogRepo}
                onRemoveRepo={onRemoveCatalogRepo}
                onDeleteGroup={onDeleteCatalogGroup}
                onImportWorktrees={onImportWorktrees}
                onAddLocalRepo={async () => {
                  setReposDropdownOpen(false);
                  await openFolder();
                }}
              />
            </div>
          )}
        </div>

        <WorkspaceTabs
          workspaces={workspaces}
          activePath={status?.workdir ?? null}
          onSwitch={(p) => void switchWorkspace(p)}
          onClose={(p) => void closeWorkspace(p)}
          onCloseOthers={(p) => void closeOtherWorkspaces(p)}
          onRename={(p, alias, orig) =>
            setTabRenameModal({
              path: p,
              alias: alias ?? "",
              originalName: orig,
            })
          }
          onNew={() => void openFolder()}
        />

        <div
          className="h-full min-w-[48px] flex-1"
          data-tauri-drag-region
          onMouseDown={handleTitlebarMouseDown}
          onDoubleClick={() => void handleToggleMaximize()}
        />

        <button
          type="button"
          className="mr-2 flex h-[24px] cursor-pointer items-center gap-1.5 rounded-[5px] border border-[#3c3c3c] bg-[#242424] px-2.5 text-[11.5px] text-[#9d9d9d] transition-colors hover:border-[#4b4b4b] hover:bg-[#2d2d2d] hover:text-[#e5e5e5] [-webkit-app-region:no-drag]"
          onClick={() => setPaletteOpen(true)}
        >
          <CommandIcon size={13} strokeWidth={1.75} className="shrink-0" />
          <span>命令面板</span>
          <kbd className="ml-0.5 rounded-[3px] border border-[#3c3c3c] bg-[#181818] px-1 py-[1px] font-mono text-[10px] leading-none text-[#868686]">
            Ctrl+Shift+P
          </kbd>
        </button>

        <WindowControls />
      </header>

      {updater.bannerVisible && updater.info && (
        <UpdateBanner
          info={updater.info}
          status={updater.status}
          progress={updater.progress}
          onInstall={() => void updater.install()}
          onSkip={updater.skip}
          onDismiss={updater.dismiss}
        />
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* 左栏：图标功能导航（悬浮展示文字提示） */}
        <nav className="z-20 flex w-[48px] shrink-0 select-none flex-col items-center border-r border-[#2b2b2b] bg-[#181818] py-1">
          {NAV_ITEMS.map((item) => {
            const isActive = nav === item.id;
            const changesCount = status
              ? status.staged.length +
                status.unstaged.length +
                status.untracked.length
              : 0;
            const runningCount =
              item.id === "scripts"
                ? scriptRuns.filter((r) => r.status === "running").length
                : 0;
            const badge =
              item.id === "changes" && changesCount > 0
                ? {
                    text: changesCount > 999 ? "999+" : String(changesCount),
                    className: "bg-[#0078d4] text-white",
                    hint: `${item.label} (${changesCount} 项变更)`,
                  }
                : item.id === "scripts" && runningCount > 0
                  ? {
                      text: String(runningCount),
                      className: "bg-[#73c991] text-[#181818]",
                      hint: `${item.label} (${runningCount} 个运行中)`,
                    }
                  : null;
            const tooltipText = badge?.hint ?? item.label;
            return (
              <button
                key={item.id}
                type="button"
                className={`group relative flex h-[46px] w-full cursor-pointer items-center justify-center border-l-2 bg-transparent transition-colors ${
                  isActive
                    ? "border-l-[#0078d4] text-white"
                    : "border-l-transparent text-[#868686] hover:text-white"
                }`}
                title={tooltipText}
                onClick={() => {
                  setNav(item.id);
                  if (item.id === "search") {
                    setGlobalSearchFocusNonce((n) => n + 1);
                  } else if (
                    item.id === "history" ||
                    item.id === "stash" ||
                    item.id === "scripts"
                  ) {
                    setActiveTabId(null);
                  }
                }}
              >
                <span className="relative flex items-center justify-center">
                  {item.icon}
                  {badge && (
                    <span
                      className={`absolute -right-2.5 -top-1.5 flex h-[14px] min-w-[14px] items-center justify-center rounded-full px-1 text-[9px] font-bold leading-none tabular-nums shadow-[0_0_0_1.5px_#181818] ${badge.className}`}
                    >
                      {badge.text}
                    </span>
                  )}
                </span>
                <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 hidden -translate-y-1/2 whitespace-nowrap rounded-[3px] border border-[#454545] bg-[#252526] px-2 py-1 text-[11px] font-normal text-[#cccccc] shadow-[0_2px_8px_rgba(0,0,0,0.5)] group-hover:block">
                  {tooltipText}
                </span>
              </button>
            );
          })}
          <div className="flex-1" />
          <button
            type="button"
            className="group relative flex h-[46px] w-full cursor-pointer items-center justify-center border-l-2 border-l-transparent bg-transparent text-[#868686] transition-colors hover:text-white"
            title="打开仓库"
            onClick={() => void openFolder()}
          >
            <span className="flex items-center justify-center">
              <FolderOpen size={18} strokeWidth={1.75} />
            </span>
            <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 hidden -translate-y-1/2 whitespace-nowrap rounded-[3px] border border-[#454545] bg-[#252526] px-2 py-1 text-[11px] font-normal text-[#cccccc] shadow-[0_2px_8px_rgba(0,0,0,0.5)] group-hover:block">
              打开仓库
            </span>
          </button>
        </nav>

        {/* 侧栏面板 */}
        {status && nav === "history" && (
          <aside className="flex min-h-0 w-[320px] shrink-0 flex-col overflow-hidden border-r border-[#2b2b2b] bg-[#181818]">
            <CommitDetailSidebar
              detail={detail}
              loading={detailLoading}
              selectedPath={
                activeTab?.kind === "commit-diff" && activeTab.commitOid === (reviewingOid || detail?.oid)
                  ? activeTab.path
                  : selectedFile
              }
              onSelectFile={(path) => {
                const oid = reviewingOid || detail?.oid;
                if (!oid) return;
                const f = detail?.files.find((cf) => cf.path === path);
                openCommitDiffTab(
                  oid,
                  path,
                  f?.status,
                  detail?.parents?.[0],
                );
              }}
              onCreateTag={(oid) => openCreateTagModal(oid)}
            />
          </aside>
        )}
        {nav === "changes" && (
          <aside className="flex min-h-0 w-[320px] shrink-0 flex-col overflow-hidden border-r border-[#2b2b2b] bg-[#181818]">
            <SourceControlPanel
              status={status}
              loading={loading}
              selectedPath={
                activeTab?.kind === "workdir-diff"
                  ? activeTab.path
                  : (workdirSelection?.path ?? null)
              }
              onSelect={(p, a) => {
                const f = status
                  ? [
                      ...status.staged,
                      ...status.unstaged,
                      ...status.untracked,
                    ].find((item) => item.path === p)
                  : undefined;
                openWorkdirDiffTab(p, a, f?.status);
              }}
              onStageFile={(p) => void onStageFile(p)}
              onUnstageFile={(p) => void onUnstageFile(p)}
              onDiscardFile={(p, a) => void onDiscardFile(p, a)}
              onStagePaths={async (paths) => {
                await api.stagePaths(paths);
                await reloadAfterStaging();
              }}
              onUnstagePaths={async (paths) => {
                await api.unstagePaths(paths);
                await reloadAfterStaging();
              }}
              onDiscardPaths={async (paths) => {
                await api.discardPaths(paths);
                await reloadAfterStaging();
              }}
              onCleanUntrackedPaths={async (paths) => {
                await api.cleanUntrackedPaths(paths);
                await reloadAfterStaging();
              }}
              onDiscardAllUnstaged={async () => {
                await api.discardAllUnstaged();
                await reloadAfterStaging();
              }}
              onUnstageAll={async () => {
                await api.unstageAll();
                await reloadAfterStaging();
              }}
              onCleanAllUntracked={async () => {
                await api.cleanUntracked();
                await reloadAfterStaging();
              }}
              onCommit={(msg) => void doCommitWithMessage(msg)}
              onCommitAndPush={async (msg) => {
                await doCommitWithMessage(msg);
                await onPush();
              }}
              onAmend={(msg) => void doAmendWithMessage(msg)}
              onStageAllAndCommit={async (msg) => {
                await doStageAll();
                await doCommitWithMessage(msg);
              }}
              onStageAll={() => void doStageAll()}
              onRefresh={() => void refresh()}
              onPull={() => void onPull()}
              onPush={() => void onPush()}
              onFetch={() => void onFetch()}
              onSync={onSync}
              syncLoading={syncLoading}
              onOpenFolder={() => void openFolder()}
              onOpenFile={(p) => openPreviewTab(p)}
              onRevealInExplorer={(p) => void api.revealInExplorer(p)}
              onOpenTerminal={(p) => void api.openTerminal(p)}
              onAddToGitignore={async (p) => {
                await api.addToGitignore(p);
                showToast("info", `已添加 ${p} 至 .gitignore`);
                await reloadAfterStaging();
              }}
              onCopyPath={(text) => {
                void navigator.clipboard.writeText(text);
                showToast("info", "已复制路径至剪贴板");
              }}
            />
          </aside>
        )}
        {status && nav === "files" && (
          <aside className="flex min-h-0 w-[320px] shrink-0 flex-col overflow-hidden border-r border-[#2b2b2b] bg-[#181818]">
            <FileExplorerPanel
              workdir={repoPath}
              status={status}
              refreshSignal={explorerRefreshNonce}
              selectedPath={
                activeTab?.kind === "preview"
                  ? activeTab.path
                  : (selectedPreviewFile ?? null)
              }
              onSelectFile={(p) => openPreviewTab(p)}
              onOpenFileExternal={(p) => {
                if (!repoPath) return;
                const full = `${repoPath}/${p}`;
                void api.openFile(full);
              }}
              onRevealInExplorer={(p) => {
                if (!repoPath) return;
                const full = `${repoPath}/${p}`;
                void api.revealInExplorer(full);
              }}
              onCopyPath={(p) => {
                void navigator.clipboard.writeText(p);
                showToast("info", "已复制路径至剪贴板");
              }}
            />
          </aside>
        )}
        {nav === "search" && (
          <aside className="flex min-h-0 w-[320px] shrink-0 flex-col overflow-hidden border-r border-[#2b2b2b] bg-[#181818]">
            <GlobalSearchPanel
              workdir={repoPath}
              searchState={globalSearchState}
              onSearchStateChange={setGlobalSearchState}
              activePath={
                activeTab?.kind === "preview"
                  ? activeTab.path
                  : (selectedPreviewFile ?? null)
              }
              activeLine={
                activeTab?.kind === "preview" ? activeTab.targetLine : undefined
              }
              focusNonce={globalSearchFocusNonce}
              onSelectMatch={(p, line, column, highlight) =>
                openPreviewTab(p, {
                  targetLine: line,
                  targetColumn: column,
                  searchHighlight: highlight,
                })
              }
              onCopyPath={(p) => {
                void navigator.clipboard.writeText(p);
                showToast("info", "已复制路径至剪贴板");
              }}
            />
          </aside>
        )}
        {nav === "stash" && (
          <aside className="flex min-h-0 w-[320px] shrink-0 flex-col overflow-hidden border-r border-[#2b2b2b] bg-[#181818]">
            <StashPanel
              stashes={stashes}
              selectedStashOid={selectedStash?.oid ?? null}
              loading={stashesLoading}
              hasChanges={hasChanges}
              onRefresh={async () => {
                await loadStashes();
              }}
              onSelectStash={(s) => {
                setActiveTabId(null);
                void loadStashDetail(s);
              }}
              onSave={(msg, untracked, keepIdx) =>
                onStashSave(msg, untracked, keepIdx)
              }
              onClear={() => onStashClear()}
            />
          </aside>
        )}
        {nav === "scripts" && (
          <aside className="flex min-h-0 w-[320px] shrink-0 flex-col overflow-hidden border-r border-[#2b2b2b] bg-[#181818]">
            <ScriptsPanel
              workdir={repoPath}
              groups={scriptGroups}
              loading={scriptsLoading}
              runs={scriptRuns}
              activeRunId={activeRunId}
              onRefresh={() => void loadScripts()}
              onRunScript={(script) => void handleRunScript(script)}
              onStopRun={(runId) => void handleStopRun(runId)}
              onRestartScript={(script, prevId) =>
                void handleRestartScript(script, prevId)
              }
              onSelectRun={(runId) => {
                setActiveRunId(runId);
                setActiveTabId(null);
              }}
              onOpenConfigFile={(relPath) => openPreviewTab(relPath)}
              onOpenExternalTerminal={(cwdRel) => {
                if (!repoPath) return;
                const full = cwdRel === "." ? repoPath : `${repoPath}/${cwdRel}`;
                void api.openTerminal(full);
              }}
            />
          </aside>
        )}

        <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[#1f1f1f]">
          {!status ? (
            <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto bg-[#1f1f1f] px-8 py-10 text-center">
              <h1 className="m-0 text-[28px] font-semibold tracking-tight text-white">
                git-hunk
              </h1>
              <p className="mt-1.5 mb-5 text-[13px] text-[#9d9d9d]">
                以 Git 为中心的开发工具
              </p>
              <button
                type="button"
                className="cursor-pointer rounded-[3px] border border-[#0078d4] bg-[#0078d4] px-4 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:border-[#026ec1] hover:bg-[#026ec1]"
                onClick={() => void openFolder()}
              >
                打开本地仓库…
              </button>
              {catalog.length > 0 && (
                <div className="mt-8 w-full max-w-[780px] text-left">
                  <div className="mb-3 flex items-center justify-between text-[12px] font-semibold text-[#9d9d9d]">
                    <span>已管理的工作区与项目分组</span>
                    <button
                      type="button"
                      className="inline-flex cursor-pointer items-center gap-1 rounded-[3px] border border-transparent bg-transparent px-2 py-1 text-[11.5px] font-normal text-[#9d9d9d] transition-colors hover:bg-[#2a2d2e] hover:text-white"
                      onClick={() => {
                        void loadCatalog();
                        setReposDropdownOpen(true);
                      }}
                    >
                      <span>进入管理中心</span>
                      <FolderGit2 size={13} strokeWidth={1.75} />
                    </button>
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2.5">
                    {catalog.slice(0, 8).map((repo) => (
                      <div
                        key={repo.path}
                        className="group cursor-pointer rounded-[4px] border border-[#2b2b2b] bg-[#181818] p-3 transition-colors hover:border-[#454545] hover:bg-[#252526]"
                        onClick={() => void switchWorkspace(repo.path)}
                      >
                        <div className="flex items-center gap-2">
                          <span className="flex shrink-0 items-center text-[#9d9d9d] group-hover:text-[#cccccc]">
                            {repo.worktree_count > 1 ? (
                              <GitFork size={14} strokeWidth={1.75} />
                            ) : (
                              <Folder size={14} strokeWidth={1.75} />
                            )}
                          </span>
                          <span
                            className="min-w-0 flex-1 truncate text-[13px] font-medium text-[#cccccc] group-hover:text-white"
                            title={repo.display_name}
                          >
                            {repo.display_name}
                          </span>
                          <span className="shrink-0 rounded-[3px] border border-[#3c3c3c] bg-[#252526] px-1.5 py-[1px] text-[10.5px] text-[#9d9d9d]">
                            {repo.group}
                          </span>
                        </div>
                        <div
                          className="mt-1.5 truncate font-mono text-[11px] text-[#868686]"
                          title={repo.path}
                        >
                          {repo.path}
                        </div>
                        {repo.current_branch && (
                          <div className="mt-1.5 inline-flex items-center gap-1 font-mono text-[11px] text-[#73c991]">
                            <GitBranch size={12} strokeWidth={1.75} />
                            <span>{repo.current_branch}</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <p className="mt-7 text-[12px] text-[#868686]">
                打开后默认显示文件目录；提交历史、工作区变更、diff、分支、脚本都可随时切换
              </p>
            </div>
          ) : (
            <>
              {/* VS Code 风格全局多标签页栏与层级面包屑 */}
              <EditorTabBar
                tabs={tabs}
                activeTabId={activeTabId}
                showGraphAction={activeTab !== null && nav === "history"}
                onShowGraph={() => setActiveTabId(null)}
                onSelectTab={setActiveTabId}
                onCloseTab={closeTab}
                onCloseOtherTabs={closeOtherTabs}
                onCloseTabsToRight={closeTabsToRight}
                onCloseAllTabs={closeAllTabs}
                onCopyPath={(p) => {
                  void navigator.clipboard.writeText(p);
                  showToast("info", "已复制路径至剪贴板");
                }}
                onRevealInExplorer={(p) => {
                  if (!repoPath) return;
                  void api.revealInExplorer(`${repoPath}/${p}`);
                }}
              />

              {activeTab ? (
                activeTab.kind === "preview" ? (
                  <FilePreviewPage
                    key={activeTab.id}
                    path={activeTab.path}
                    activeTab={activeTab}
                    workdir={repoPath}
                    onOpenFileExternal={(p) => {
                      if (!repoPath) return;
                      const full = `${repoPath}/${p}`;
                      void api.openFile(full);
                    }}
                    onRevealInExplorer={(p) => {
                      if (!repoPath) return;
                      const full = `${repoPath}/${p}`;
                      void api.revealInExplorer(full);
                    }}
                    onShowToast={showToast}
                  />
                ) : activeTab.kind === "workdir-diff" ? (
                  <SideBySideDiff
                    key={activeTab.id}
                    pair={tabPairs[activeTab.id] ?? (workdirPair?.path === activeTab.path ? workdirPair : null)}
                    loading={!!tabLoadingMap[activeTab.id] || (diffLoading && !tabPairs[activeTab.id])}
                    area={activeTab.workdirArea || selectedArea}
                    activeTab={activeTab}
                    workdir={repoPath}
                    onStageHunk={
                      (activeTab.workdirArea || selectedArea) === "unstaged"
                        ? (i) => void onStageHunk(i)
                        : undefined
                    }
                    onUnstageHunk={
                      (activeTab.workdirArea || selectedArea) === "staged"
                        ? (i) => void onUnstageHunk(i)
                        : undefined
                    }
                    onDiscardHunk={
                      (activeTab.workdirArea || selectedArea) === "unstaged"
                        ? (i) => void onDiscardHunk(i)
                        : undefined
                    }
                    onStageFile={
                      (activeTab.workdirArea || selectedArea) === "unstaged"
                        ? () => void onStageFile(activeTab.path)
                        : undefined
                    }
                    onUnstageFile={
                      (activeTab.workdirArea || selectedArea) === "staged"
                        ? () => void onUnstageFile(activeTab.path)
                        : undefined
                    }
                    onDiscardFile={
                      (activeTab.workdirArea || selectedArea) === "unstaged"
                        ? () => void onDiscardFile(activeTab.path, "unstaged")
                        : undefined
                    }
                    onPrevFile={onPrevFile}
                    onNextFile={onNextFile}
                    hasPrevFile={hasPrevFile}
                    hasNextFile={hasNextFile}
                    onOpenFile={() => openPreviewTab(activeTab.path)}
                    onRevealInExplorer={(p) => {
                      if (!repoPath) return;
                      void api.revealInExplorer(`${repoPath}/${p}`);
                    }}
                    onCopyPath={() => {
                      void navigator.clipboard.writeText(activeTab.path);
                      showToast("info", "已复制路径至剪贴板");
                    }}
                  />
                ) : activeTab.kind === "commit-diff" ? (
                  <SideBySideDiff
                    key={activeTab.id}
                    pair={tabPairs[activeTab.id] ?? null}
                    loading={!!tabLoadingMap[activeTab.id]}
                    activeTab={activeTab}
                    workdir={repoPath}
                    onOpenFile={() => openPreviewTab(activeTab.path)}
                    onRevealInExplorer={(p) => {
                      if (!repoPath) return;
                      void api.revealInExplorer(`${repoPath}/${p}`);
                    }}
                    onCopyPath={() => {
                      void navigator.clipboard.writeText(activeTab.path);
                      showToast("info", "已复制路径至剪贴板");
                    }}
                  />
                ) : activeTab.kind === "stash-diff" ? (
                  <SideBySideDiff
                    key={activeTab.id}
                    pair={tabPairs[activeTab.id] ?? null}
                    loading={!!tabLoadingMap[activeTab.id]}
                    activeTab={activeTab}
                    workdir={repoPath}
                    onOpenFile={() => openPreviewTab(activeTab.path)}
                    onRevealInExplorer={(p) => {
                      if (!repoPath) return;
                      void api.revealInExplorer(`${repoPath}/${p}`);
                    }}
                    onCopyPath={() => {
                      void navigator.clipboard.writeText(activeTab.path);
                      showToast("info", "已复制路径至剪贴板");
                    }}
                  />
                ) : null
              ) : (
                /* 当没有任何激活标签时，根据左侧导航呈现对应全景视图 */
                nav === "stash" ? (
                  <StashReviewPage
                    stash={selectedStash}
                    detail={stashDetail}
                    detailLoading={stashDetailLoading}
                    pair={stashPair}
                    pairLoading={stashPairLoading}
                    selectedPath={selectedStashFile}
                    onSelectFile={(path) => {
                      if (selectedStash) {
                        const f = stashDetail?.files.find((sf) => sf.path === path);
                        openStashDiffTab(
                          selectedStash.index,
                          selectedStash.oid,
                          path,
                          f?.status,
                        );
                      }
                    }}
                    onPop={(i) => void onStashPop(i)}
                    onApply={(i) => void onStashApply(i)}
                    onDrop={(s) => setDeletingStashModal(s)}
                    onBranch={(s) => {
                      setBranchingStash(s);
                      setStashBranchInput(`stash-${s.index}`);
                    }}
                  />
                ) : nav === "files" ? (
                  <FilePreviewPage
                    path={null}
                    onOpenFileExternal={(p) => {
                      if (!repoPath) return;
                      void api.openFile(`${repoPath}/${p}`);
                    }}
                    onRevealInExplorer={(p) => {
                      if (!repoPath) return;
                      void api.revealInExplorer(`${repoPath}/${p}`);
                    }}
                    onShowToast={showToast}
                  />
                ) : nav === "search" ? (
                  <div className="flex flex-1 select-none flex-col items-center justify-center bg-[#1f1f1f] px-6 text-center">
                    <Search
                      size={42}
                      className="mb-3 text-[#868686] opacity-55"
                    />
                    <h3 className="m-0 mb-1.5 text-[14px] font-medium text-[#cccccc]">
                      全局文件内容搜索
                    </h3>
                    <p className="m-0 max-w-[360px] text-[12px] leading-relaxed text-[#868686]">
                      在左侧输入关键词或正则表达式检索全仓库文件内容（Ctrl+Shift+F），点击命中行即可直接打开预览并定位到目标代码行。
                    </p>
                  </div>
                ) : nav === "scripts" ? (
                  <ScriptRunnerConsole
                    runs={scriptRuns}
                    activeRunId={activeRunId}
                    quickScripts={scriptGroups.flatMap((g) => g.scripts)}
                    onSelectRun={setActiveRunId}
                    onStopRun={(runId) => void handleStopRun(runId)}
                    onRestartRun={(run) =>
                      void handleRestartScript(
                        run.script,
                        run.status === "running" ? run.run_id : undefined,
                      )
                    }
                    onClearLogs={handleClearScriptLogs}
                    onCloseRunTab={handleCloseScriptRunTab}
                    onRunQuickScript={(s) => void handleRunScript(s)}
                  />
                ) : nav === "changes" ? (
                  <div className="flex flex-1 select-none flex-col items-center justify-center bg-[#1f1f1f] px-6 text-center">
                    <FileDiff
                      size={42}
                      className="mb-3 text-[#868686] opacity-55"
                    />
                    <h3 className="m-0 mb-1.5 text-[14px] font-medium text-[#cccccc]">
                      工作区对比
                    </h3>
                    <p className="m-0 text-[12px] text-[#868686]">
                      请在左侧变更列表中选择文件以开启对比标签页
                    </p>
                  </div>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#1f1f1f]">
                    {/* 提交图顶部过滤与分支/标签工具栏 */}
                    <div className="flex h-[34px] shrink-0 items-center justify-between gap-2 border-b border-[#2b2b2b] bg-[#181818] px-3">
                      <div className="flex min-w-0 items-center gap-1.5">
                        {/* 分支范围下拉选择器 */}
                        <div className="relative" ref={historyScopeRef}>
                          <button
                            type="button"
                            className={`flex h-[24px] cursor-pointer items-center gap-1.5 rounded-[3px] border px-2 text-[11.5px] transition-colors ${
                              historyScopeOpen
                                ? "border-[#505050] bg-[#313131] text-white"
                                : "border-[#3c3c3c] bg-[#252526] text-[#cccccc] hover:border-[#505050] hover:bg-[#2a2d2e] hover:text-white"
                            }`}
                            title="筛选提交历史的分支范围"
                            onClick={() => {
                              setTagsPopoverOpen(false);
                              setHistoryScopeOpen((v) => !v);
                            }}
                          >
                            {historyBranchScope === "__ALL__" ? (
                              <Globe size={13} className="shrink-0 text-[#868686]" />
                            ) : (
                              <GitBranch size={13} className="shrink-0 text-[#868686]" />
                            )}
                            <span className="max-w-[200px] truncate">{historyScopeLabel}</span>
                            <ChevronDown size={12} className="shrink-0 text-[#868686]" />
                          </button>

                          {historyScopeOpen && (
                            <div className="absolute left-0 top-full z-40 mt-1 flex max-h-[420px] w-[300px] flex-col overflow-hidden rounded-[6px] border border-[#454545] bg-[#252526] text-[#cccccc] shadow-[0_12px_32px_rgba(0,0,0,0.65)]">
                              <div className="border-b border-[#2b2b2b] p-1.5">
                                <input
                                  type="text"
                                  autoFocus
                                  value={historyScopeQuery}
                                  onChange={(e) => setHistoryScopeQuery(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Escape") {
                                      e.stopPropagation();
                                      setHistoryScopeOpen(false);
                                    }
                                  }}
                                  placeholder="筛选分支范围…"
                                  className="w-full rounded-[3px] border border-[#3c3c3c] bg-[#313131] px-2 py-1 text-[11.5px] text-[#cccccc] placeholder:text-[#868686] focus:border-[#0078d4] focus:outline-none"
                                />
                              </div>
                              <div className="min-h-0 flex-1 overflow-y-auto py-1">
                                <button
                                  type="button"
                                  className={`flex w-full cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-[#2a2d2e] ${
                                    historyBranchScope === "HEAD"
                                      ? "bg-[#04395e]/60 text-white"
                                      : "text-[#cccccc]"
                                  }`}
                                  onClick={() => void handleSelectHistoryScope("HEAD")}
                                >
                                  <span className="flex min-w-0 items-center gap-1.5">
                                    <GitBranch size={12} className="shrink-0 text-[#868686]" />
                                    <span className="truncate">
                                      当前分支{status?.branch ? ` (${status.branch})` : " (HEAD)"}
                                    </span>
                                  </span>
                                  {historyBranchScope === "HEAD" && (
                                    <Check size={12} className="shrink-0 text-[#4ec9b0]" />
                                  )}
                                </button>
                                <button
                                  type="button"
                                  className={`flex w-full cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-[#2a2d2e] ${
                                    historyBranchScope === "__ALL__"
                                      ? "bg-[#04395e]/60 text-white"
                                      : "text-[#cccccc]"
                                  }`}
                                  onClick={() => void handleSelectHistoryScope("__ALL__")}
                                >
                                  <span className="flex min-w-0 items-center gap-1.5">
                                    <Globe size={12} className="shrink-0 text-[#868686]" />
                                    <span className="truncate">全部分支 (本地 + 远程)</span>
                                  </span>
                                  {historyBranchScope === "__ALL__" && (
                                    <Check size={12} className="shrink-0 text-[#4ec9b0]" />
                                  )}
                                </button>

                                {scopeBranches.local.length > 0 && (
                                  <>
                                    <div className="mt-1 px-2.5 py-1 text-[10.5px] font-medium text-[#868686]">
                                      本地分支 ({scopeBranches.local.length})
                                    </div>
                                    {scopeBranches.local.map((b) => {
                                      const active = historyBranchScope === b.name;
                                      return (
                                        <button
                                          key={`local-${b.name}`}
                                          type="button"
                                          className={`flex w-full cursor-pointer items-center justify-between gap-2 px-2.5 py-1 text-left text-[12px] transition-colors hover:bg-[#2a2d2e] ${
                                            active ? "bg-[#04395e]/60 text-white" : "text-[#cccccc]"
                                          }`}
                                          onClick={() => void handleSelectHistoryScope(b.name)}
                                        >
                                          <span className="flex min-w-0 items-center gap-1.5">
                                            <GitBranch size={12} className="shrink-0 text-[#868686]" />
                                            <span className="truncate font-mono text-[11.5px]">{b.name}</span>
                                          </span>
                                          {active && (
                                            <Check size={12} className="shrink-0 text-[#4ec9b0]" />
                                          )}
                                        </button>
                                      );
                                    })}
                                  </>
                                )}

                                {scopeBranches.remote.length > 0 && (
                                  <>
                                    <div className="mt-1 px-2.5 py-1 text-[10.5px] font-medium text-[#868686]">
                                      远程分支 ({scopeBranches.remote.length})
                                    </div>
                                    {scopeBranches.remote.map((b) => {
                                      const active = historyBranchScope === b.name;
                                      return (
                                        <button
                                          key={`remote-${b.name}`}
                                          type="button"
                                          className={`flex w-full cursor-pointer items-center justify-between gap-2 px-2.5 py-1 text-left text-[12px] transition-colors hover:bg-[#2a2d2e] ${
                                            active ? "bg-[#04395e]/60 text-white" : "text-[#cccccc]"
                                          }`}
                                          onClick={() => void handleSelectHistoryScope(b.name)}
                                        >
                                          <span className="flex min-w-0 items-center gap-1.5">
                                            <Globe size={12} className="shrink-0 text-[#868686]" />
                                            <span className="truncate font-mono text-[11.5px]">{b.name}</span>
                                          </span>
                                          {active && (
                                            <Check size={12} className="shrink-0 text-[#4ec9b0]" />
                                          )}
                                        </button>
                                      );
                                    })}
                                  </>
                                )}
                              </div>
                            </div>
                          )}
                        </div>

                        {/* 分支管理弹窗入口 */}
                        <button
                          type="button"
                          className="flex h-[24px] cursor-pointer items-center gap-1.5 rounded-[3px] border border-[#3c3c3c] bg-[#252526] px-2 text-[11.5px] text-[#cccccc] transition-colors hover:border-[#505050] hover:bg-[#2a2d2e] hover:text-white"
                          title="切换、新建、重命名或删除分支 (Ctrl+B)"
                          onClick={() => {
                            setHistoryScopeOpen(false);
                            setTagsPopoverOpen(false);
                            setBranchQuickPickOpen(true);
                            void loadBranches();
                          }}
                        >
                          <GitBranch size={13} className="shrink-0 text-[#868686]" />
                          <span>分支</span>
                          <span className="rounded-full bg-[#333333] px-1.5 py-px text-[10px] tabular-nums text-[#9d9d9d]">
                            {branches.length}
                          </span>
                        </button>

                        {/* 标签管理浮层入口 */}
                        <div className="relative" ref={tagsPopoverRef}>
                          <button
                            type="button"
                            className={`flex h-[24px] cursor-pointer items-center gap-1.5 rounded-[3px] border px-2 text-[11.5px] transition-colors ${
                              tagsPopoverOpen
                                ? "border-[#505050] bg-[#313131] text-white"
                                : "border-[#3c3c3c] bg-[#252526] text-[#cccccc] hover:border-[#505050] hover:bg-[#2a2d2e] hover:text-white"
                            }`}
                            title="查看与管理 Git 标签"
                            onClick={() => {
                              setHistoryScopeOpen(false);
                              setTagsPopoverOpen((v) => {
                                const next = !v;
                                if (next) void loadTags();
                                return next;
                              });
                            }}
                          >
                            <Tag size={13} className="shrink-0 text-[#868686]" />
                            <span>标签</span>
                            <span className="rounded-full bg-[#333333] px-1.5 py-px text-[10px] tabular-nums text-[#9d9d9d]">
                              {tags.length}
                            </span>
                          </button>

                          {tagsPopoverOpen && (
                            <div className="absolute left-0 top-full z-40 mt-1 flex h-[460px] max-h-[calc(100vh-120px)] w-[340px] flex-col overflow-hidden rounded-[6px] border border-[#454545] bg-[#252526] shadow-[0_12px_32px_rgba(0,0,0,0.65)]">
                              <TagsPanel
                                tags={tags}
                                loading={tagsLoading}
                                onRefresh={async () => {
                                  await loadTags();
                                }}
                                onRequestCreateTag={() => {
                                  setTagsPopoverOpen(false);
                                  openCreateTagModal();
                                }}
                                onRequestDeleteTag={(tag) => {
                                  setTagsPopoverOpen(false);
                                  setDeletingTagModal(tag);
                                  setDeleteTagRemote(false);
                                }}
                                onRequestBranchFromTag={(tag) => {
                                  setTagsPopoverOpen(false);
                                  openBranchFromTagModal(tag);
                                }}
                                onPushTag={(tag) => onPushTag(tag)}
                                onPushAllTags={() => onPushAllTags()}
                                onCheckoutTag={(tag) => onCheckoutTag(tag)}
                                onSelectCommit={(oid) => {
                                  setTagsPopoverOpen(false);
                                  setActiveTabId(null);
                                  void loadCommitDetail(oid, false);
                                }}
                              />
                            </div>
                          )}
                        </div>
                      </div>

                      {/* 右侧：提交筛选输入框 + 刷新按钮 */}
                      <div className="flex shrink-0 items-center gap-1.5">
                        <div className="relative flex w-[225px] items-center">
                          <Search
                            size={12}
                            className="pointer-events-none absolute left-2 text-[#868686]"
                          />
                          <input
                            type="text"
                            value={historyFilterQuery}
                            onChange={(e) => {
                              const next = e.target.value;
                              setHistoryFilterQuery(next);
                              scheduleHistorySearch(next);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                void runHistorySearch(historyFilterQuery);
                              } else if (
                                e.key === "Escape" &&
                                (historyFilterQuery || appliedHistoryQuery)
                              ) {
                                e.stopPropagation();
                                setHistoryFilterQuery("");
                                void runHistorySearch("");
                              }
                            }}
                            placeholder="搜索提交、作者或哈希（Enter 立即）…"
                            className="h-[24px] w-full rounded-[3px] border border-[#3c3c3c] bg-[#313131] pl-6 pr-10 text-[11.5px] text-[#cccccc] placeholder:text-[#868686] focus:border-[#0078d4] focus:outline-none"
                          />
                          {(isHistoryDebouncePending ||
                            (historyLoading && Boolean(appliedHistoryQuery))) && (
                            <RefreshCw
                              size={11}
                              className="pointer-events-none absolute right-6 animate-spin text-[#868686]"
                            />
                          )}
                          {(historyFilterQuery || appliedHistoryQuery) && (
                            <button
                              type="button"
                              aria-label="清空筛选"
                              title="清空筛选"
                              className="absolute right-1.5 flex h-[16px] w-[16px] cursor-pointer items-center justify-center rounded-[2px] border-0 bg-transparent text-[#868686] hover:bg-[#3c3c3c] hover:text-white"
                              onClick={() => {
                                setHistoryFilterQuery("");
                                void runHistorySearch("");
                              }}
                            >
                              <X size={11} />
                            </button>
                          )}
                        </div>
                        {appliedHistoryQuery && (
                          <span className="text-[11px] tabular-nums text-[#868686]">
                            命中 {commits.length}
                            {hasMore ? "+" : ""} 条
                          </span>
                        )}
                        <IconButton
                          tooltip="刷新提交历史"
                          size="sm"
                          variant="ghost"
                          disabled={historyLoading}
                          onClick={() => void loadHistory(0, false)}
                          icon={
                            <RefreshCw
                              size={13}
                              className={historyLoading ? "animate-spin" : ""}
                            />
                          }
                        />
                      </div>
                    </div>

                    <CommitGraph
                      key={status.workdir}
                      commits={commits}
                      laneCount={laneCount}
                      selectedOid={selectedOid}
                      loading={historyLoading}
                      hasMore={hasMore}
                      searchQuery={appliedHistoryQuery}
                      initialScrollTop={graphScrollTopRef.current}
                      onScrollTopChange={(top) => {
                        graphScrollTopRef.current = top;
                      }}
                      onSelect={(oid) => void loadCommitDetail(oid, false)}
                      onDoubleClick={(oid) => void loadCommitDetail(oid, true)}
                      onLoadMore={() => void loadHistory(commits.length, true)}
                    />
                  </div>
                )
              )}
            </>
          )}
        </section>
      </div>

      <BranchQuickPick
        open={branchQuickPickOpen}
        branches={branches}
        currentBranch={status?.branch ?? null}
        loading={branchesLoading}
        onClose={() => setBranchQuickPickOpen(false)}
        onRefresh={async () => {
          await loadBranches();
        }}
        onCheckout={(name) => onCheckoutBranch(name)}
        onCreateBranch={(name, co) => onCreateBranch(name, co)}
        onCreateAndCheckout={(name) => onCreateBranch(name, true)}
        onRenameBranch={(oldName, newName) => onRenameBranch(oldName, newName)}
        onDeleteBranch={(name, force, deleteRemote) =>
          onDeleteBranch(name, force, deleteRemote)
        }
      />

      <CommandPalette
        open={paletteOpen}
        registry={registry}
        ctx={ctx}
        onClose={() => setPaletteOpen(false)}
        onError={(m) => showToast("error", m)}
      />

      {/* Tab 右键重命名别名弹窗 */}
      {tabRenameModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[1px]"
          onClick={() => setTabRenameModal(null)}
        >
          <div
            className="w-[440px] max-w-[92vw] rounded-[6px] border border-[#454545] bg-[#252526] p-5 text-[#cccccc] shadow-[0_12px_36px_rgba(0,0,0,0.65)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 text-[14px] font-semibold text-white">
              重命名工作区别名
            </div>
            <p className="mb-3 text-[12.5px] leading-relaxed text-[#9d9d9d]">
              自定义在顶栏 Tab 和仓库列表中显示的名称。
            </p>
            <div className="mb-3 flex flex-col gap-1.5">
              <label className="text-[12px] font-medium text-[#9d9d9d]">
                原始目录名
              </label>
              <input
                type="text"
                disabled
                className="h-[28px] rounded-[3px] border border-[#3c3c3c] bg-[#1f1f1f] px-2.5 text-[12.5px] text-[#868686] outline-none disabled:cursor-not-allowed"
                value={tabRenameModal.originalName}
              />
            </div>
            <div className="mb-3 flex flex-col gap-1.5">
              <label className="text-[12px] font-medium text-[#9d9d9d]">
                显示别名 (留空恢复为原始目录名)
              </label>
              <input
                type="text"
                autoFocus
                className="h-[28px] rounded-[3px] border border-[#3c3c3c] bg-[#313131] px-2.5 text-[12.5px] text-[#cccccc] placeholder-[#868686] outline-none transition-colors focus:border-[#0078d4]"
                placeholder={tabRenameModal.originalName}
                value={tabRenameModal.alias}
                onChange={(e) =>
                  setTabRenameModal({
                    ...tabRenameModal,
                    alias: e.target.value,
                  })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void onRenameCatalogRepo(
                      tabRenameModal.path,
                      tabRenameModal.alias.trim() || null,
                    );
                    setTabRenameModal(null);
                  }
                  if (e.key === "Escape") setTabRenameModal(null);
                }}
              />
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="cursor-pointer rounded-[3px] border border-[#3c3c3c] bg-[#313131] px-3 py-1.5 text-[12px] text-[#cccccc] transition-colors hover:bg-[#3c3c3c] hover:text-white"
                onClick={() => setTabRenameModal(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="cursor-pointer rounded-[3px] border border-[#0078d4] bg-[#0078d4] px-3.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:border-[#026ec1] hover:bg-[#026ec1]"
                onClick={() => {
                  void onRenameCatalogRepo(
                    tabRenameModal.path,
                    tabRenameModal.alias.trim() || null,
                  );
                  setTabRenameModal(null);
                }}
              >
                保存别名
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 基于 Stash 检出新分支弹窗 */}
      {branchingStash && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[1px]"
          onClick={() => setBranchingStash(null)}
        >
          <div
            className="w-[440px] max-w-[92vw] rounded-[6px] border border-[#454545] bg-[#252526] p-5 text-[#cccccc] shadow-[0_12px_36px_rgba(0,0,0,0.65)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 text-[14px] font-semibold text-white">
              基于储藏检出新分支
            </div>
            <p className="mb-3 text-[12.5px] leading-relaxed text-[#9d9d9d]">
              将以 <strong className="text-white">stash@{`{${branchingStash.index}}`}</strong> 所保存的基底提交创建并切换到新分支，自动应用该储藏并将其安全移出储藏栈：
            </p>
            <div className="mb-3 flex flex-col gap-1.5">
              <label className="text-[12px] font-medium text-[#9d9d9d]">
                新分支名称
              </label>
              <input
                autoFocus
                type="text"
                className="h-[28px] rounded-[3px] border border-[#3c3c3c] bg-[#313131] px-2.5 text-[12.5px] text-[#cccccc] placeholder-[#868686] outline-none transition-colors focus:border-[#0078d4]"
                placeholder="例如 feature/restore-wip"
                value={stashBranchInput}
                onChange={(e) => setStashBranchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && stashBranchInput.trim()) {
                    const b = stashBranchInput.trim();
                    const idx = branchingStash.index;
                    setBranchingStash(null);
                    setStashBranchInput("");
                    void onStashBranch(b, idx);
                  }
                  if (e.key === "Escape") setBranchingStash(null);
                }}
              />
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="cursor-pointer rounded-[3px] border border-[#3c3c3c] bg-[#313131] px-3 py-1.5 text-[12px] text-[#cccccc] transition-colors hover:bg-[#3c3c3c] hover:text-white"
                onClick={() => setBranchingStash(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="cursor-pointer rounded-[3px] border border-[#0078d4] bg-[#0078d4] px-3.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:border-[#026ec1] hover:bg-[#026ec1] disabled:cursor-not-allowed disabled:opacity-45"
                disabled={!stashBranchInput.trim()}
                onClick={() => {
                  const b = stashBranchInput.trim();
                  const idx = branchingStash.index;
                  setBranchingStash(null);
                  setStashBranchInput("");
                  void onStashBranch(b, idx);
                }}
              >
                创建并检出分支
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 丢弃单个 Stash 确认弹窗 */}
      {deletingStashModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[1px]"
          onClick={() => setDeletingStashModal(null)}
        >
          <div
            className="w-[440px] max-w-[92vw] rounded-[6px] border border-[#454545] bg-[#252526] p-5 text-[#cccccc] shadow-[0_12px_36px_rgba(0,0,0,0.65)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 text-[14px] font-semibold text-white">
              丢弃储藏记录
            </div>
            <p className="mb-2 text-[12.5px] leading-relaxed text-[#cccccc]">
              确定要永久丢弃 <strong className="text-white">stash@{`{${deletingStashModal.index}}`}</strong> 吗？
            </p>
            <p className="mb-3 text-[12px] leading-relaxed text-[#9d9d9d]">
              说明：{deletingStashModal.message || "（无说明）"}
              <br />
              此操作将直接从储藏栈中清除该快照且<strong className="text-[#f48771]">不可撤销</strong>。
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="cursor-pointer rounded-[3px] border border-[#3c3c3c] bg-[#313131] px-3 py-1.5 text-[12px] text-[#cccccc] transition-colors hover:bg-[#3c3c3c] hover:text-white"
                onClick={() => setDeletingStashModal(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="cursor-pointer rounded-[3px] border border-[#c74e39] bg-[#c74e39] px-3.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:border-[#f14c4c] hover:bg-[#f14c4c]"
                onClick={async () => {
                  const idx = deletingStashModal.index;
                  setDeletingStashModal(null);
                  await onStashDrop(idx);
                }}
              >
                确定丢弃 (Drop)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 新建标签弹窗 */}
      {creatingTagModal.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[1px]"
          onClick={() => setCreatingTagModal({ open: false })}
        >
          <div
            className="w-[440px] max-w-[92vw] rounded-[6px] border border-[#454545] bg-[#252526] p-5 text-[#cccccc] shadow-[0_12px_36px_rgba(0,0,0,0.65)]"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setCreatingTagModal({ open: false });
            }}
          >
            <div className="mb-3 text-[14px] font-semibold text-white">
              新建标签 (Tag)
            </div>
            <div className="mb-3 flex flex-col gap-1.5">
              <label className="text-[12px] font-medium text-[#9d9d9d]">
                标签名称 *
              </label>
              <input
                autoFocus
                type="text"
                className="h-[28px] rounded-[3px] border border-[#3c3c3c] bg-[#313131] px-2.5 text-[12.5px] text-[#cccccc] placeholder-[#868686] outline-none transition-colors focus:border-[#0078d4]"
                placeholder="例如: v1.0.0 或 release/v2.1"
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newTagName.trim()) {
                    void onCreateTagSubmit();
                  }
                }}
              />
            </div>
            <div className="mb-3 flex flex-col gap-1.5">
              <label className="text-[12px] font-medium text-[#9d9d9d]">
                目标提交 (可选，留空默认当前 HEAD)
              </label>
              <input
                type="text"
                className="h-[28px] rounded-[3px] border border-[#3c3c3c] bg-[#313131] px-2.5 text-[12.5px] text-[#cccccc] placeholder-[#868686] outline-none transition-colors focus:border-[#0078d4]"
                placeholder="Commit SHA 或留空"
                value={newTagTargetOid}
                onChange={(e) => setNewTagTargetOid(e.target.value)}
              />
            </div>
            <div className="mb-3 flex flex-col gap-1.5">
              <label className="text-[12px] font-medium text-[#9d9d9d]">
                附注说明 (可选，填写即创建附注标签，留空创建轻量标签)
              </label>
              <textarea
                rows={3}
                className="resize-y rounded-[3px] border border-[#3c3c3c] bg-[#313131] px-2.5 py-1.5 text-[12px] text-[#cccccc] placeholder-[#868686] outline-none transition-colors focus:border-[#0078d4]"
                placeholder="输入标签附注信息..."
                value={newTagMessage}
                onChange={(e) => setNewTagMessage(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="flex cursor-pointer select-none items-center gap-2 text-[12px] text-[#cccccc] [&_input]:accent-[#0078d4]">
                <input
                  type="checkbox"
                  checked={newTagPushRemote}
                  onChange={(e) => setNewTagPushRemote(e.target.checked)}
                />
                <span>创建后立即推送至远端 (git push origin &lt;tag&gt;)</span>
              </label>
              <label className="flex cursor-pointer select-none items-center gap-2 text-[12px] text-[#cccccc] [&_input]:accent-[#0078d4]">
                <input
                  type="checkbox"
                  checked={newTagForce}
                  onChange={(e) => setNewTagForce(e.target.checked)}
                />
                <span>覆盖已有同名标签 (--force)</span>
              </label>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="cursor-pointer rounded-[3px] border border-[#3c3c3c] bg-[#313131] px-3 py-1.5 text-[12px] text-[#cccccc] transition-colors hover:bg-[#3c3c3c] hover:text-white"
                onClick={() => setCreatingTagModal({ open: false })}
              >
                取消
              </button>
              <button
                type="button"
                className="cursor-pointer rounded-[3px] border border-[#0078d4] bg-[#0078d4] px-3.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:border-[#026ec1] hover:bg-[#026ec1] disabled:cursor-not-allowed disabled:opacity-45"
                disabled={!newTagName.trim()}
                onClick={() => void onCreateTagSubmit()}
              >
                确定创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除标签二次确认弹窗 */}
      {deletingTagModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[1px]"
          onClick={() => setDeletingTagModal(null)}
        >
          <div
            className="w-[440px] max-w-[92vw] rounded-[6px] border border-[#454545] bg-[#252526] p-5 text-[#cccccc] shadow-[0_12px_36px_rgba(0,0,0,0.65)]"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setDeletingTagModal(null);
            }}
          >
            <div className="mb-2 text-[14px] font-semibold text-white">
              删除标签
            </div>
            <p className="mb-2 text-[12.5px] leading-relaxed text-[#cccccc]">
              确定要删除标签 <strong className="text-white">"{deletingTagModal.name}"</strong> 吗？
            </p>
            <p className="mb-3 text-[12px] leading-relaxed text-[#9d9d9d]">
              关联提交: {deletingTagModal.target_summary || deletingTagModal.target_oid.slice(0, 7)}
            </p>
            <label className="flex cursor-pointer select-none items-center gap-2 text-[12px] text-[#cccccc] [&_input]:accent-[#0078d4]">
              <input
                type="checkbox"
                checked={deleteTagRemote}
                onChange={(e) => setDeleteTagRemote(e.target.checked)}
              />
              <span>同时删除对应的远程标签 (git push --delete)</span>
            </label>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="cursor-pointer rounded-[3px] border border-[#3c3c3c] bg-[#313131] px-3 py-1.5 text-[12px] text-[#cccccc] transition-colors hover:bg-[#3c3c3c] hover:text-white"
                onClick={() => setDeletingTagModal(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="cursor-pointer rounded-[3px] border border-[#c74e39] bg-[#c74e39] px-3.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:border-[#f14c4c] hover:bg-[#f14c4c]"
                onClick={() => void onDeleteTagSubmit()}
              >
                确定删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 基于标签检出新分支弹窗 */}
      {branchingTagModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[1px]"
          onClick={() => setBranchingTagModal(null)}
        >
          <div
            className="w-[440px] max-w-[92vw] rounded-[6px] border border-[#454545] bg-[#252526] p-5 text-[#cccccc] shadow-[0_12px_36px_rgba(0,0,0,0.65)]"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setBranchingTagModal(null);
            }}
          >
            <div className="mb-2 text-[14px] font-semibold text-white">
              基于标签新建分支
            </div>
            <p className="mb-3 text-[12.5px] leading-relaxed text-[#9d9d9d]">
              源标签: <strong className="text-white">"{branchingTagModal.name}"</strong> ({branchingTagModal.target_oid.slice(0, 7)})
            </p>
            <div className="mb-3 flex flex-col gap-1.5">
              <label className="text-[12px] font-medium text-[#9d9d9d]">
                新分支名称
              </label>
              <input
                autoFocus
                type="text"
                className="h-[28px] rounded-[3px] border border-[#3c3c3c] bg-[#313131] px-2.5 text-[12.5px] text-[#cccccc] placeholder-[#868686] outline-none transition-colors focus:border-[#0078d4]"
                placeholder="例如: feature/fix-v1.0"
                value={branchFromTagInput}
                onChange={(e) => setBranchFromTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && branchFromTagInput.trim()) {
                    void onBranchFromTagSubmit();
                  }
                }}
              />
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="cursor-pointer rounded-[3px] border border-[#3c3c3c] bg-[#313131] px-3 py-1.5 text-[12px] text-[#cccccc] transition-colors hover:bg-[#3c3c3c] hover:text-white"
                onClick={() => setBranchingTagModal(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="cursor-pointer rounded-[3px] border border-[#0078d4] bg-[#0078d4] px-3.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:border-[#026ec1] hover:bg-[#026ec1] disabled:cursor-not-allowed disabled:opacity-45"
                disabled={!branchFromTagInput.trim()}
                onClick={() => void onBranchFromTagSubmit()}
              >
                创建并检出分支
              </button>
            </div>
          </div>
        </div>
      )}

      {updaterOpen && (
        <UpdateDialog
          currentVersion={updater.currentVersion}
          status={updater.status}
          info={updater.info}
          progress={updater.progress}
          error={updater.error}
          onClose={() => setUpdaterOpen(false)}
          onCheck={() => updater.check(true)}
          onInstall={updater.install}
          onSkip={updater.skip}
        />
      )}

      {toast && (
        <div
          className={`fixed bottom-8 right-4 z-[60] max-w-[420px] rounded-[4px] border px-3.5 py-2 text-[12px] shadow-[0_6px_20px_rgba(0,0,0,0.55)] ${
            toast.kind === "error"
              ? "border-[#f14c4c]/60 bg-[#3a1d1d] text-[#f48771]"
              : "border-[#454545] bg-[#252526] text-[#cccccc]"
          }`}
        >
          {toast.text}
        </div>
      )}

      <footer className="flex h-[22px] shrink-0 select-none items-center gap-3 border-t border-[#2b2b2b] bg-[#181818] px-2.5 text-[11px] text-[#cccccc]">
        <span
          className={`inline-flex h-full items-center gap-1 px-1.5 transition-colors ${
            status
              ? "cursor-pointer hover:bg-[#2a2d2e] hover:text-white"
              : "text-[#868686]"
          }`}
          title={status ? "点击切换或新建分支" : undefined}
          onClick={() => {
            if (status) setBranchQuickPickOpen(true);
          }}
        >
          <GitBranch size={12} strokeWidth={1.75} className="shrink-0" />
          <span>
            {status?.detached
              ? status.branch
                ? `(detached: ${status.branch})`
                : "(detached)"
              : status?.branch ?? "—"}
          </span>
        </span>
        {status && (
          <button
            type="button"
            className="inline-flex h-full cursor-pointer items-center gap-1 border-none bg-transparent px-1.5 text-[11px] text-[#cccccc] transition-colors hover:bg-[#2a2d2e] hover:text-white disabled:cursor-wait disabled:opacity-70"
            title={`点击同步变更 (Fetch, Pull & Push)${
              status.ahead > 0 || status.behind > 0
                ? ` · 待推送: ↑${status.ahead}, 待拉取: ↓${status.behind}`
                : " · 仓库与远端已保持同步"
            }`}
            disabled={syncLoading}
            onClick={() => void onSync()}
          >
            <RefreshCw
              size={12}
              strokeWidth={1.75}
              className={syncLoading ? "animate-spin text-[#cccccc]" : ""}
            />
            {status.ahead > 0 || status.behind > 0 ? (
              <span className="inline-flex items-center gap-1 font-mono text-[10.5px] text-[#9d9d9d]">
                {status.ahead > 0 && <span>↑{status.ahead}</span>}
                {status.behind > 0 && <span>↓{status.behind}</span>}
              </span>
            ) : null}
          </button>
        )}
        {status && (
          <span className="text-[#9d9d9d]">
            {status.staged.length} 已暂存 · {status.unstaged.length} 变更 ·{" "}
            {status.untracked.length} 未跟踪
          </span>
        )}
        <span className="flex-1" />
        {status && (
          <span className="text-[#9d9d9d]">
            {commits.length} 个提交已加载
          </span>
        )}
        <button
          type="button"
          className={`inline-flex h-full cursor-pointer items-center border-none bg-transparent px-1.5 text-[11px] transition-colors hover:bg-[#2a2d2e] hover:text-white ${
            isDefaultZoom(zoomLevel) ? "text-[#9d9d9d]" : "text-[#4daafc]"
          }`}
          title="重置界面缩放 (Ctrl+0)"
          onClick={resetZoom}
        >
          {formatZoom(zoomLevel)}
        </button>
        <button
          type="button"
          className={`inline-flex h-full cursor-pointer items-center gap-1 border-none bg-transparent px-1.5 text-[11px] transition-colors hover:bg-[#2a2d2e] hover:text-white ${
            updater.status === "available" ? "text-[#4daafc]" : "text-[#9d9d9d]"
          }`}
          title="关于 / 检查更新"
          onClick={() => setUpdaterOpen(true)}
        >
          {updater.status === "available" && (
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#4daafc]" />
          )}
          v{updater.currentVersion ?? "—"}
        </button>
      </footer>
    </div>
  );
}

export type { Command };