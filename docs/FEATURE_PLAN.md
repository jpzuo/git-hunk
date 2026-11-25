# git-hunk 功能规划：AI 时代的 Git 中枢开发工具

> 状态：已确认（2026-11-20）
> 关联仓库：`E:\oneself\git-hunk`（Tauri 2 + React 19 + Vite + TypeScript，当前为脚手架）

## 0. 关键决策记录

| 决策点 | 结论 |
|---|---|
| AI 能力范围 | 本期纳入，分阶段落地（MVP: commit message → v1: 冲突建议 + 自然语言命令 → v2: diff 总结/PR 描述） |
| Git 底层实现 | 内嵌 libgit2（`git2` crate）承担高频读写，复杂操作（rebase/cherry-pick 等）回退系统 git CLI |
| 目标平台 | Windows 优先，架构预留跨平台（v2 移植 macOS/Linux） |
| 交付深度 | 功能清单 + 分阶段路线图 + 关键交互 |

## 1. 目标与定位

**一句话定位**：以 Git 为主要工作入口的桌面开发工具 —— 日常 Git 操作通过 Source Control + Command Palette 完成；Diff/Merge 是一等公民的专业能力；Terminal 完整保留但退居后台、按需唤起。

**核心差异点（区别于通用 IDE）**：
- **Hunk 是一等公民**：所有变更以 hunk 为单位可视化、暂存、丢弃、解决冲突（呼应项目名 `git-hunk`）。
- **Git 不是附属面板**：Source Control 与 Command Palette 是默认主界面，而非藏于侧栏的次要功能。
- **AI 辅助不替代**：AI 负责生成建议，落地前必须人工确认、可一键撤销。

## 2. 成功标准（验收口径）

1. **无终端可达性**：日常 Git 操作（add/commit/push/pull/branch/merge/rebase/stash/tag/revert）100% 可在不打开 Terminal 的情况下完成。
2. **性能**：命令面板输入到结果 <100ms；打开万行级文件的 diff 无可见卡顿（虚拟滚动 + 按需渲染）。
3. **冲突解决**：三方合并视图 + AI 建议，覆盖 merge/rebase 两类冲突；解决后可一键 continue / abort。
4. **安全**：所有写操作（commit/push/discard/reset）执行前有可读的预览或确认；AI 建议均需人工确认。
5. **AI 采纳率（定性）**：AI 生成的 commit message 被采纳或小幅修改的比例成为 v1 阶段的观察指标。

## 3. 设计原则

1. **键盘优先 + 命令面板统一入口**：`Ctrl+Shift+P` 打开命令面板，所有操作（含 Git、Diff、终端切换）都可通过它触达。
2. **只读安全，写操作先预览**：commit 前可预览完整 diff，push 前展示待推送 commit，discard 前高亮将被丢弃的改动。
3. **AI 建议落地 = 人工确认 + 可撤销**：不自动改写代码或直接执行命令。
4. **快**：状态/索引后台增量刷新（文件系统 watch + git status 缓存），diff 按需加载。
5. **跨平台架构，Windows 优先**：底层用可跨平台库，但首发只在 Windows 上验收。

## 4. 功能清单（按子系统）

### 4.1 Git 核心（主要工作入口）

**A1 仓库管理**
| 优先级 | 功能 |
|---|---|
| P0 | 打开本地仓库、初始化仓库、克隆仓库（含进度与浅克隆选项） |
| P0 | 最近仓库列表 / 多仓库工作区切换 |
| P1 | 分支与标签列表、当前分支、ahead/behind 状态 |
| P1 | 仓库状态概览（已暂存 / 已修改 / 未跟踪 数量） |

**A2 Source Control 面板（VS Code 式）**
| 优先级 | 功能 |
|---|---|
| P0 | 变更分组：Staged / Changes / Untracked |
| P0 | 文件级操作：stage / unstage、discard、打开、查看 diff |
| P0 | **hunk 级操作**：逐块 stage / stage selected lines / discard hunk（核心差异点） |
| P0 | 展开文件内联 diff 预览 |
| P1 | 变更文件搜索 / 过滤（按路径、状态） |
| P0 | 快速提交：输入框 + commit、amend、签名 |

