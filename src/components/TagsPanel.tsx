/**
 * 标签管理面板（VS Code Dark Modern 100% 原子化实现）
 */

import { memo, useMemo, useState } from "react";
import {
  Tag,
  GitBranch,
  CloudUpload,
  Plus,
  RefreshCw,
  X,
  ChevronDown,
  ChevronRight,
  Check,
  GitCommitHorizontal,
  Trash2,
} from "lucide-react";
import type { TagInfo } from "../types";
import { IconButton } from "./IconButton";

interface Props {
  tags: TagInfo[];
  loading: boolean;
  onRefresh: () => Promise<void>;
  onRequestCreateTag: () => void;
  onRequestDeleteTag: (tag: TagInfo) => void;
  onRequestBranchFromTag: (tag: TagInfo) => void;
  onPushTag: (tag: TagInfo) => Promise<void>;
  onPushAllTags: () => Promise<void>;
  onCheckoutTag: (tag: TagInfo) => Promise<void>;
  onSelectCommit?: (oid: string) => void;
}

interface GroupedTagItem {
  tag: TagInfo;
  subName: string;
}

interface TagFolderGroup {
  prefix: string;
  tags: GroupedTagItem[];
}

interface GroupedTagsResult {
  rootTags: GroupedTagItem[];
  groups: TagFolderGroup[];
}

function formatDate(ts: number | null): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function organizeTagsByPrefix(tags: TagInfo[]): GroupedTagsResult {
  const rootTags: GroupedTagItem[] = [];
  const groupMap = new Map<string, GroupedTagItem[]>();

  for (const t of tags) {
    const slashIdx = t.name.indexOf("/");
    if (slashIdx === -1) {
      rootTags.push({ tag: t, subName: t.name });
    } else {
      const prefix = t.name.slice(0, slashIdx);
      const subName = t.name.slice(slashIdx + 1);
      if (!groupMap.has(prefix)) {
        groupMap.set(prefix, []);
      }
      groupMap.get(prefix)!.push({ tag: t, subName });
    }
  }

  const groups: TagFolderGroup[] = Array.from(groupMap.entries())
    .map(([prefix, items]) => ({
      prefix,
      tags: items,
    }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));

  return { rootTags, groups };
}

