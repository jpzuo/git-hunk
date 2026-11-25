/**
 * 规范化提交信息表单 (Conventional Commits Form) —— VS Code Dark Modern 100% 原子化实现
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Check,
} from "lucide-react";

export interface CommitTypeOption {
  value: string;
  label: string;
  desc: string;
  badgeColor: string;
}

export const COMMIT_TYPES: CommitTypeOption[] = [
  { value: "feat", label: "Features", desc: "新功能", badgeColor: "#10b981" },
  { value: "fix", label: "Bug Fixes", desc: "Bug 修复", badgeColor: "#ef4444" },
  { value: "docs", label: "Documentation", desc: "文档更新", badgeColor: "#3b82f6" },
  { value: "style", label: "Styles", desc: "代码格式/样式", badgeColor: "#8b5cf6" },
  { value: "refactor", label: "Code Refactoring", desc: "重构", badgeColor: "#f59e0b" },
  { value: "perf", label: "Performance", desc: "性能优化", badgeColor: "#ec4899" },
  { value: "test", label: "Tests", desc: "测试用例", badgeColor: "#06b6d4" },
  { value: "build", label: "Build System", desc: "构建系统/依赖", badgeColor: "#64748b" },
  { value: "ci", label: "Continuous Integration", desc: "CI/CD 配置", badgeColor: "#6366f1" },
  { value: "chore", label: "Chores", desc: "杂项/维护", badgeColor: "#78716c" },
  { value: "revert", label: "Reverts", desc: "回退提交", badgeColor: "#e11d48" },
];

export function buildCommitMessage(
  type: string,
  scope: string,
  subject: string,
  body: string,
  breaking?: string,
  closes?: string,
): string {
  const cleanSubject = subject.trim();
  if (!cleanSubject) return "";

  const cleanScope = scope.trim();
  const header = cleanScope ? `${type}(${cleanScope}): ${cleanSubject}` : `${type}: ${cleanSubject}`;

  const parts = [header];
  if (body.trim()) {
    parts.push("", body.trim());
  }
  if (breaking?.trim()) {
    parts.push("", `BREAKING CHANGE: ${breaking.trim()}`);
  }
  if (closes?.trim()) {
    const issueText = closes.trim().startsWith("#") ? `Closes ${closes.trim()}` : `Closes #${closes.trim()}`;
    parts.push("", issueText);
  }

  return parts.join("\n");
}

export function extractScopeFromBranch(branch: string | null | undefined): string {
  if (!branch) return "";
  const cleanBranch = branch.trim();
  if (!cleanBranch) return "";

  const ticketMatch = cleanBranch.match(/(?:^|[^a-zA-Z0-9])([a-zA-Z]+[a-zA-Z0-9]*-\d+)(?:[^a-zA-Z0-9]|$)/);
  if (ticketMatch && ticketMatch[1]) {
    return ticketMatch[1].toUpperCase();
  }

  const ignored = new Set(["main", "master", "develop", "dev", "test", "staging", "prod", "production", "release", "head"]);
  if (ignored.has(cleanBranch.toLowerCase())) {
    return "";
  }

  const prefixRegex = /^(?:feature|feat|fix|bugfix|hotfix|chore|refactor|perf|test|docs|release)[/_-]/i;
  let remaining = cleanBranch.replace(prefixRegex, "");
  if (!remaining) return "";

  if (remaining.includes("/")) {
    const parts = remaining.split("/").filter(Boolean);
    if (parts.length > 0) {
      remaining = parts[0];
    }
  }

  if (remaining.includes("-")) {
    const segments = remaining.split("-").filter(Boolean);
    if (segments.length > 1 && segments[0].length <= 20) {
      return segments[0];
    }
  }

  return remaining;
}

interface Props {
  branch?: string | null;
  stagedCount: number;
  totalChangesCount?: number;
  hasConflicts: boolean;
  onCommit: (message: string) => void;
  onCommitAndPush: (message: string) => void;
  onAmend?: (message: string) => void;
  onStageAllAndCommit?: (message: string) => void;
  ahead?: number;
  behind?: number;
  onSync?: () => void;
  syncLoading?: boolean;
}

const inputCls =
  "w-full bg-[#313131] text-[#cccccc] placeholder-[#868686] border border-[#3c3c3c] focus:border-[#0078d4] outline-none rounded-[2px] px-2 py-1 text-[12px] transition-colors";

export const ConventionalCommitForm = React.memo(function ConventionalCommitForm({
  branch,
  stagedCount,
  totalChangesCount: _totalChangesCount = 0,
  hasConflicts,
  onCommit,
  onCommitAndPush,
  onAmend: _onAmend,
  onStageAllAndCommit: _onStageAllAndCommit,
  ahead: _ahead = 0,
  behind: _behind = 0,
  onSync: _onSync,
  syncLoading: _syncLoading = false,
}: Props) {
  const [type, setType] = useState<string>("feat");
  const [scope, setScope] = useState<string>(() => extractScopeFromBranch(branch));
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [breaking, setBreaking] = useState("");
  const [closes, setCloses] = useState("");

  const prevBranchRef = useRef<string | null | undefined>(branch);

  useEffect(() => {
    if (prevBranchRef.current !== branch) {
      prevBranchRef.current = branch;
      const autoScope = extractScopeFromBranch(branch);
      setScope(autoScope);
    }
  }, [branch]);

  const [showMore, setShowMore] = useState(false);

  const activeMessage = useMemo(() => {
    return buildCommitMessage(type, scope, subject, body, breaking, closes);
  }, [type, scope, subject, body, breaking, closes]);

  const isMessageValid = Boolean(activeMessage.trim());

  const handleExecuteCommit = (action: "commit" | "commitAndPush") => {
    if (!isMessageValid) return;
    if (hasConflicts) return;
    if (stagedCount === 0) return;

    if (action === "commit") {
      onCommit(activeMessage);
    } else {
      onCommitAndPush(activeMessage);
    }

    setSubject("");
    setBody("");
    setBreaking("");
    setCloses("");
  };

  return (
    <div className="px-2.5 py-2 border-b border-[#2b2b2b] bg-[#181818] flex flex-col gap-1.5 shrink-0">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <select
            className="flex-1 min-w-0 bg-[#313131] text-[#cccccc] border border-[#3c3c3c] focus:border-[#0078d4] outline-none rounded-[2px] px-1.5 py-1 text-[12px] cursor-pointer"
            value={type}
            onChange={(e) => setType(e.target.value)}
            title="选择提交类型"
          >
            {COMMIT_TYPES.map((t) => (
              <option key={t.value} value={t.value} className="bg-[#252526] text-[#cccccc]">
                {t.label} ({t.value})
              </option>
            ))}
          </select>

          <input
            type="text"
            className="w-[108px] shrink-0 bg-[#313131] text-[#cccccc] placeholder-[#868686] border border-[#3c3c3c] focus:border-[#0078d4] outline-none rounded-[2px] px-2 py-1 text-[12px]"
            placeholder="模块 (选填)"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          />
        </div>

        <input
          type="text"
          className={inputCls}
          placeholder="消息 (Ctrl+Enter 提交)"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              handleExecuteCommit("commit");
            }
          }}
        />

        <div className="flex items-center">
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[11px] text-[#868686] hover:text-[#cccccc] hover:bg-[#2a2d2e] bg-transparent border-none px-1.5 py-0.5 -ml-1.5 rounded-[3px] cursor-pointer transition-colors"
            onClick={() => setShowMore((v) => !v)}
          >
            {showMore ? (
              <>
                <ChevronUp size={12} strokeWidth={2} />
                <span>收起更多</span>
              </>
            ) : (
              <>
                <ChevronDown size={12} strokeWidth={2} />
                <span>更多 (详细说明 / 破坏性更新 / ISSUE)</span>
              </>
            )}
          </button>
        </div>

        {showMore && (
          <div className="flex flex-col gap-1.5 pt-0.5">
            <textarea
              className={`${inputCls} resize-y min-h-[54px]`}
              placeholder="详细说明 (选填，分行描述变更细节)"
              rows={3}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  handleExecuteCommit("commit");
                }
              }}
            />
            <textarea
              className={`${inputCls} resize-y min-h-[40px]`}
              placeholder="破坏性更新 (选填，例如 BREAKING CHANGE 说明)"
              rows={2}
              value={breaking}
              onChange={(e) => setBreaking(e.target.value)}
            />
            <input
              type="text"
              className={inputCls}
              placeholder="关闭的 ISSUE (选填，例如 #123)"
              value={closes}
              onChange={(e) => setCloses(e.target.value)}
            />
          </div>
        )}

        {subject.trim() && (
          <div
            className="px-2 py-1 rounded-[2px] bg-[#252526] border border-[#2b2b2b] text-[11px] text-[#9d9d9d] truncate"
            title="实时生成的 Commit 信息"
          >
            <span className="text-[#868686] mr-1.5">预览:</span>
            <code className="font-mono text-[#73c991]">
              {scope.trim() ? `${type}(${scope.trim()}): ${subject.trim()}` : `${type}: ${subject.trim()}`}
            </code>
          </div>
        )}
      </div>

      <div className="pt-0.5">
        <button
          type="button"
          className="w-full h-[28px] inline-flex items-center justify-center gap-1.5 rounded-[2px] bg-[#0078d4] hover:bg-[#026ec1] disabled:bg-[#0078d4]/45 disabled:text-white/50 disabled:cursor-default text-white text-[12px] font-medium border-none cursor-pointer transition-colors"
          disabled={!isMessageValid || hasConflicts || stagedCount === 0}
          onClick={() => handleExecuteCommit("commit")}
          title={
            hasConflicts
              ? "存在未解决的冲突文件，无法提交"
              : stagedCount === 0
              ? "暂存区为空，请先暂存文件后再提交"
              : !isMessageValid
              ? "请输入提交简述 (Ctrl+Enter 提交)"
              : "提交已暂存的变更 (Ctrl+Enter)"
          }
        >
          <Check size={14} strokeWidth={2} />
          <span>{stagedCount > 0 ? `提交 (${stagedCount})` : "提交"}</span>
        </button>
      </div>
    </div>
  );
});