**A3 Command Palette（命令面板）**
| 优先级 | 功能 |
|---|---|
| P0 | 全局命令索引，模糊匹配，最近使用排序 |
| P0 | Git 命令全集：commit/push/pull/fetch/branch/checkout/merge/rebase/stash/tag/cherry-pick/revert/log/blame |
| P1 | 命令别名、参数引导式输入（先选分支 → 再选目标） |
| P1 | `Ctrl+P` 文件/符号快速跳转（仅作为导航，不做完整编辑） |

**A4 常用 Git 工作流**
- P0：Commit / Amend / 多文件选择性暂存后提交；Push / Pull / Fetch（rebase vs merge 策略可选）
- P1：Branch（创建/切换/删除/重命名/合并）；Merge（fast-forward / no-ff / squash）
- P1：Stash（create/apply/pop/drop + stash list）；Tag（annotated/lightweight）
- P1：Cherry-pick / Revert；远程管理（add/remove/rename、查看 url）
- P2：Rebase（先支持非交互；交互式 rebase 可视化留到 v2，复杂场景回退系统 git）

**A5 历史可视化**
- P1：Commit 图（graph）浏览器，点击 commit 查看完整 diff / 文件树
- P1：Blame 视图（行级溯源，可继续沿历史追溯）
- P2：Reflog 可视化

### 4.2 Diff & Merge（独立专业能力）

**B1 Diff 查看器**
| 优先级 | 功能 |
|---|---|
| P0 | 双栏（side-by-side）/ 单栏（inline）切换 |
| P0 | 语法高亮、行号、折叠未变更区域 |
| P0 | 字符级/词级差异高亮（word diff） |
| P0 | 多文件 diff 导航（文件间跳转、变更统计） |
| P1 | 忽略空白 / 忽略大小写切换 |
| P1 | 大文件虚拟滚动、按需渲染 |
| P1 | 比较范围：工作区↔索引、工作区↔HEAD、任意两 commit / 分支 |
| P2 | 导出 diff、复制单个 hunk |

**B2 冲突解决（Merge Conflict Resolution）**
| 优先级 | 功能 |
|---|---|
| P0 | 冲突检测与冲突文件清单 |
| P0 | **三方合并视图**（ours / base / theirs / result） |
| P0 | 逐 hunk 选择 ours / theirs / 两者都留 / 自定义编辑 |
| P0 | 冲突标记（`<<<<<<<` / `=======` / `>>>>>>>`）高亮 |
| P0 | 手动编辑 + 标记已解决；解决后统一 continue / abort（覆盖 merge 与 rebase） |
| P1 | AI 冲突解决建议（见 4.4-D2） |

**B3 代码评审辅助**：留到 v2（变更集评论/审查不在首期范围）。

### 4.3 Terminal（完整保留，退居后台）
| 优先级 | 功能 |
|---|---|
| P0 | 内嵌终端（xterm.js + 后端 PTY） |
| P0 | 按需唤起：命令面板 / 快捷键（`Ctrl+\``）/ 底部抽屉 toggle；关闭即释放，不抢占主界面 |
| P0 | 自动 `cd` 到当前仓库；多 tab；复制粘贴、字体缩放 |
| P1 | 分屏；保留 shell 历史 |
| P2 | 自然语言转命令建议（依赖 4.4-D3） |

### 4.4 AI 能力（本期纳入，分阶段落地）
| 阶段 | 功能 | 说明 |
|---|---|---|
| MVP | **D1 AI Commit Message 生成** | 基于 staged diff 生成 commit message，支持 conventional / 简洁 / 详细风格，一键插入提交框、可编辑 |
| v1 | **D2 AI 冲突解决建议** | 分析冲突 hunk，给出「选 ours / theirs」或「生成合并后代码」，逐 hunk 展示、用户确认 |
| v1 | **D3 自然语言 Git 命令** | 命令面板输入自然语言 → 映射为 Git 命令（带参数确认，例：「撤回上次提交但保留改动」→ `git reset --soft HEAD~1`） |
| v2 | **D4 AI Diff 总结 / PR 描述** | 总结一段变更或 commit 的要点，生成 PR 描述草稿 |

**AI 安全与隐私原则（贯穿所有阶段）**
- 所有 AI 建议落地前必须人工确认，且可一键撤销。
- 数据边界透明：是否把 diff 发送到云端 / 本地模型需明确提示并可由用户配置；**默认本地优先**。
- Provider 可插拔（本地 ollama / 云端），便于在无网环境降级为纯本地或禁用。

## 5. 关键交互

**主界面布局**：左侧活动栏（Source Control / History / Diff）+ 中部内容区 + 命令面板浮层 + 底部终端抽屉（默认折叠）。

