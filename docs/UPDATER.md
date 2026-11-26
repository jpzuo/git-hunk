# 发版与自动更新

git-hunk 使用 [Tauri v2 Updater](https://v2.tauri.app/plugin/updater/) 实现应用内自动更新：启动后静默检查、发现新版本时提示、由用户确认后下载并安装，安装包经过签名校验。

## 发布策略

- **推 `main` 自动发版**：CI 读取 `src-tauri/tauri.conf.json` 的 `version`，若远端尚无对应的 `vX.Y.Z` 标签，则**自动创建标签并发布正式 Release**；若标签已存在且 Release 已发布，则**跳过（幂等）**，重推 main 不会重复发版。
- **改版本号即发版**：要让新版本发布，只需把三处版本号一起改大再推 main。
- 也可直接推送 `v*` 标签（`git tag v0.3.0 && git push origin v0.3.0`），或以 `workflow_dispatch` 手动触发。
- 更新源为 GitHub 的「latest」Release：
  `https://github.com/jpzuo/git-hunk/releases/latest/download/latest.json`
- 应用内部版本号必须是**纯 SemVer**（如 `0.2.0`，不能带 `v`）；`v` 只出现在标签与 Release 名上。
- 标签版本**必须**与 `src-tauri/tauri.conf.json` 的 `version` 完全一致，否则 `latest.json` 会指向错误版本，导致更新失效或死循环。CI 的 `guard` 作业会在发布前强制校验。

## 一次性配置（仓库维护者）

### 1. 生成签名密钥

```bash
pnpm tauri signer generate -w ~/.tauri/git-hunk.key
```

- 输出中包含**公钥**与**私钥**。
- 私钥**绝不能**提交到仓库；一旦丢失，已安装用户将**永久无法自动升级**，请离线妥善备份。

### 2. 填入公钥

把公钥内容（不是文件路径）填入 `src-tauri/tauri.conf.json`：

```jsonc
"plugins": {
  "updater": {
    "pubkey": "<你的公钥内容>",
    "endpoints": ["https://github.com/jpzuo/git-hunk/releases/latest/download/latest.json"]
  }
}
```

> 当前仓库里是占位符 `REPLACE_WITH_YOUR_UPDATER_PUBLIC_KEY`，`scripts/verify-updater-config.mjs` 会拒绝占位符，务必替换。

### 3. 配置 GitHub Secrets

在仓库 Settings → Secrets and variables → Actions 添加：

| Secret | 值 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | 私钥文件内容（或路径） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成时设置的密码（无密码则为空字符串） |

### 4. 清理历史遗留的滚动 Release

旧流程会在每次 `main` 推送时删除重建名为 `latest` 的 Release/标签，会抢占 GitHub 的 "latest"。改用标签发版后，执行一次：

```bash
git push origin :refs/tags/latest     # 删除远端 latest 标签
gh release delete latest --cleanup-tag
```

## 发版流程

**推荐（自动打标）**：只改版本号，推 main 即可。

```bash
# 1. 同步版本号（三处必须一致）：package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json
#    例如都改为 0.3.0
# 2. 本地校验（建议）
node scripts/verify-updater-config.mjs v0.3.0
# 3. 提交并推送 main
git add -A && git commit -m "chore: release v0.3.0"
git push origin main
```

CI 会自动：`guard` 校验 → `prepare` 发现 `v0.3.0` 不存在则创建并推送该标签 → 三平台构建 → `tauri-action` 创建 Release、上传安装包与 `.sig`、合并生成 `latest.json` → `verify` 断言 `latest.json` 含 Windows/Linux 条目。若版本未变重推 main，`prepare` 判定已发布而跳过，不重复发版。

**备选（手动打标签）**：

```bash
git tag v0.3.0 && git push origin v0.3.0
```

> 注意：`GITHUB_TOKEN` 推送的标签不会再次触发工作流（GitHub 防递归），所以发版必须在**同一次运行**内完成——工作流已用 `prepare` 产出标签、`package` 直接用该标签构建发布来满足这一点。

## 平台支持现状

| 平台 | 更新包 | 说明 |
|---|---|---|
| Windows | NSIS `setup.exe`（`.sig` 同目录） | `installMode` 默认 `passive`（带进度、无需交互）。安装时应用会被强制结束并重启 |
| Linux | AppImage | **仅 AppImage 可自动更新**；`deb` 用户需手动升级 |
| macOS | 暂不支持 | 本期通过 `src-tauri/tauri.macos.conf.json` 关闭了 updater 产物（无 Apple 签名/公证，Gatekeeper 会阻止安装）。仍可照常下载 dmg 手动安装 |

> `latest.json` 中的平台键为 `OS-ARCH`（如 `windows-x86_64`、`linux-x86_64`、`darwin-aarch64`）。macOS 因未产出 `.sig`，不会出现在该文件中，macOS 端检查时视为「无更新」。

## 代码结构

- 后端：`src-tauri/src/update.rs` —— `update_check` / `update_install` 两个命令，进度通过 `ipc::Channel` 推送；安装前置位 `AppState::allow_exit` 放行「关闭即隐藏到托盘」的退出拦截。
- 前端：`src/updater/useUpdater.ts`（状态机）、`src/updater/updateUtils.ts`（纯函数）、`src/components/UpdateBanner.tsx`（标题栏下方提示条）、`src/components/UpdateDialog.tsx`（关于/检查更新弹窗）。状态栏右下角显示当前版本，可按需点击检查。
- 命令面板：`App: Check for Updates` / `App: About git-hunk`。

## 回滚

Updater 默认只安装「更高版本」，不自动降级。若需回滚，让用户手动下载并安装旧版本安装包即可。

## 常见问题

- **本地 `tauri build` 失败（缺签名密钥）**：`createUpdaterArtifacts: true` 时打包需要私钥。可设置环境变量，或临时关闭：`pnpm tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'`。`--no-bundle` 不受影响。
- **检查更新报 404 / 空**：确认已发布过 `v*` Release 且其中含 `latest.json`；私有仓库的 `releases/latest/download/*` 需鉴权，当前方案假设仓库为公开仓库。
- **Windows 更新后没有重启**：属正常，安装器会自行重启；若未重启手动打开即可。
