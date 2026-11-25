# P2 提交审查页完成报告

> 完成时间：2026-11-21
> 背景：用户反馈「能看是能看，就是交互不好，文件变更也单拎出来一个面板吧，要类似 vscode 的那种对比形式」，并要求「点击 commit 后直接弹出下层页面，左侧是文件树，右侧是两栏对比（左修改前、右修改后）」。

## 后续修订（同日）

用户进一步明确两条交互取向，已据此简化：

1. **只保留双栏** —— 移除「双栏 / 单栏」切换。全文对比的价值就在左右并置，单栏会把同一段代码拆成上下两截，反而更难读。
2. **代码全量展开，删除折叠模式** —— 移除「⋯ 展开 N 行未变更 ⋯」折叠条。用户要看的是「这份文件改了什么」，全量展开才能建立完整上下文；折叠条会打断阅读，还得再点一次才知道改在哪。

修订后审查页右侧固定为双栏全文对比，无模式切换、无折叠。

## 改动概览

| 之前 | 现在 |
|---|---|
| 点提交后详情挤在**底部窄面板**（最大高度 45%） | 进入**独立审查页**，占满内容区 |
| 变更文件是**平铺列表** | 左侧是**可折叠文件树**（目录聚合统计） |
| 右侧只渲染 **hunk 补丁片段**（变更块 + 3 行上下文） | 右侧是 **VS Code 式全文对比**：完整文件、左「修改前」右「修改后」、**全量展开无折叠** |

## 后端

### 新增数据模型（`model.rs`）

```rust
pub struct FilePair {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub old_content: String,   // 修改前完整文本
    pub new_content: String,   // 修改后完整文本
    pub old_exists: bool,      // 新增文件 / 根提交时为 false
    pub new_exists: bool,      // 删除文件时为 false
    pub binary: bool,
    pub truncated: bool,       // 超过 2 MiB 时为 true
    pub hunks: Vec<Hunk>,      // 供前端定位折叠区间
    pub additions: u32,
    pub deletions: u32,
}

pub const MAX_PREVIEW_BYTES: usize = 2 * 1024 * 1024;
```

**设计要点**：`hunks` 与 `old_content`/`new_content` 是互补关系 —— hunks 说明「哪里变了」，完整内容说明「全文是什么」。前端用 hunks 定位变更区间，用全文补齐未变更部分并做折叠，两者都不可少。

### 新增读取函数（`history.rs`）

`read_file_pair(repo, commit_oid, path) -> FilePair`

- 修改前内容取自**第一父提交**的 tree；根提交没有父 → `old_exists = false`
- 修改后内容取自**本提交**的 tree；文件被删除 → `new_exists = false`
- 二进制文件（`Blob::is_binary()`）不返回全文，避免把乱码塞进 WebView
- 超过 2 MiB 的文件置 `truncated = true`，只保留 hunks
- 重命名场景用 `old_path` 去父提交里取旧内容

### 新增命令

`repo_commit_file_pair(oid, path) -> FilePair`

### 测试（`pair_tests.rs`，8 个用例）

| 用例 | 验证点 |
|---|---|
| `modified_file_returns_both_sides` | 前后全文都正确，互不污染 |
| `added_file_has_no_old_content` | `old_exists=false`、旧内容为空 |
| `deleted_file_has_no_new_content` | `new_exists=false`、新内容为空 |
| `root_commit_has_no_old_side` | 无父提交时旧侧不存在 |
| `binary_file_is_flagged_and_content_omitted` | 二进制标记 + 不返回文本 |
| `oversized_file_is_truncated` | 超大文件截断但保留 hunks |
| `renamed_file_uses_old_path_for_old_content` | 重命名时旧内容来自旧路径 |
| `empty_file_pair_is_handled` | 空文件边界 |

## 前端

### 新增 `FileTree.tsx`

把平铺的 `ChangedFile[]` 构建成树：

- 目录可折叠，目录行显示**子树聚合**的 `+/-`
- 排序规则：目录优先，同类按名称
- 文件行显示状态徽标（M/A/D/R）+ 文件名 + 自身 `+/-`

### 新增 `SideBySideDiff.tsx`

**全文对齐算法**（`buildRows`）：

1. 按行切分两侧完整内容
2. 遍历 hunks：
   - hunk 之前的区间 → 两侧行数相同、内容相同 → 上下文行
   - hunk 内部 → 逐行分类，删除与新增按序配对
   - hunk 之后 → 尾部上下文行
3. **不做任何折叠**：连续未变更行全部原样输出

