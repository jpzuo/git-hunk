/** 与 Rust 侧提交历史模型对应的前端类型。 */

import type { ChangedFile, FileStatus, Hunk } from "./types";

export type RefKind = "local_branch" | "remote_branch" | "tag" | "head";

export interface CommitRef {
  kind: RefKind;
  name: string;
  is_head: boolean;
}

export interface LaneSegment {
  from_lane: number;
  to_lane: number;
}

export interface GraphCommit {
  oid: string;
  short_oid: string;
  summary: string;
  author_name: string;
  author_email: string;
  timestamp: number;
  parents: string[];
  lane: number;
  segments: LaneSegment[];
  merge_lanes: number[];
  refs: CommitRef[];
  is_head: boolean;
}

export interface CommitPage {
  commits: GraphCommit[];
  lane_count: number;
  has_more: boolean;
}

export interface CommitDetail {
  oid: string;
  short_oid: string;
  message: string;
  summary: string;
  author_name: string;
  author_email: string;
  timestamp: number;
  parents: string[];
  files: ChangedFile[];
  file_count: number;
  additions: number;
  deletions: number;
}

/**
 * 某提交中单个文件的「修改前 / 修改后」完整内容。
 *
 * `hunks` 用于定位变更区间，`old_content`/`new_content` 用于补齐未变更部分，
 * 两者共同支撑 VS Code 式全文对比。
 */
export interface FilePair {
  path: string;
  old_path: string | null;
  status: FileStatus;
  old_content: string;
  new_content: string;
  old_exists: boolean;
  new_exists: boolean;
  binary: boolean;
  truncated: boolean;
  hunks: Hunk[];
  additions: number;
  deletions: number;
}