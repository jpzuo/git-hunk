# M0 技术地基完成报告

> 完成时间：2026-11-20
> 对应规划：[FEATURE_PLAN.md](./FEATURE_PLAN.md) 第 6 节「M0 技术地基」

## 验收结果

| 验收项 | 状态 | 证据 |
|---|---|---|
| git2 接入（status / index / diff） | ✅ | `cargo build` 通过，libgit2-sys 0.18.8 静态编译进产物 |
| hunk 数据模型定型 | ✅ | `src-tauri/src/model.rs`，含行号映射与原始 patch 重建 |
| 写操作（stage / unstage / discard / commit / amend） | ✅ | 文件级 + hunk 级均已实现 |
| 前端壳布局 + 命令面板 | ✅ | `vite build` 通过，命令面板支持模糊匹配与键盘导航 |
| 状态/索引数据模型 | ✅ | Rust ↔ TypeScript 类型一一对应（`model.rs` ↔ `types.ts`） |
| 能读取仓库并展示 status/diff | ✅ | 真实仓库冒烟验证通过 |
| 命令面板可注册并执行命令 | ✅ | `CommandRegistry` 注册框架 + 内置 Git 命令 |

## 验证方式

```
# 单元 + 端到端测试（15 个用例）
cargo test --manifest-path src-tauri/Cargo.toml --lib
# → test result: ok. 15 passed; 0 failed

# 前端类型检查与构建
npx tsc --noEmit && npx vite build
# → ✓ built

# 真实仓库冒烟验证
cargo run --manifest-path src-tauri/Cargo.toml --bin smoke -- "E:\tmp\git-hunk-demo"
```

冒烟验证实测输出（真实仓库 `E:\tmp\git-hunk-demo`）：

- 状态分组正确：`已变更: 2`、`未跟踪: 1`，行数统计准确
- diff 解析正确：`hunk[0] @@ -1 +1,3 @@  +2 -0  (3 行)`
- hunk 级暂存成功：`暂存 README.md 的第 0 个 hunk → 成功（已进入暂存区）`
- 提交成功：`提交成功 eacdea9 — smoke: verify hunk staging pipeline`
- 提交后状态正确：仅剩未提交的 app.rs 与未跟踪的 notes.md

## 已实现功能清单

### 后端（Rust）

| 模块 | 内容 |
|---|---|
| `model.rs` | `RepoStatus` / `ChangedFile` / `FileDiff` / `Hunk` / `HunkLine` 数据模型，行号精确映射 |
| `git.rs` | git2 接入；patch 解析为结构化 hunk；文件级与 hunk 级 stage/unstage/discard；commit/amend；rename 检测 |
| `commands.rs` | 12 个 Tauri 命令，覆盖 status / diff / 全部写操作 |
| `state.rs` | 单仓库状态容器（`Mutex<Repository>`） |
| `watcher.rs` | 状态指纹轮询（1.5s），变化时推送 `repo://changed` 事件 |
| `tests.rs` | 8 个单元测试，覆盖 hunk 解析与行号映射 |
| `e2e_tests.rs` | 7 个端到端测试，覆盖完整闭环、选择性暂存、重命名等 |
| `smoke.rs` | 真实仓库冒烟验证工具 |

### 前端（React + TypeScript）

| 模块 | 内容 |
|---|---|
| `commands/registry.ts` | 命令注册框架：注册/注销/订阅/执行，模糊匹配打分 |
| `commands/builtin.ts` | 内置 Git 与视图命令 |
| `components/CommandPalette.tsx` | `Ctrl+Shift+P` 命令面板，键盘导航 + 实时过滤 |
| `components/SourceControlPanel.tsx` | 三组变更视图，文件级操作，提交框，分支与 ahead/behind |
| `components/DiffViewer.tsx` | 双栏 / 单栏 diff，hunk 头操作按钮（暂存/取消暂存/丢弃） |
| `components/TerminalDrawer.tsx` | 底部终端抽屉（M0 占位），默认折叠不占主界面 |
| `App.tsx` | 应用壳、状态管理、快捷键、外部变更监听 |

## 实施过程中发现并修复的关键问题

这些都是规划里预判到、但在实现中才暴露的真实陷阱，记录在此供后续阶段参考：

1. **libgit2 索引缓存**：`Repository::index()` 返回内存快照，执行过 add/reset 后必须 `index.read(true)` 刷新，否则读到过期内容。已统一封装为 `fresh_index()`，所有读写路径强制经由它。
2. **未跟踪文件没有 diff 内容**：libgit2 对未跟踪文件只产出空 delta（无 hunk），`Patch::line_stats()` 也拿不到行数。已改为自行读取文件内容合成「纯新增 hunk」与可被 `git apply` 接受的 patch。
3. **patch 重建的 origin 前缀**：`Diff::print` 的回调里 `line.content()` 只给正文，`+`/`-`/空格前缀需按 `origin()` 自行补回，否则重建的 patch 无法被 `git apply` 识别。
4. **amend 不能走 `commit(Some("HEAD"))`**：libgit2 校验「当前 tip 必须是第一个父提交」，而 amend 时第一个父提交是祖父提交。已改为先创建游离提交，再显式把 HEAD 引用移到新提交。
5. **rename 检测需显式开启**：`find_similar` 是 `Diff` 的方法（不在 `DiffOptions` 上），需在 diff 创建后调用，否则重命名会被拆成「删除 + 新增」。

## 已知限制（M0 范围内）

- **终端为占位实现**：`TerminalDrawer` 只有交互形态，尚未接入 xterm.js + PTY（规划在 MVP 阶段）。
- **单仓库**：仅支持同时打开一个仓库，多仓库工作区在 v2。
- **无冲突解决**：冲突文件能被识别并标为 `conflicted`，但三方合并视图在 v1。
- **hunk 操作依赖系统 git**：patch 应用调用系统 `git apply`，因此运行环境需要安装 git（与规划中的技术选型一致）。
- **状态监听为轮询**：1.5s 间隔的指纹比对，未使用文件系统 watch；MVP 阶段可替换为 `notify`，对外事件契约不变。
- **diff 渲染为自研轻量实现**：未引入 CodeMirror 6，大文件性能与语法高亮留待 MVP/v2 优化。

## 环境说明

本机原先缺少 C 链接器（无 Visual Studio、Windows SDK 只有 `UnionMetadata`），导致 Tauri 后端无法编译。已安装 **Visual Studio Build Tools 2022 (17.14.45)**，包含：

- `Microsoft.VisualStudio.Workload.VCTools`
- `Microsoft.VisualStudio.Component.VC.Tools.x86.x64`
- `Microsoft.VisualStudio.Component.Windows11SDK.22621`

安装完成后 `link.exe`（MSVC 14.44）就位，后端编译恢复正常。

## 下一步建议

按规划进入 **MVP v0.1**，建议优先级：

1. **终端真实化**：接入 xterm.js + `portable-pty`（ConPTY），这是三大支柱中唯一尚未落地的。
2. **AI commit message**：基于 staged diff 生成提交信息，是 MVP 阶段唯一的 AI 能力，风险最低、价值明确。
3. **diff 内核选型验证**：用 CodeMirror 6 三方合并做小 demo，为 v1 的冲突解决铺路（规划中已标记为需先验证的项）。
4. **文件系统 watch**：用 `notify` 替换轮询，降低空闲 CPU 占用。