# git-hunk

> 以 **Git 为主要工作入口**的桌面开发工具 —— Hunk 是一等公民。
> Tauri 2 + React 19 + TypeScript + Rust（libgit2）。

[![Build & Package](https://github.com/jpzuo/git-hunk/actions/workflows/build.yml/badge.svg)](https://github.com/jpzuo/git-hunk/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

`git-hunk` 是一款面向“日常 Git 操作即主界面”的桌面工具：变更、暂存、提交、分支、远程、Stash、标签、历史与文件浏览都在同一个窗口里完成，不必再切换到终端敲命令。名字里的 **hunk** 点明了它的核心差异——**所有变更都以 Hunk 为单位可视化、暂存、撤销与对比**。

> 完整的功能规划见 [docs/FEATURE_PLAN.md](./docs/FEATURE_PLAN.md)。

---

## ✨ 功能特性

### 工作区与多仓库

- **多工作区标签页**：同时打开多个仓库，`Ctrl+Tab` 切换，标签页缓存各自视图状态。
- **仓库管理中心**：仓库别名、项目分组、最近打开、Git Worktree 自动发现与批量导入。
- **工作区文件目录**：树形浏览 + 只读预览（代码 / Markdown / 图片），基于 Shiki 的语法高亮。

### 变更与提交（核心）

- **Source Control 面板**：Staged / Unstaged / Untracked 分组，文件级与 **Hunk 级** 的 stage / unstage / discard。
- **批量操作**：暂存全部 / 取消暂存全部（含仅已跟踪、仅未跟踪）/ 放弃全部更改 / 清理未跟踪文件。
- **快速提交**：提交框、`Ctrl+Enter`、**Amend** 修改上次提交、**Undo** 撤回上次提交、Conventional Commits 表单。
- **对比视图**：文件改动打开为独立的对比标签页（工作区 diff / 提交 diff / Stash diff 统一入口）。

### 历史与审查

- **提交关系图**：DAG 泳道渲染 + 虚拟滚动，分支 / 远程分支 / 标签引用徽章，ahead/behind 指示。
- **过滤与分页**：按分支范围、关键词过滤历史，滚动增量加载。
- **提交审查页**：左侧可折叠文件树，右侧 **全文双栏对比**（修改前 / 修改后，全量展开）。

### 分支、远程、Stash、标签

- **分支**：创建 / 切换 / 重命名 / 删除（本地 + 远端）/ 合并；`Ctrl+B` 快速切换。
- **远程**：fetch（含 prune / 全部远端）、pull（merge 或 rebase 策略）、push（含 force、设置上游）。
- **Stash**：保存（可含未跟踪文件 / 保留暂存区）、pop / apply / drop / clear、从 Stash 建分支。
- **标签**：创建（annotated / lightweight）、删除、推送、检出，一键推送全部标签。
- **中止流程**：一键 abort merge / rebase / cherry-pick。

### 搜索与脚本

- **全局内容搜索**：正则、大小写、整词、`include` / `exclude` 过滤，遵循 `.gitignore`；结果点击直接定位到代码行。
- **文件名搜索**：快速按名称跳转文件。
- **项目脚本运行器**：自动解析多生态脚本（`package.json`、`Cargo.toml` 等），并发运行、实时输出控制台、停止 / 重启。

### 体验

- **命令面板**：`Ctrl+Shift+P`，统一触达 Git / 视图 / 工作区命令，模糊匹配。
- **多标签页**：VS Code 风格标签系统（预览、diff、提交 diff、Stash diff）。
- **原生集成**：无边框自绘窗口、系统托盘、单实例运行、外部编辑器 / 资源管理器 / 终端联动。

---

## 🧱 技术栈

| 层 | 选型 |
|---|---|
| 桌面框架 | [Tauri 2](https://tauri.app/)（`tauri-plugin-dialog` / `opener` / `single-instance` / `tray-icon`） |
| 前端 | React 19、TypeScript、Vite 8、Tailwind CSS v4、`lucide-react` 图标 |
| 渲染 | `marked` + `dompurify`（Markdown 安全渲染）、`shiki`（代码高亮） |
| Git 后端 | Rust + [`git2`](https://github.com/rust-lang/git2-rs)（libgit2）；Hunk 补丁由系统 `git apply` 执行 |
| 测试 | `vitest` + `jsdom`（前端）、`cargo test`（Rust） |

数据流：`git2 / git CLI → Rust 命令层 → Tauri invoke & event → 前端状态 → UI`。所有写操作遵循“**预览 → 确认 → 执行 → 状态刷新**”的链路。

---

## 🚀 快速开始

### 前置依赖

| 依赖 | 说明 |
|---|---|
| **git** | **必需**。Hunk 级暂存 / 丢弃依赖系统 `git apply`，`git --version` 需可用 |
| **Node.js 24+** & **pnpm 11+** | 前端构建 |
| **Rust stable** | 后端编译（建议用 [rustup](https://rustup.rs/)） |
| **MSVC Build Tools**（Windows） | 编译 Rust 后端所需；Linux 需 `webkit2gtk-4.1` 等系统库（见 CI 脚本） |

### 安装与运行

```bash
# 1. 安装前端依赖
pnpm install

# 2. 开发模式（自动启动 Vite 并编译 Rust，改前端热更新、改 Rust 自动重启）
pnpm tauri dev

# 3. 仅跑前端（浏览器调试 UI，不含 Tauri 壳与后端命令）
pnpm dev
```

> ⚠️ **debug 模式不会内嵌前端资源**：它连接 `tauri.conf.json` 中的 `devUrl`（`http://localhost:1420`）。因此不要直接双击 `target/debug/git-hunk.exe`，除非同时运行着 `pnpm dev`。详见 [docs/RUNNING.md](./docs/RUNNING.md)。

### 构建与打包

```bash
# 只生成可执行文件（不打包安装程序，速度快）
pnpm tauri build --no-bundle   # 产物：src-tauri/target/release/git-hunk(.exe)

# 生成安装包（Windows: msi / nsis；macOS: dmg；Linux: deb / appimage）
pnpm tauri build
```

### 测试

```bash
# 前端单元测试（vitest）
pnpm test

# 后端单元 / 端到端测试
cargo test --manifest-path src-tauri/Cargo.toml
```

### 打开仓库

启动后点击左上角 **📂**，或 `Ctrl+O` 选择目录。所选目录**本身必须是 Git 仓库**（含 `.git`），否则会提示 `could not find repository`。

### 发版与自动更新

git-hunk 内置自动更新：启动后静默检查新版本，发现后可在标题栏提示条或状态栏版本号处下载安装；命令面板亦可手动触发「检查更新」。

- **仅以 `vX.Y.Z` 标签发布正式版**（`push main` 只跑测试构建，不发版），更新源为 GitHub `releases/latest/download/latest.json`。
- 首次发版前需生成签名密钥并配置 `TAURI_SIGNING_PRIVATE_KEY` 等 Secrets，详见 **[docs/UPDATER.md](./docs/UPDATER.md)**。
- 本地校验版本与更新器配置：`node scripts/verify-updater-config.mjs vX.Y.Z`。

---

## ⌨️ 常用快捷键

| 操作 | 快捷键 |
|---|---|
| 命令面板 | `Ctrl+Shift+P` |
| 全局搜索（内容） | `Ctrl+Shift+F` |
| 打开仓库 / 文件夹 | `Ctrl+O` |
| 关闭当前标签页 / 工作区 | `Ctrl+W` |
| 切换工作区 | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| 切换标签页 | `Ctrl+PageUp` / `Ctrl+PageDown` |
| 直接跳转第 N 个工作区 | `Alt+1` … `Alt+9` |
| 工作区文件列表上下移动 | `Alt+↑` / `Alt+↓` |
| 提交 | 提交框内 `Ctrl+Enter` |
| 分支切换面板 | `Ctrl+B` |

---

## 📁 项目结构

```
git-hunk/
├─ src/                     # 前端（React + TS）
│  ├─ App.tsx               # 应用壳、状态管理、快捷键
│  ├─ api.ts                # 类型化封装所有 Tauri invoke
│  ├─ types.ts              # 与 Rust model.rs 对应的 TS 类型
│  ├─ historyTypes.ts       # 提交历史相关类型
│  ├─ highlighter.ts        # Shiki 高亮
│  ├─ commands/             # 命令注册框架与内置命令
│  ├─ components/           # 各功能面板与视图组件
│  └─ utils/                # 工具函数（含 __tests__）
├─ src-tauri/               # 后端（Rust + Tauri）
│  ├─ src/
│  │  ├─ lib.rs             # 应用入口、命令注册、托盘、窗口事件
│  │  ├─ git.rs             # git2 接入：status / diff / hunk / 提交
│  │  ├─ history.rs         # 提交历史、DAG 泳道算法、提交文件对
│  │  ├─ operations.rs      # 分支 / 远端 / Stash / Tag 等写操作
│  │  ├─ catalog.rs         # 仓库管理中心与项目分组
│  │  ├─ content_search.rs  # 全局内容搜索
│  │  ├─ project_scripts.rs # 项目脚本解析
│  │  ├─ script_runner.rs   # 脚本并发执行与事件流
│  │  ├─ state.rs           # 多工作区状态容器
│  │  ├─ watcher.rs         # 状态变化监听
│  │  └─ *_tests.rs         # 后端测试
│  └─ tauri.conf.json
├─ docs/                    # 规划与阶段报告
├─ scripts/                 # 验证 / 冒烟脚本
└─ .github/workflows/       # CI：测试 + 三平台打包 + Release
```

---

## 🗺️ 路线图与已知限制

当前已覆盖规划中的 **M0 / P1 / P2** 主体能力（工作区、变更、历史图、审查页、分支、远程、Stash、标签、搜索、脚本）。

尚未完成的能力：

- **AI 辅助**（commit message / 冲突建议 / 自然语言命令 / diff 总结）——规划中，尚未接入。
- **三方合并冲突解决视图**：冲突文件可被识别与标记，但可视化逐块解决尚未实现。
- **内嵌终端**：目前通过系统默认终端打开目录，内置 PTY 终端（xterm.js）在规划中。
- **大仓库性能**：内容搜索有文件数与超时上限，超大仓库首屏历史仍在优化。
- **跨平台**：Windows 优先；macOS / Linux 已接入 CI 构建，但未做完整功能验收。

> 历史阶段报告：[M0](./docs/M0-REPORT.md) · [P1 提交图](./docs/P1-GRAPH-REPORT.md) · [P2 审查页](./docs/P2-REVIEW-PAGE-REPORT.md)

---

## 🤝 参与贡献

欢迎提交 Issue 与 PR。提交前请确保：

```bash
pnpm test                                               # 前端测试通过
pnpm build                                              # 类型检查 + 构建通过
cargo test --manifest-path src-tauri/Cargo.toml         # 后端测试通过
```

## 📄 许可证

[MIT](./LICENSE) © 2026 jpzuo
