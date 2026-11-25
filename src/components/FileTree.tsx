/**
 * 变更文件树（VS Code Dark Modern 100% 原子化实现）。
 */

import { useMemo, useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import type { ChangedFile, FileStatus } from "../types";

const STATUS_LABEL: Record<FileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "!",
  type_change: "T",
};

const STATUS_TEXT_COLOR: Record<FileStatus, string> = {
  added: "text-[#73c991]",
  untracked: "text-[#73c991]",
  modified: "text-[#e2c08d]",
  deleted: "text-[#c74e39]",
  renamed: "text-[#73c991]",
  conflicted: "text-[#e46767]",
  type_change: "text-[#e2c08d]",
};

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  file?: ChangedFile;
  children: TreeNode[];
  additions: number;
  deletions: number;
  allFilePaths: string[];
}

export function buildFileTree(files: ChangedFile[], compact: boolean = true): TreeNode[] {
  const root: TreeNode = {
    name: "",
    path: "",
    isDir: true,
    children: [],
    additions: 0,
    deletions: 0,
    allFilePaths: [],
  };

  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let cursor = root;

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isLeaf = i === parts.length - 1;
      const childPath = parts.slice(0, i + 1).join("/");

      let child = cursor.children.find((c) => c.name === name && c.isDir === !isLeaf);
      if (!child) {
        child = {
          name,
          path: childPath,
          isDir: !isLeaf,
          children: [],
          additions: 0,
          deletions: 0,
          allFilePaths: [],
        };
        cursor.children.push(child);
      }

      if (isLeaf) {
        child.file = file;
        child.additions = file.additions;
        child.deletions = file.deletions;
        child.allFilePaths = [file.path];
      }

      cursor = child;
    }
  }

  const finalize = (node: TreeNode): void => {
    let filePaths: string[] = [];
    for (const child of node.children) {
      finalize(child);
      filePaths = filePaths.concat(child.allFilePaths);
    }
    if (node.isDir) {
      node.allFilePaths = filePaths;
      node.additions = node.children.reduce((s, c) => s + c.additions, 0);
      node.deletions = node.children.reduce((s, c) => s + c.deletions, 0);
      node.children.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    }
  };

  finalize(root);

  const compactNode = (node: TreeNode): TreeNode => {
    if (!node.isDir) return node;

    node.children = node.children.map(compactNode);

    if (compact && node.children.length === 1 && node.children[0].isDir) {
      const singleChild = node.children[0];
      return {
        name: `${node.name}/${singleChild.name}`,
        path: singleChild.path,
        isDir: true,
        children: singleChild.children,
        additions: singleChild.additions,
        deletions: singleChild.deletions,
        allFilePaths: singleChild.allFilePaths,
      };
    }
    return node;
  };

  return compact ? root.children.map((c) => compactNode(c)) : root.children;
}

interface TreeRowProps {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  selectedPath: string | null;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}

function TreeRow({
  node,
  depth,
  collapsed,
  selectedPath,
  onToggleDir,
  onSelectFile,
}: TreeRowProps) {
  const isCollapsed = collapsed.has(node.path);
  const indent = 8 + depth * 14;

  if (node.isDir) {
    return (
      <>
        <div
          className="flex items-center gap-1.5 pr-2.5 py-[3px] text-[12px] text-[#cccccc] cursor-pointer select-none min-h-[22px] hover:bg-[#2a2d2e]"
          style={{ paddingLeft: indent }}
          onClick={() => onToggleDir(node.path)}
          title={node.path}
        >
          <span className="flex items-center justify-center text-[#9d9d9d] shrink-0">
            {isCollapsed ? (
              <ChevronRight size={13} strokeWidth={1.75} />
            ) : (
              <ChevronDown size={13} strokeWidth={1.75} />
            )}
          </span>
          <span className="truncate text-[#cccccc] font-medium">{node.name}</span>
        </div>
        {!isCollapsed &&
          node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              selectedPath={selectedPath}
              onToggleDir={onToggleDir}
              onSelectFile={onSelectFile}
            />
          ))}
      </>
    );
  }

  const file = node.file!;
  const isSelected = selectedPath === node.path;

  return (
    <div
      className={`flex items-center gap-1.5 pr-2.5 py-[3px] text-[12px] cursor-pointer select-none min-h-[22px] transition-colors ${
        isSelected
          ? "bg-[#04395e] text-white"
          : "text-[#cccccc] hover:bg-[#2a2d2e]"
      }`}
      style={{ paddingLeft: indent + 12 }}
      title={node.path}
      onClick={() => onSelectFile(node.path)}
    >
      <span
        className={`flex-1 truncate ${
          isSelected
            ? "text-white"
            : file.status === "deleted"
              ? "line-through text-[#c74e39]"
              : STATUS_TEXT_COLOR[file.status]
        }`}
      >
        {node.name}
      </span>
      <span className="flex items-center gap-1.5 shrink-0 font-mono text-[10.5px]">
        {file.additions > 0 && <span className="text-[#73c991]">+{file.additions}</span>}
        {file.deletions > 0 && <span className="text-[#c74e39]">-{file.deletions}</span>}
      </span>
      <span
        className={`w-3.5 text-center font-mono text-[11px] font-semibold shrink-0 ${
          isSelected ? "text-white" : STATUS_TEXT_COLOR[file.status]
        }`}
        title={file.status}
      >
        {STATUS_LABEL[file.status]}
      </span>
    </div>
  );
}

interface Props {
  files: ChangedFile[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  title?: string;
}

export function FileTree({ files, selectedPath, onSelectFile, title }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const tree = useMemo(() => buildFileTree(files), [files]);

  const toggleDir = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const totalAdd = files.reduce((s, f) => s + f.additions, 0);
  const totalDel = files.reduce((s, f) => s + f.deletions, 0);

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#181818]">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[#2b2b2b] shrink-0 text-[11px] text-[#9d9d9d] uppercase tracking-wider">
        <span className="flex-1 font-semibold">{title ?? "文件变更"}</span>
        <span className="bg-[#313131] rounded-full px-1.5 py-0.5 text-[10px] leading-none text-[#cccccc] font-semibold">
          {files.length}
        </span>
        <span className="flex items-center gap-1.5 font-mono text-[11px] normal-case">
          {totalAdd > 0 && <span className="text-[#73c991]">+{totalAdd}</span>}
          {totalDel > 0 && <span className="text-[#c74e39]">-{totalDel}</span>}
        </span>
      </div>
      <div className="flex-1 overflow-auto min-h-0 py-1">
        {tree.length === 0 && (
          <div className="py-6 text-center text-[#868686] text-[12px]">没有文件变更</div>
        )}
        {tree.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            collapsed={collapsed}
            selectedPath={selectedPath}
            onToggleDir={toggleDir}
            onSelectFile={onSelectFile}
          />
        ))}
      </div>
    </div>
  );
}
