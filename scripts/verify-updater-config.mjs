#!/usr/bin/env node
/**
 * 校验发版前置条件：
 * 1) package.json / Cargo.toml / tauri.conf.json 三处版本一致且为纯 SemVer；
 * 2) 若传入标签（如 v0.2.0），标签版本必须与应用版本一致；
 * 3) 更新器配置完整：pubkey 已填、endpoints 为 HTTPS、createUpdaterArtifacts 为 true；
 * 4) macOS 覆盖配置关闭了 updater 产物（macOS 本期暂缓自动更新）；
 * 5) CI 工作流注入了签名密钥并在 v* 标签触发。
 *
 * 用法：node scripts/verify-updater-config.mjs [vX.Y.Z]
 * 退出码 0 表示通过，1 表示失败。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

let failures = 0;
const ok = (msg) => console.log(`  PASS ${msg}`);
const bad = (msg) => {
  console.error(`  FAIL ${msg}`);
  failures++;
};

function checkVersionConsistency() {
  const pkg = JSON.parse(read("package.json"));
  const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
  const cargo = read("src-tauri/Cargo.toml");
  // 只取 [package] 段内的第一个 version =
  const cargoVersion = (cargo.match(/^\s*version\s*=\s*"([^"]+)"/m) || [])[1];

  const versions = {
    "package.json": pkg.version,
    "src-tauri/tauri.conf.json": tauri.version,
    "src-tauri/Cargo.toml": cargoVersion,
  };
  console.log("== 版本一致性 ==");
  for (const [file, v] of Object.entries(versions)) {
    if (!v) bad(`${file} 缺少 version 字段`);
    else if (!SEMVER.test(v)) bad(`${file} 版本 "${v}" 不是纯 SemVer（不能带 v 前缀）`);
    else ok(`${file} = ${v}`);
  }
  const uniq = new Set(Object.values(versions).filter(Boolean));
  if (uniq.size === 1) ok(`三处版本一致：${[...uniq][0]}`);
  else bad(`三处版本不一致：${JSON.stringify(versions)}`);
  return [...uniq][0];
}

function checkTag(tag, appVersion) {
  if (!tag) {
    console.log("== 标签校验 == 未传入标签，跳过");
    return;
  }
  console.log("== 标签校验 ==");
  if (!/^v\d+\.\d+\.\d+/.test(tag)) {
    bad(`标签 "${tag}" 不是 vX.Y.Z 形式`);
    return;
  }
  const tagVersion = tag.replace(/^v/, "");
  if (tagVersion !== appVersion) {
    bad(`标签版本 ${tagVersion} 与应用版本 ${appVersion} 不一致（会导致更新死循环）`);
  } else {
    ok(`标签 ${tag} 与应用版本一致`);
  }
}

function checkUpdaterConfig() {
  const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
  console.log("== 更新器配置 ==");
  const bundle = tauri.bundle || {};
  if (bundle.createUpdaterArtifacts === true) ok("bundle.createUpdaterArtifacts = true");
  else bad("bundle.createUpdaterArtifacts 必须为 true");

  const updater = (tauri.plugins || {}).updater;
  if (!updater) {
    bad("缺少 plugins.updater 配置");
    return;
  }
  const pubkey = (updater.pubkey || "").trim();
  if (!pubkey) bad("plugins.updater.pubkey 为空");
  else if (/REPLACE_WITH|PLACEHOLDER|YOUR_/i.test(pubkey)) bad("plugins.updater.pubkey 仍是占位符，请填入真实公钥");
  else ok("plugins.updater.pubkey 已配置");

  const endpoints = Array.isArray(updater.endpoints) ? updater.endpoints : [];
  if (endpoints.length === 0) bad("plugins.updater.endpoints 为空");
  else if (!endpoints.every((e) => typeof e === "string" && e.startsWith("https://")))
    bad("plugins.updater.endpoints 必须全部为 HTTPS");
  else ok(`endpoints 数量 ${endpoints.length}，均为 HTTPS`);
}

function checkMacOverride() {
  console.log("== macOS 覆盖配置 ==");
  try {
    const mac = JSON.parse(read("src-tauri/tauri.macos.conf.json"));
    if (mac.bundle && mac.bundle.createUpdaterArtifacts === false)
      ok("tauri.macos.conf.json 关闭了 updater 产物");
    else bad("tauri.macos.conf.json 应设置 bundle.createUpdaterArtifacts = false");
  } catch {
    bad("缺少 tauri.macos.conf.json（用于在 macOS 上关闭 updater 产物）");
  }
}

function checkWorkflow() {
  console.log("== CI 工作流 ==");
  const yml = read(".github/workflows/build.yml");

  if (yml.includes("TAURI_SIGNING_PRIVATE_KEY")) ok("已注入签名密钥环境变量");
  else bad("工作流缺少 TAURI_SIGNING_PRIVATE_KEY");

  if (/tags:\s*\n\s*-\s*["']?v\*/.test(yml) || yml.includes('"v*"')) ok("配置了 v* 标签触发");
  else bad("工作流缺少 v* 标签触发");

  // 自动发版：需要 prepare 作业产出 should_publish，并有 contents: write
  if (yml.includes("should_publish")) ok("包含自动打标/发版判定（should_publish）");
  else bad("工作流缺少自动打标/发版判定（prepare → should_publish）");
  if (/contents:\s*write/.test(yml)) ok("具备 contents: write 权限");
  else bad("工作流缺少 contents: write 权限（无法创建标签/Release）");

  // tauri-action 版本与其输入名必须匹配（本项目曾因 v0 用了 v1 输入名而静默失效）
  const m = yml.match(/tauri-apps\/tauri-action@(v[0-9][^\s]*)/);
  if (!m) {
    bad("未找到 tauri-apps/tauri-action 引用");
  } else {
    const ref = m[1];
    const majorVersion = /^v0\b/.test(ref) ? 0 : /^v1\b/.test(ref) ? 1 : null;
    ok(`tauri-action 版本：${ref}`);
    if (majorVersion === 0) {
      const v1Only = ["uploadUpdaterSignatures", "workflowArtifactNamePattern", "uploadUpdaterJson", "releaseAssetNamePattern"];
      const used = v1Only.filter((k) => yml.includes(k));
      if (used.length) bad(`tauri-action@${ref} 不支持 v1 输入：${used.join(", ")}（v0 请用 includeUpdaterJson / assetNamePattern）`);
      else ok("v0 输入名匹配");
    } else if (majorVersion === 1) {
      const v0Only = ["includeUpdaterJson", "assetNamePattern", "updaterJsonKeepUniversal", "includeDebug", "includeRelease"];
      const used = v0Only.filter((k) => yml.includes(k));
      if (used.length) bad(`tauri-action@${ref} 不支持 v0 输入：${used.join(", ")}（v1 请用 uploadUpdaterJson / releaseAssetNamePattern）`);
      else ok("v1 输入名匹配");
    }
  }

  if (yml.includes("uploadUpdaterJson")) ok("启用了 latest.json 生成");
  else bad("工作流未启用 uploadUpdaterJson");
}