**关键细节**：hunk 的 `old_start` 在 `old_lines === 0` 时表示「插入点之前那一行」，两种情况的 0-based 游标算法不同，必须区分，否则新增文件会错位。

**渲染**：
- 单滚动容器 + 每行 `grid` 两列 → 左右**天然同步滚动**（不用监听 scroll 互相赋值，避免抖动）
- 上下文行用 `.ctx`、删除行左红、新增行右绿
- 每行第一个单元格画右分隔线，明确区分左右两栏

### 新增 `CommitReviewPage.tsx`

- 顶部：返回按钮 + 提交摘要/hash/作者/时间/合并徽章/统计
- 主体：左 `FileTree`（272px）+ 右 `SideBySideDiff`
- 进入时**自动选中第一个文件**，右侧立即出对比
- **固定双栏**，不提供视图切换

### `App.tsx` 接线

- 新增 `reviewingOid` / `pair` / `pairLoading` 状态
- 点击提交 → 进入审查页并自动加载首个文件
- 返回按钮或 `Esc` → 回到提交图（**保留原滚动位置**，不重新加载）
- 移除不再需要的 `openCommitFileDiff` 与 `diffSource` 状态

### 退役

`CommitDetailPanel.tsx` 已删除，原有 `.history-detail` / `.commit-detail` / `.detail-*` 样式一并替换。

## 验证结果

### 自动化测试

```
cargo test --lib  →  32 passed; 0 failed
```
（24 个既有 + 8 个 FilePair）

### 真实界面验证（WebView2 调试协议读真实 DOM）

**多目录提交**（`feat: 新增组件与 API 模块`，4 文件 / 3 目录）：

- 文件树：4 个目录节点 + 4 个文件节点 ✅
- 全文对比：`修改前` / `修改后` 标签正确，路径正确 ✅

**长文件全量展开**（`fix: 修改长文件两处`，两个改动相距 30 行）：

| 检查项 | 结果 |
|---|---|
| 模式切换按钮 | `hasSegmented: false`，已移除 ✅ |
| 双栏表头 | 2 个单元格，标签为「修改前」「修改后」✅ |
| 折叠条 | **0 个**，已删除折叠模式 ✅ |
| 全量展开行数 | **40 行**（第 1 行到第 40 行）✅ |
| 网格布局 | `grid-template-columns: 182.333px 182.333px`，每行 2 个单元格 ✅ |
| 左右分隔线 | 第一个单元格 `border-right: 0.667px` ✅ |
| 上下文行染色 | `.ctx` 76 个，保持中性 ✅ |
| 新增/删除行 | 各 2 个 ✅ |

**交互**：
- 点击文件树切换文件 ✅
- 目录折叠（`src` → 文件数 4→1）✅
- 返回按钮回提交图，行数保持 ✅
- `Esc` 回提交图 ✅

## 过程中发现并修复的缺陷

1. **上下文行被误染色**：hunk 内部的未变更行原本被渲染成删除/新增配色（左侧红底、右侧绿底），实际应保持中性。原因是 `ChangeRow` 缺少 `isContext` 标记，已补充并在渲染分支中区分。

2. **误执行 `git init`**：调试时误在工作区执行了 `git init`，已立即删除生成的 `.git`，未影响其他文件。

3. **CSS 段落误删**：用行号切割 CSS 时误删了 Source Control / Diff / 命令面板 / 终端 / Toast 等段落，且中文注释出现编码损坏。已完整重建 `App.css`（12 个段落，中文正常）。

4. **左右分隔线丢失**：移除 inline 样式时把 `.sbs-cell:first-child` 的分隔线一并删了，导致两栏之间没有视觉分界。已恢复为无条件规则（`border-right: 1px`）。

5. **清理失效样式**：删除 `.sbs-diff.inline *`（4 条）、`.diff-collapse-bar`（2 条）、`.sbs-cell .sbs-mark`（1 条）等已无对应 DOM 的规则，避免样式表膨胀。

## 已知限制

- **无语法高亮**：全文对比是纯文本着色，引入高亮库留作后续
- **不支持任意两提交对比**：只做「父 → 本提交」
- **超大文件降级**：>2 MiB 只显示统计，不显示内容
- **单文件历史未做**：没有「某文件的历史演进」视图

## 下一步

回到原规划 P2 主线：

1. **分支管理**（创建/切换/合并/删除）—— 让左栏「分支」可用
2. **提交右键菜单** —— checkout / branch here / cherry-pick / revert / reset
3. **远程同步**（fetch/pull/push）
4. Stash 与标签
5. 冲突解决三方视图
6. 真实终端