export const TagsPanel = memo(function TagsPanel({
  tags,
  loading,
  onRefresh,
  onRequestCreateTag,
  onRequestDeleteTag,
  onRequestBranchFromTag,
  onPushTag,
  onPushAllTags,
  onCheckoutTag,
  onSelectCommit,
}: Props) {
  const [filter, setFilter] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return tags;
    return tags.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.message && t.message.toLowerCase().includes(q)) ||
        t.target_summary.toLowerCase().includes(q) ||
        (t.tagger && t.tagger.toLowerCase().includes(q)),
    );
  }, [tags, filter]);

  const organized = useMemo(() => organizeTagsByPrefix(filtered), [filtered]);

  const toggleGroup = (prefix: string) => {
    setCollapsedGroups((prev) => ({
      ...prev,
      [prefix]: !prev[prefix],
    }));
  };

  const renderTagItem = (item: GroupedTagItem) => {
    const { tag, subName } = item;
    return (
      <div
        key={tag.name}
        className="group px-3 py-2 border-b border-[#2b2b2b]/60 hover:bg-[#2a2d2e] transition-colors select-none"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[#e2c08d] shrink-0">
            <Tag size={13} strokeWidth={1.75} />
          </span>
          <span className="text-[12.5px] font-semibold text-[#cccccc] truncate flex-1" title={tag.name}>
            {subName}
          </span>

          {tag.message ? (
            <span
              className="px-1.5 py-0.5 text-[10px] rounded-[2px] bg-[#252526] text-[#9d9d9d] border border-[#3c3c3c] shrink-0"
              title="附注标签 (Annotated)"
            >
              附注
            </span>
          ) : (
            <span
              className="px-1.5 py-0.5 text-[10px] rounded-[2px] bg-[#313131] text-[#9d9d9d] shrink-0"
              title="轻量标签 (Lightweight)"
            >
              轻量
            </span>
          )}
        </div>

        <div className="hidden group-hover:flex items-center gap-0.5 mt-1.5">
          <IconButton
            size="xs"
            tooltip="检出此标签 (进入游离头指针状态)"
            icon={<Check size={12} strokeWidth={2} />}
            onClick={() => void onCheckoutTag(tag)}
          />
          <IconButton
            size="xs"
            tooltip="基于此标签创建并切换到新分支"
            icon={<GitBranch size={11.5} strokeWidth={1.75} />}
            onClick={() => onRequestBranchFromTag(tag)}
          />
          <IconButton
            size="xs"
            tooltip="推送此标签到远程仓库"
            icon={<CloudUpload size={11.5} strokeWidth={1.75} />}
            onClick={() => void onPushTag(tag)}
          />
          {onSelectCommit && tag.target_oid && (
            <IconButton
              size="xs"
              tooltip="在提交历史图中定位并查看该提交"
              icon={<GitCommitHorizontal size={12} strokeWidth={1.75} />}
              onClick={() => onSelectCommit(tag.target_oid)}
            />
          )}
          <IconButton
            size="xs"
            variant="danger"
            tooltip="删除此标签"
            icon={<Trash2 size={11.5} strokeWidth={1.75} />}
            onClick={() => onRequestDeleteTag(tag)}
          />
        </div>

        {tag.message && (
          <div className="mt-1 text-[11.5px] text-[#9d9d9d] truncate italic" title={tag.message}>
            “{tag.message}”
          </div>
        )}

        <div className="flex items-center justify-between gap-2 mt-1 text-[11px] text-[#868686]">
          <span className="truncate flex-1" title={tag.target_summary}>
            {tag.target_summary || tag.target_oid.slice(0, 7)}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            {tag.tagger && <span className="truncate max-w-[80px]">{tag.tagger}</span>}
            {tag.timestamp && <span>{formatDate(tag.timestamp)}</span>}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#181818]">
      <div className="flex items-center justify-between px-3 h-[35px] border-b border-[#2b2b2b] shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[#cccccc]">
            标签管理
          </span>
          <span className="px-1.5 py-0.5 rounded-full bg-[#313131] text-[#cccccc] text-[10px] leading-none font-semibold">
            {tags.length}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <IconButton
            tooltip="在 HEAD 或指定提交创建新标签"
            icon={<Plus size={13} strokeWidth={2} />}
            onClick={onRequestCreateTag}
          />
          <IconButton
            tooltip="推送所有本地标签至远程仓库 (git push --tags)"
            disabled={loading || tags.length === 0}
            icon={<CloudUpload size={13} strokeWidth={1.75} />}
            onClick={() => void onPushAllTags()}
          />
          <IconButton
            tooltip="刷新标签列表"
            align="right"
            disabled={loading}
            icon={<RefreshCw size={12} strokeWidth={1.75} className={loading ? "animate-spin" : ""} />}
            onClick={() => void onRefresh()}
          />
        </div>
      </div>

      <div className="px-2.5 py-1.5 border-b border-[#2b2b2b] bg-[#181818] shrink-0">
        <div className="flex items-center bg-[#313131] border border-[#3c3c3c] focus-within:border-[#0078d4] rounded-[2px] px-2 h-[26px]">
          <input
            type="text"
            className="border-none bg-transparent text-[#cccccc] placeholder-[#868686] text-[12px] w-full outline-none"
            placeholder="过滤标签名称、说明或提交..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {filter && (
            <button
              className="flex items-center justify-center border-none bg-transparent text-[#9d9d9d] hover:text-white p-0.5 cursor-pointer"
              onClick={() => setFilter("")}
            >
              <X size={12} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {filtered.length === 0 ? (
          <div className="py-8 px-4 text-center text-[#868686] text-[12px]">暂无匹配的标签</div>
        ) : (
          <>
            {organized.rootTags.map((item) => renderTagItem(item))}

            {organized.groups.map((group) => {
              const isSearching = !!filter.trim();
              const isCollapsed = isSearching
                ? false
                : !!collapsedGroups[group.prefix];

              return (
                <div key={group.prefix}>
                  <div
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-[#cccccc] bg-[#202020] border-b border-[#2b2b2b] cursor-pointer select-none hover:bg-[#2a2d2e]"
                    onClick={() => toggleGroup(group.prefix)}
                  >
                    <span className="text-[#9d9d9d] shrink-0">
                      {isCollapsed ? (
                        <ChevronRight size={13} strokeWidth={1.75} />
                      ) : (
                        <ChevronDown size={13} strokeWidth={1.75} />
                      )}
                    </span>
                    <span className="font-semibold truncate flex-1">{group.prefix}</span>
                    <span className="text-[11px] text-[#868686]">{group.tags.length}</span>
                  </div>

                  {!isCollapsed && (
                    <div className="pl-2 bg-[#181818]">
                      {group.tags.map((item) => renderTagItem(item))}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
});