function checkSigningSecret() {
  console.log("== 签名密钥配置（CI 环境） ==");
  const hasKey = process.env.HAS_SIGNING_KEY;
  if (hasKey === undefined) {
    console.log("  SKIP 未在 CI 环境中运行，跳过密钥存在性检查");
    return;
  }
  if (hasKey === "true") ok("已配置 TAURI_SIGNING_PRIVATE_KEY Secret");
  else bad("未配置 TAURI_SIGNING_PRIVATE_KEY Secret：有公钥而无私钥时 tauri build 会直接失败");
}

function checkEndpointSlug() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.log("== 更新源仓库校验 == 未提供 GITHUB_REPOSITORY，跳过");
    return;
  }
  console.log("== 更新源仓库校验 ==");
  const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
  const endpoints = ((tauri.plugins || {}).updater || {}).endpoints || [];
  if (endpoints.some((e) => e.includes(repo))) ok(`endpoints 指向当前仓库 ${repo}`);
  else bad(`endpoints 未指向当前仓库 ${repo}（${endpoints.join(", ")}）`);
}

const tag = process.argv[2] || "";
const appVersion = checkVersionConsistency();
checkTag(tag, appVersion);
checkUpdaterConfig();
checkMacOverride();
checkWorkflow();
checkSigningSecret();
checkEndpointSlug();

console.log("");
if (failures === 0) {
  console.log("全部校验通过 ✅");
  process.exit(0);
} else {
  console.error(`校验失败：${failures} 项 ❌`);
  process.exit(1);
}
