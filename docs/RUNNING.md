# 运行指南

## 重要：为什么 debug 版会显示空白/错误网页

Tauri 在 **debug 模式**下不内嵌前端资源，而是连接 `tauri.conf.json` 里的 `devUrl`（`http://localhost:1420`）。
如果 1420 端口上没有 Vite 开发服务器在运行，窗口里就是一个**连接失败的网页**，而不是应用界面。

所以：

- **要看界面效果** → 运行 **release 版**（内嵌前端），或
- **要开发调试** → 用 `pnpm tauri dev`（会自动启动开发服务器）

直接双击 `target\debug\git-hunk.exe` 是**不行的**，除非同时开着 `pnpm dev`。

## 方式一：直接运行（最快，仅看效果）

```powershell
cd E:\oneself\git-hunk
E:\oneself\git-hunk\src-tauri\target\release\git-hunk.exe
```

如果还没构建过 release：

```powershell
cd E:\oneself\git-hunk
pnpm tauri build --no-bundle
```

产物：`src-tauri\target\release\git-hunk.exe`

> `--no-bundle` 表示只生成 exe，不打包 msi/安装程序，速度快很多。

## 方式二：开发模式（改代码用这个）

```powershell
cd E:\oneself\git-hunk
pnpm tauri dev
```

- 自动启动 Vite 开发服务器（端口 1420）并编译 Rust
- **改前端代码热更新**，改 Rust 代码自动重新编译并重启
- 首次编译依赖需要几分钟，之后增量编译很快

必须**保持这个终端窗口开着**，关掉就等于关掉开发服务器，应用也就无法加载。

## 方式三：打包安装包

```powershell
cd E:\oneself\git-hunk
pnpm tauri build
```

产物在 `src-tauri\target\release\bundle\`：
- `msi\git-hunk_0.1.0_x64_en-US.msi`
- `nsis\git-hunk_0.1.0_x64-setup.exe`

## 打开仓库时注意

应用启动后点左上角 **📂** 图标选择仓库目录。该目录**必须本身就是 Git 仓库**（即包含 `.git` 目录），
否则会报 `could not find repository`。

`E:\oneself\git-hunk` 本身不是 Git 仓库，选它就会报错。可以用 `E:\tmp\git-hunk-demo`
（本机已有的演示仓库），或者你自己的任意 git 项目目录。

## 前置依赖

| 依赖 | 说明 |
|---|---|
| **git** | 必需。hunk 级暂存/丢弃依赖系统 `git apply`。`git --version` 应可用 |
| MSVC Build Tools | 编译 Rust 后端需要（本机已安装 VS Build Tools 2022） |
| Node 24 + pnpm | 前端构建 |

## 界面操作速查

| 操作 | 快捷键 / 位置 |
|---|---|
| 打开命令面板 | `Ctrl+Shift+P` |
| 切换终端抽屉 | `` Ctrl+` `` |
| 打开仓库 | 左上角 📂 图标 |
| 查看文件 diff | 点击 Source Control 里的文件名 |
| hunk 级暂存/丢弃 | diff 里每个 hunk 头部的按钮 |
| 提交 | 左侧提交框 + `Ctrl+Enter` 或点「提交」 |
| 切换双栏/单栏 diff | diff 工具栏右上角 |

## 当前已知限制

- **终端是占位**：打开后只显示说明文字，真实 shell（xterm.js + PTY）在 MVP 阶段接入
- **单仓库**：一次只能打开一个仓库
- **无冲突解决视图**：冲突文件能识别并标记，三方合并界面在 v1
- diff 为自研轻量渲染，大文件性能与语法高亮待优化