1. **Source Control 流**：仓库变更自动分组展示 → 点击文件展开 hunk 列表 → 逐 hunk 点「+」暂存 → 提交框写信息（或点 AI 生成）→ 提交 → 状态实时刷新。
2. **Command Palette 流**：`Ctrl+Shift+P` → 模糊输入命令名或自然语言 → 命中后若有参数则引导式选择（分支/远程等）→ 展示预览（如 push 前列出待推送 commit）→ 确认执行。
3. **Diff 流**：从 Source Control / History / Blame 任意入口点进 → 双栏展示 → 可切换 inline、折叠未变更、忽略空白 → 文件间导航 → 复制 hunk。
4. **冲突解决流**：pull/merge/rebase 触发冲突 → 冲突文件清单置顶 → 进入三方合并视图 → 逐 hunk 选 ours/theirs/自定义 或采纳 AI 建议 → 标记已解决 → continue 或 abort。
5. **Terminal 流**：`Ctrl+\`` 唤起底部抽屉 → 自动 cd 到当前仓库 → 多 tab 执行任意命令 → 关闭抽屉释放资源。

## 6. 分阶段路线图

| 阶段 | 内容 | 交付物 / 验收 |
|---|---|---|
| **M0 技术地基** | git2 接入（status/index/diff 只读 + 写操作）；状态/索引数据模型；Tauri 事件总线；命令注册框架；前端壳布局 + 命令面板骨架 | 能读取仓库并展示 status/diff；命令面板可注册并执行内置命令 |
| **MVP v0.1** | Source Control 面板（分组 + 文件/hunk 级 stage/discard）；双栏 diff 查看；快速提交 + amend；内嵌终端（单 tab）；基础命令面板 Git 命令；**AI commit message** | 满足成功标准 1、2；日常 add/commit/diff 闭环无需终端 |
| **v1** | 完整工作流（branch/merge/stash/tag/cherry-pick/revert + push/pull 策略）；历史图 + blame；**三方合并冲突解决 + AI 建议**；**自然语言 Git 命令**；终端多 tab | 成功标准 3、4；merge/rebase 冲突可闭环解决 |
| **v2** | 交互式 rebase 可视化；大文件 diff 性能优化（忽略空白、虚拟滚动）；多仓库工作区；AI diff 总结 / PR 描述；macOS/Linux 移植 | 成功标准 5 达成；三端可用 |

## 7. 技术选型与数据流要点（简述）

- **Git 后端**：Rust 侧以 `git2`（libgit2 绑定）承担高频读写（status / diff / stage / commit / checkout）；rebase、cherry-pick、复杂 merge 等回退 `std::process::Command` 调系统 git（用户需装有 git）。
- **前端**：React 19 + Vite + TypeScript；状态同步走 Tauri `invoke` + 事件推送。
- **Diff/编辑内核（建议）**：统一采用 **CodeMirror 6**（`@codemirror/merge` 原生支持三方合并视图，适合冲突解决；双栏/内联 diff 基于同一内核扩展），保持单一依赖、可控；Monaco Editor 作为备选（diff 特性更全但更重、三方合并需自建）。—— 此选型为推荐默认，实施前可再确认。
- **终端**：xterm.js + Rust 侧 PTY（`portable-pty`，Windows 走 ConPTY）。
- **AI**：可插拔 provider 抽象层，默认本地（ollama），可配置云端；diff 上下文按需裁剪后作为 prompt 输入。
- **核心数据流**：`git2/CLI → Rust 命令层 → Tauri event → 前端 store → UI`；写操作统一走「预览 → 确认 → 执行 → 状态刷新」链路。

## 8. 边界 / 风险 / 假设

- **假设**：不做完整代码编辑器（编辑器仅用于 diff / 冲突查看与冲突结果编辑），不做 IDE 级语言服务。
- **依赖风险**：libgit2 与系统 git 版本行为差异 → 复杂操作统一回退系统 git 以保证与命令行一致。
- **跨平台风险**：PTY 与文件监控在 macOS/Linux 上实现不同 → 抽象层先行，Windows 验收，v2 再移植。
- **隐私风险**：AI 涉及 diff 上传边界 → 默认本地、显式开关、明文提示。
- **数据模型**：hunk 需要从 git 的补丁结构解析为稳定的行号/范围模型，是 M0 阶段必须先定型的关键数据结构（涉及 stage/discard/冲突/AI 提示的一致性）。
