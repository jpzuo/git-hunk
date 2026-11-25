//! 多语言项目可执行脚本自动发现与解析引擎。
//!
//! 自动扫描工作区根目录及浅层子项目目录（depth <= 2，支持前后端混合工程与 Monorepo），
//! 识别主流语言的包管理器与自动化任务配置并生成标准化可执行命令：
//! - 前端 / Node.js (`package.json` + pnpm/yarn/bun/npm 锁文件识别)
//! - Rust (`Cargo.toml` / `.cargo/config.toml`)
//! - Python (`pyproject.toml` / `uv.lock` / `poetry.lock` / `manage.py` / `.venv`)
//! - Go (`go.mod` / `cmd/*/main.go`)
//! - Java / Kotlin (`pom.xml` / `build.gradle(.kts)` / `mvnw` / `gradlew`)
//! - .NET / C# (`*.sln` / `*.csproj`)
//! - PHP (`composer.json`) & Ruby (`Rakefile`)
//! - 通用构建工具 (`Makefile` / `justfile` / `Taskfile.yml`)
//! - VS Code (`tasks.json`) & Docker Compose (`compose.yaml` / `docker-compose.yml`)

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ScriptItem {
    pub id: String,
    pub name: String,
    pub ecosystem: String,
    pub source_label: String,
    pub source_file: String,
    pub cwd: String,
    pub program: String,
    pub args: Vec<String>,
    pub display_command: String,
    pub detail: Option<String>,
    pub is_long_running: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ScriptGroup {
    pub key: String,
    pub ecosystem: String,
    pub source_label: String,
    pub source_file: String,
    pub cwd: String,
    pub package_manager: Option<String>,
    pub scripts: Vec<ScriptItem>,
}

const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    ".pnpm-store",
    "__pycache__",
    ".venv",
    "venv",
    ".next",
    ".nuxt",
    ".turbo",
    "dist",
    "build",
    "out",
    "coverage",
    ".idea",
    "vendor",
];

fn is_long_running_script(name: &str, cmd_hint: &str) -> bool {
    let n = name.to_lowercase();
    let c = cmd_hint.to_lowercase();
    let exact_or_part = [
        "dev",
        "start",
        "serve",
        "watch",
        "preview",
        "runserver",
        "bootrun",
        "storybook",
    ];
    if exact_or_part
        .iter()
        .any(|kw| n == *kw || n.ends_with(&format!(":{kw}")) || n.ends_with(&format!("-{kw}")))
    {
        return true;
    }
    if n == "up" || n == "logs" {
        return true;
    }
    c.contains("--watch")
        || c.contains("cargo watch")
        || c.contains("next dev")
        || c.contains("nuxt dev")
        || c.contains("nodemon")
        || (c.starts_with("vite") && !c.contains("build"))
}

fn rel_path_unix(workdir: &Path, path: &Path) -> String {
    match path.strip_prefix(workdir) {
        Ok(rel) => {
            let s = rel.to_string_lossy().replace('\\', "/");
            if s.is_empty() {
                ".".to_string()
            } else {
                s
            }
        }
        Err(_) => ".".to_string(),
    }
}

fn rel_join(cwd: &str, filename: &str) -> String {
    if cwd == "." {
        filename.to_string()
    } else {
        format!("{cwd}/{filename}")
    }
}

fn make_cmd_item(
    ecosystem: &str,
    source_label: &str,
    source_file: &str,
    cwd: &str,
    name: String,
    program: &str,
    args: Vec<String>,
    display_command: String,
    detail: Option<String>,
) -> ScriptItem {
    let is_long_running =
        is_long_running_script(&name, detail.as_deref().unwrap_or(&display_command));
    ScriptItem {
        id: format!("{ecosystem}:{cwd}:{source_file}:{name}"),
        name,
        ecosystem: ecosystem.to_string(),
        source_label: source_label.to_string(),
        source_file: source_file.to_string(),
        cwd: cwd.to_string(),
        program: program.to_string(),
        args,
        display_command,
        detail,
        is_long_running,
    }
}

/// 剥离 JSONC 注释（`//` 与 `/* ... */`）及末尾多余逗号，供 `.vscode/tasks.json` 解析使用。
pub fn strip_jsonc(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let len = chars.len();
    let mut no_comments = String::with_capacity(input.len());
    let mut i = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    while i < len {
        let ch = chars[i];
        if in_string {
            no_comments.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }

        if ch == '"' {
            in_string = true;
            no_comments.push(ch);
            i += 1;
            continue;
        }

        if ch == '/' && i + 1 < len {
            if chars[i + 1] == '/' {
                i += 2;
                while i < len && chars[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            if chars[i + 1] == '*' {
                i += 2;
                while i + 1 < len && !(chars[i] == '*' && chars[i + 1] == '/') {
                    if chars[i] == '\n' {
                        no_comments.push('\n');
                    }
                    i += 1;
                }
                i = (i + 2).min(len);
                continue;
            }
        }

        no_comments.push(ch);
        i += 1;
    }

    // 去除对象或数组闭合前的尾随逗号
    let out_chars: Vec<char> = no_comments.chars().collect();
    let out_len = out_chars.len();
    let mut final_out = String::with_capacity(no_comments.len());
    in_string = false;
    escaped = false;
    i = 0;

    while i < out_len {
        let ch = out_chars[i];
        if in_string {
            final_out.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if ch == '"' {
            in_string = true;
            final_out.push(ch);
            i += 1;
            continue;
        }
        if ch == ',' {
            let mut j = i + 1;
            while j < out_len && out_chars[j].is_whitespace() {
                j += 1;
            }
            if j < out_len && (out_chars[j] == '}' || out_chars[j] == ']') {
                i += 1;
                continue;
            }
        }
        final_out.push(ch);
        i += 1;
    }

    final_out
}

fn detect_node_pm(dir: &Path, workdir: &Path, pkg_json: &serde_json::Value) -> String {
    if let Some(pm) = pkg_json.get("packageManager").and_then(|v| v.as_str()) {
        if pm.starts_with("pnpm@") || pm == "pnpm" {
            return "pnpm".to_string();
        }
        if pm.starts_with("yarn@") || pm == "yarn" {
            return "yarn".to_string();
        }
        if pm.starts_with("bun@") || pm == "bun" {
            return "bun".to_string();
        }
        if pm.starts_with("npm@") || pm == "npm" {
            return "npm".to_string();
        }
    }

    let check_locks = |base: &Path| -> Option<&'static str> {
        if base.join("pnpm-lock.yaml").exists() {
            return Some("pnpm");
        }
        if base.join("yarn.lock").exists() {
            return Some("yarn");
        }
        if base.join("bun.lock").exists() || base.join("bun.lockb").exists() {
            return Some("bun");
        }
        if base.join("package-lock.json").exists() {
            return Some("npm");
        }
        None
    };

    if let Some(pm) = check_locks(dir) {
        return pm.to_string();
    }
    let mut cur = dir.parent();
    while let Some(p) = cur {
        if let Some(pm) = check_locks(p) {
            return pm.to_string();
        }
        if p == workdir {
            break;
        }
        cur = p.parent();
    }

    if workdir.join("pnpm-workspace.yaml").exists() {
        return "pnpm".to_string();
    }
    "npm".to_string()
}

fn script_priority(name: &str) -> (u8, String) {
    let lower = name.to_lowercase();
    let rank = if lower == "dev" || lower.starts_with("dev:") {
        0
    } else if lower == "start" || lower == "serve" || lower == "preview" {
        1
    } else if lower == "build" || lower.starts_with("build:") {
        2
    } else if lower == "test" || lower.starts_with("test:") {
        3
    } else if lower == "lint" || lower == "check" || lower == "typecheck" || lower == "format" {
        4
    } else {
        5
    };
    (rank, lower)
}

fn parse_node_scripts(workdir: &Path, dir: &Path, cwd: &str) -> Option<ScriptGroup> {
    let pkg_path = dir.join("package.json");
    if !pkg_path.is_file() {
        return None;
    }
    let raw = std::fs::read_to_string(&pkg_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let scripts_obj = json.get("scripts")?.as_object()?;
    if scripts_obj.is_empty() {
        return None;
    }

    let pm = detect_node_pm(dir, workdir, &json);
    let pkg_name = json
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string);
    let source_file = rel_join(cwd, "package.json");
    let source_label = match pkg_name {
        Some(n) if cwd != "." => format!("{n} ({pm}) · {cwd}"),
        _ => format!("Node / 前端 ({pm}) · {source_file}"),
    };

    let mut entries: Vec<(&String, &serde_json::Value)> = scripts_obj.iter().collect();
    entries.sort_by(|(a, _), (b, _)| script_priority(a).cmp(&script_priority(b)));

    let mut items = Vec::with_capacity(entries.len());
    for (name, cmd_val) in entries {
        let Some(raw_cmd) = cmd_val.as_str() else {
            continue;
        };
        let display = format!("{pm} run {name}");
        items.push(make_cmd_item(
            "node",
            &source_label,
            &source_file,
            cwd,
            name.clone(),
            &pm,
            vec!["run".to_string(), name.clone()],
            display,
            Some(raw_cmd.to_string()),
        ));
    }

    if items.is_empty() {
        None
    } else {
        Some(ScriptGroup {
            key: format!("node:{cwd}"),
            ecosystem: "node".to_string(),
            source_label,
            source_file,
            cwd: cwd.to_string(),
            package_manager: Some(pm),
            scripts: items,
        })
    }
}

fn parse_rust_scripts(dir: &Path, cwd: &str) -> Option<ScriptGroup> {
    let cargo_path = dir.join("Cargo.toml");
    if !cargo_path.is_file() {
        return None;
    }
    let raw = std::fs::read_to_string(&cargo_path).ok()?;
    let doc: toml::Value = toml::from_str(&raw).ok()?;

    let pkg_name = doc
        .get("package")
        .and_then(|p| p.get("name"))
        .and_then(|n| n.as_str())
        .map(str::to_string);
    let has_workspace = doc.get("workspace").is_some();
    let has_main = dir.join("src/main.rs").is_file();
    let bins: Vec<String> = doc
        .get("bin")
        .and_then(|b| b.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.get("name").and_then(|n| n.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    let source_file = rel_join(cwd, "Cargo.toml");
    let label_suffix = pkg_name
        .as_deref()
        .map(|n| format!("{n} · {source_file}"))
        .unwrap_or_else(|| source_file.clone());
    let source_label = format!("Rust (Cargo) · {label_suffix}");

    let mut items = Vec::new();
    let mut add = |name: &str, args: Vec<String>, detail: &str| {
        let display = format!("cargo {}", args.join(" "));
        items.push(make_cmd_item(
            "rust",
            &source_label,
            &source_file,
            cwd,
            name.to_string(),
            "cargo",
            args,
            display,
            Some(detail.to_string()),
        ));
    };

    if has_main {
        add("run", vec!["run".into()], "编译并运行默认二进制目标");
    }
    for bin_name in &bins {
        add(
            &format!("run ({bin_name})"),
            vec!["run".into(), "--bin".into(), bin_name.clone()],
            &format!("运行二进制目标 {bin_name}"),
        );
    }

    let test_args = if has_workspace {
        vec!["test".into(), "--workspace".into()]
    } else {
        vec!["test".into()]
    };
    add("test", test_args, "运行全部 Rust 单元测试与集成测试");
    add("check", vec!["check".into()], "快速类型与借用检查");
    add("build", vec!["build".into()], "构建 Debug 产物");
    add(
        "build --release",
        vec!["build".into(), "--release".into()],
        "构建 Release 优化产物",
    );
    add("clippy", vec!["clippy".into()], "运行 Clippy 代码质量检查");
    add(
        "fmt --check",
        vec!["fmt".into(), "--check".into()],
        "检查代码格式化规范",
    );

    // 解析 .cargo/config.toml 中的自定义 [alias]
    let config_path = dir.join(".cargo/config.toml");
    if config_path.is_file() {
        if let Ok(cfg_raw) = std::fs::read_to_string(&config_path) {
            if let Ok(cfg_doc) = toml::from_str::<toml::Value>(&cfg_raw) {
                if let Some(aliases) = cfg_doc.get("alias").and_then(|v| v.as_table()) {
                    for (alias_name, target_val) in aliases {
                        let detail_txt = target_val
                            .as_str()
                            .map(str::to_string)
                            .or_else(|| {
                                target_val.as_array().map(|a| {
                                    a.iter()
                                        .filter_map(|x| x.as_str())
                                        .collect::<Vec<_>>()
                                        .join(" ")
                                })
                            })
                            .unwrap_or_default();
                        add(
                            &format!("alias: {alias_name}"),
                            vec![alias_name.clone()],
                            &format!(".cargo/config.toml alias -> {detail_txt}"),
                        );
                    }
                }
            }
        }
    }

    Some(ScriptGroup {
        key: format!("rust:{cwd}"),
        ecosystem: "rust".to_string(),
        source_label,
        source_file,
        cwd: cwd.to_string(),
        package_manager: Some("cargo".to_string()),
        scripts: items,
    })
}

fn detect_python_runner(dir: &Path, workdir: &Path) -> (String, Vec<String>, String) {
    if dir.join("uv.lock").exists() || workdir.join("uv.lock").exists() {
        return ("uv".into(), vec!["run".into()], "uv".into());
    }
    if dir.join("poetry.lock").exists() || workdir.join("poetry.lock").exists() {
        return ("poetry".into(), vec!["run".into()], "poetry".into());
    }
    #[cfg(target_os = "windows")]
    {
        if dir.join(".venv/Scripts/python.exe").exists() {
            return (".venv\\Scripts\\python.exe".into(), Vec::new(), ".venv".into());
        }
        if workdir.join(".venv/Scripts/python.exe").exists() {
            return (
                workdir
                    .join(".venv/Scripts/python.exe")
                    .to_string_lossy()
                    .to_string(),
                Vec::new(),
                ".venv".into(),
            );
        }
        ("python".into(), Vec::new(), "python".into())
    }
    #[cfg(not(target_os = "windows"))]
    {
        if dir.join(".venv/bin/python").exists() {
            return (".venv/bin/python".into(), Vec::new(), ".venv".into());
        }
        if workdir.join(".venv/bin/python").exists() {
            return (
                workdir
                    .join(".venv/bin/python")
                    .to_string_lossy()
                    .to_string(),
                Vec::new(),
                ".venv".into(),
            );
        }
        ("python3".into(), Vec::new(), "python3".into())
    }
}

fn parse_python_scripts(workdir: &Path, dir: &Path, cwd: &str) -> Option<ScriptGroup> {
    let pyproject_path = dir.join("pyproject.toml");
    let manage_path = dir.join("manage.py");
    if !pyproject_path.is_file() && !manage_path.is_file() {
        return None;
    }

    let (py_prog, py_prefix_args, pm_label) = detect_python_runner(dir, workdir);
    let source_file = if pyproject_path.is_file() {
        rel_join(cwd, "pyproject.toml")
    } else {
        rel_join(cwd, "manage.py")
    };
    let source_label = format!("Python ({pm_label}) · {source_file}");

    let mut items = Vec::new();
    let mut seen_names = HashSet::new();

    if manage_path.is_file() {
        for (name, sub, desc) in [
            ("runserver", "runserver", "启动 Django 开发服务器"),
            ("test", "test", "运行 Django 测试套件"),
            ("migrate", "migrate", "执行数据库迁移"),
        ] {
            let mut args = py_prefix_args.clone();
            if !py_prefix_args.is_empty() {
                args.push("python".into());
            }
            args.push("manage.py".into());
            args.push(sub.into());
            let display = format!("{py_prog} {}", args.join(" "));
            seen_names.insert(name.to_string());
            items.push(make_cmd_item(
                "python",
                &source_label,
                &source_file,
                cwd,
                name.to_string(),
                &py_prog,
                args,
                display,
                Some(desc.into()),
            ));
        }
    }

    if pyproject_path.is_file() {
        if let Ok(raw) = std::fs::read_to_string(&pyproject_path) {
            if let Ok(doc) = toml::from_str::<toml::Value>(&raw) {
                let collect_table =
                    |table: Option<&toml::map::Map<String, toml::Value>>,
                     runner_kind: &str,
                     out: &mut Vec<ScriptItem>,
                     seen: &mut HashSet<String>| {
                        let Some(tbl) = table else { return };
                        for (k, v) in tbl {
                            if !seen.insert(k.clone()) {
                                continue;
                            }
                            let detail = v
                                .as_str()
                                .map(str::to_string)
                                .or_else(|| {
                                    v.get("cmd")
                                        .and_then(|c| c.as_str())
                                        .map(str::to_string)
                                })
                                .or_else(|| Some(format!("{runner_kind} 入口")));

                            let (prog, args) = match runner_kind {
                                "poe" => {
                                    if pm_label == "uv" || pm_label == "poetry" {
                                        (
                                            pm_label.clone(),
                                            vec!["run".into(), "poe".into(), k.clone()],
                                        )
                                    } else {
                                        ("poe".into(), vec![k.clone()])
                                    }
                                }
                                "pdm" => ("pdm".into(), vec!["run".into(), k.clone()]),
                                _ => {
                                    if !py_prefix_args.is_empty() {
                                        let mut a = py_prefix_args.clone();
                                        a.push(k.clone());
                                        (py_prog.clone(), a)
                                    } else {
                                        (k.clone(), Vec::new())
                                    }
                                }
                            };
                            let display = if args.is_empty() {
                                prog.clone()
                            } else {
                                format!("{prog} {}", args.join(" "))
                            };
                            out.push(make_cmd_item(
                                "python",
                                &source_label,
                                &source_file,
                                cwd,
                                k.clone(),
                                &prog,
                                args,
                                display,
                                detail,
                            ));
                        }
                    };

                let project_scripts = doc
                    .get("project")
                    .and_then(|p| p.get("scripts"))
                    .and_then(|s| s.as_table());
                let tool = doc.get("tool");
                let poetry_scripts = tool
                    .and_then(|t| t.get("poetry"))
                    .and_then(|p| p.get("scripts"))
                    .and_then(|s| s.as_table());
                let poe_tasks = tool
                    .and_then(|t| t.get("poe"))
                    .and_then(|p| p.get("tasks"))
                    .and_then(|s| s.as_table());
                let pdm_scripts = tool
                    .and_then(|t| t.get("pdm"))
                    .and_then(|p| p.get("scripts"))
                    .and_then(|s| s.as_table());

                collect_table(project_scripts, "script", &mut items, &mut seen_names);
                collect_table(poetry_scripts, "poetry", &mut items, &mut seen_names);
                collect_table(poe_tasks, "poe", &mut items, &mut seen_names);
                collect_table(pdm_scripts, "pdm", &mut items, &mut seen_names);

                let has_pytest = tool.and_then(|t| t.get("pytest")).is_some()
                    || dir.join("pytest.ini").is_file()
                    || dir.join("tests").is_dir();
                if has_pytest && !seen_names.contains("pytest") {
                    let (prog, args) = if !py_prefix_args.is_empty() {
                        let mut a = py_prefix_args.clone();
                        a.push("pytest".into());
                        (py_prog.clone(), a)
                    } else {
                        (py_prog.clone(), vec!["-m".into(), "pytest".into()])
                    };
                    let display = format!("{prog} {}", args.join(" "));
                    items.push(make_cmd_item(
                        "python",
                        &source_label,
                        &source_file,
                        cwd,
                        "pytest".into(),
                        &prog,
                        args,
                        display,
                        Some("运行 pytest 单元测试".into()),
                    ));
                }
            }
        }
    }

    if items.is_empty() {
        None
    } else {
        Some(ScriptGroup {
            key: format!("python:{cwd}"),
            ecosystem: "python".to_string(),
            source_label,
            source_file,
            cwd: cwd.to_string(),
            package_manager: Some(pm_label),
            scripts: items,
        })
    }
}

fn parse_go_scripts(dir: &Path, cwd: &str) -> Option<ScriptGroup> {
    let gomod = dir.join("go.mod");
    if !gomod.is_file() {
        return None;
    }
    let source_file = rel_join(cwd, "go.mod");
    let source_label = format!("Go · {source_file}");
    let mut items = Vec::new();

    if dir.join("main.go").is_file() {
        items.push(make_cmd_item(
            "go",
            &source_label,
            &source_file,
            cwd,
            "run".into(),
            "go",
            vec!["run".into(), ".".into()],
            "go run .".into(),
            Some("运行根目录 main.go 入口".into()),
        ));
    }

    let cmd_dir = dir.join("cmd");
    if cmd_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&cmd_dir) {
            let mut subnames = Vec::new();
            for e in entries.flatten() {
                if e.path().join("main.go").is_file() {
                    subnames.push(e.file_name().to_string_lossy().to_string());
                }
            }
            subnames.sort();
            for sub in subnames {
                let target = format!("./cmd/{sub}");
                items.push(make_cmd_item(
                    "go",
                    &source_label,
                    &source_file,
                    cwd,
                    format!("run ({sub})"),
                    "go",
                    vec!["run".into(), target.clone()],
                    format!("go run {target}"),
                    Some(format!("运行 cmd/{sub}/main.go")),
                ));
            }
        }
    }

    items.push(make_cmd_item(
        "go",
        &source_label,
        &source_file,
        cwd,
        "test".into(),
        "go",
        vec!["test".into(), "./...".into()],
        "go test ./...".into(),
        Some("运行全部 Go 包测试".into()),
    ));
    items.push(make_cmd_item(
        "go",
        &source_label,
        &source_file,
        cwd,
        "build".into(),
        "go",
        vec!["build".into(), "./...".into()],
        "go build ./...".into(),
        Some("编译全部 Go 包".into()),
    ));
    items.push(make_cmd_item(
        "go",
        &source_label,
        &source_file,
        cwd,
        "vet".into(),
        "go",
        vec!["vet".into(), "./...".into()],
        "go vet ./...".into(),
        Some("Go 静态检查".into()),
    ));

    Some(ScriptGroup {
        key: format!("go:{cwd}"),
        ecosystem: "go".to_string(),
        source_label,
        source_file,
        cwd: cwd.to_string(),
        package_manager: Some("go".to_string()),
        scripts: items,
    })
}

fn parse_java_scripts(workdir: &Path, dir: &Path, cwd: &str) -> Option<ScriptGroup> {
    let pom = dir.join("pom.xml");
    let gradle_kts = dir.join("build.gradle.kts");
    let gradle_groovy = dir.join("build.gradle");

    if pom.is_file() {
        let source_file = rel_join(cwd, "pom.xml");
        let (prog, label_pm) = if cfg!(target_os = "windows")
            && (dir.join("mvnw.cmd").is_file() || workdir.join("mvnw.cmd").is_file())
        {
            let p = if dir.join("mvnw.cmd").is_file() {
                "mvnw.cmd".to_string()
            } else {
                workdir.join("mvnw.cmd").to_string_lossy().to_string()
            };
            (p, "mvnw".to_string())
        } else if !cfg!(target_os = "windows")
            && (dir.join("mvnw").is_file() || workdir.join("mvnw").is_file())
        {
            let p = if dir.join("mvnw").is_file() {
                "./mvnw".to_string()
            } else {
                workdir.join("mvnw").to_string_lossy().to_string()
            };
            (p, "mvnw".to_string())
        } else {
            ("mvn".to_string(), "mvn".to_string())
        };

        let source_label = format!("Java / Maven ({label_pm}) · {source_file}");
        let raw = std::fs::read_to_string(&pom).unwrap_or_default();
        let mut items = Vec::new();
        if raw.contains("spring-boot") {
            items.push(make_cmd_item(
                "java",
                &source_label,
                &source_file,
                cwd,
                "spring-boot:run".into(),
                &prog,
                vec!["spring-boot:run".into()],
                format!("{prog} spring-boot:run"),
                Some("启动 Spring Boot 应用".into()),
            ));
        }
        for (name, args, desc) in [
            ("test", vec!["test".to_string()], "运行 Maven 单元测试"),
            (
                "package",
                vec!["package".to_string()],
                "打包构建 JAR / WAR",
            ),
            (
                "compile",
                vec!["compile".to_string()],
                "编译 Maven 源码",
            ),
        ] {
            let display = format!("{prog} {}", args.join(" "));
            items.push(make_cmd_item(
                "java",
                &source_label,
                &source_file,
                cwd,
                name.into(),
                &prog,
                args,
                display,
                Some(desc.into()),
            ));
        }

        return Some(ScriptGroup {
            key: format!("java:maven:{cwd}"),
            ecosystem: "java".to_string(),
            source_label,
            source_file,
            cwd: cwd.to_string(),
            package_manager: Some(label_pm),
            scripts: items,
        });
    }

    let gradle_file = if gradle_kts.is_file() {
        Some((gradle_kts, "build.gradle.kts"))
    } else if gradle_groovy.is_file() {
        Some((gradle_groovy, "build.gradle"))
    } else {
        None
    };

    if let Some((gpath, gname)) = gradle_file {
        let source_file = rel_join(cwd, gname);
        let (prog, label_pm) = if cfg!(target_os = "windows")
            && (dir.join("gradlew.bat").is_file() || workdir.join("gradlew.bat").is_file())
        {
            let p = if dir.join("gradlew.bat").is_file() {
                "gradlew.bat".to_string()
            } else {
                workdir.join("gradlew.bat").to_string_lossy().to_string()
            };
            (p, "gradlew".to_string())
        } else if !cfg!(target_os = "windows")
            && (dir.join("gradlew").is_file() || workdir.join("gradlew").is_file())
        {
            let p = if dir.join("gradlew").is_file() {
                "./gradlew".to_string()
            } else {
                workdir.join("gradlew").to_string_lossy().to_string()
            };
            (p, "gradlew".to_string())
        } else {
            ("gradle".to_string(), "gradle".to_string())
        };

        let source_label = format!("Java / Gradle ({label_pm}) · {source_file}");
        let raw = std::fs::read_to_string(&gpath).unwrap_or_default();
        let mut items = Vec::new();
        if raw.contains("org.springframework.boot") {
            items.push(make_cmd_item(
                "java",
                &source_label,
                &source_file,
                cwd,
                "bootRun".into(),
                &prog,
                vec!["bootRun".into()],
                format!("{prog} bootRun"),
                Some("启动 Spring Boot 应用".into()),
            ));
        } else if raw.contains("application") {
            items.push(make_cmd_item(
                "java",
                &source_label,
                &source_file,
                cwd,
                "run".into(),
                &prog,
                vec!["run".into()],
                format!("{prog} run"),
                Some("运行 Gradle application 入口".into()),
            ));
        }
        for (name, desc) in [
            ("test", "运行 Gradle 测试"),
            ("build", "构建并校验 Gradle 项目"),
            ("clean", "清理 Gradle 构建产物"),
        ] {
            items.push(make_cmd_item(
                "java",
                &source_label,
                &source_file,
                cwd,
                name.into(),
                &prog,
                vec![name.into()],
                format!("{prog} {name}"),
                Some(desc.into()),
            ));
        }

        return Some(ScriptGroup {
            key: format!("java:gradle:{cwd}"),
            ecosystem: "java".to_string(),
            source_label,
            source_file,
            cwd: cwd.to_string(),
            package_manager: Some(label_pm),
            scripts: items,
        });
    }

    None
}

fn parse_dotnet_scripts(dir: &Path, cwd: &str) -> Option<ScriptGroup> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut sln_name: Option<String> = None;
    let mut csproj_name: Option<String> = None;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.ends_with(".sln") && sln_name.is_none() {
            sln_name = Some(name);
        } else if name.ends_with(".csproj") && csproj_name.is_none() {
            csproj_name = Some(name);
        }
    }
    let picked = sln_name.as_deref().or(csproj_name.as_deref())?;
    let source_file = rel_join(cwd, picked);
    let source_label = format!(".NET · {source_file}");
    let mut items = Vec::new();
    if csproj_name.is_some() {
        items.push(make_cmd_item(
            "dotnet",
            &source_label,
            &source_file,
            cwd,
            "run".into(),
            "dotnet",
            vec!["run".into()],
            "dotnet run".into(),
            Some("编译并运行 .NET 项目".into()),
        ));
    }
    items.push(make_cmd_item(
        "dotnet",
        &source_label,
        &source_file,
        cwd,
        "test".into(),
        "dotnet",
        vec!["test".into()],
        "dotnet test".into(),
        Some("运行 .NET 测试".into()),
    ));
    items.push(make_cmd_item(
        "dotnet",
        &source_label,
        &source_file,
        cwd,
        "build".into(),
        "dotnet",
        vec!["build".into()],
        "dotnet build".into(),
        Some("构建 .NET 项目".into()),
    ));

    Some(ScriptGroup {
        key: format!("dotnet:{cwd}"),
        ecosystem: "dotnet".to_string(),
        source_label,
        source_file,
        cwd: cwd.to_string(),
        package_manager: Some("dotnet".to_string()),
        scripts: items,
    })
}

fn parse_composer_scripts(dir: &Path, cwd: &str) -> Option<ScriptGroup> {
    let path = dir.join("composer.json");
    if !path.is_file() {
        return None;
    }
    let raw = std::fs::read_to_string(&path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let scripts = json.get("scripts")?.as_object()?;
    if scripts.is_empty() {
        return None;
    }

    let source_file = rel_join(cwd, "composer.json");
    let source_label = format!("PHP (Composer) · {source_file}");
    let mut keys: Vec<&String> = scripts.keys().collect();
    keys.sort();

    let mut items = Vec::new();
    for k in keys {
        let detail = scripts.get(k).and_then(|v| {
            v.as_str().map(str::to_string).or_else(|| {
                v.as_array().map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str())
                        .collect::<Vec<_>>()
                        .join(" && ")
                })
            })
        });
        items.push(make_cmd_item(
            "php",
            &source_label,
            &source_file,
            cwd,
            k.clone(),
            "composer",
            vec!["run-script".into(), k.clone()],
            format!("composer run-script {k}"),
            detail,
        ));
    }

    Some(ScriptGroup {
        key: format!("php:{cwd}"),
        ecosystem: "php".to_string(),
        source_label,
        source_file,
        cwd: cwd.to_string(),
        package_manager: Some("composer".to_string()),
        scripts: items,
    })
}

fn parse_makefile_scripts(dir: &Path, cwd: &str) -> Option<ScriptGroup> {
    let picked = ["Makefile", "makefile", "GNUmakefile"]
        .into_iter()
        .find(|f| dir.join(f).is_file())?;
    let raw = std::fs::read_to_string(dir.join(picked)).ok()?;
    let source_file = rel_join(cwd, picked);
    let source_label = format!("Make · {source_file}");

    let mut items = Vec::new();
    let mut seen = HashSet::new();

    for line in raw.lines() {
        if line.starts_with('\t') || line.starts_with(' ') || line.trim_start().starts_with('#') {
            continue;
        }
        let Some(colon_idx) = line.find(':') else {
            continue;
        };
        // 排除 `:=` 或 `::=` 等变量赋值
        if line[colon_idx..].starts_with(":=") {
            continue;
        }
        let left = &line[..colon_idx];
        if left.contains('=') || left.contains('$') {
            continue;
        }
        let comment = line
            .find("##")
            .map(|idx| line[idx + 2..].trim().to_string())
            .filter(|s| !s.is_empty());

        for target in left.split_whitespace() {
            if target.starts_with('.')
                || target.starts_with('_')
                || target.contains('%')
                || target.contains('/')
            {
                continue;
            }
            if !seen.insert(target.to_string()) {
                continue;
            }
            items.push(make_cmd_item(
                "make",
                &source_label,
                &source_file,
                cwd,
                target.to_string(),
                "make",
                vec![target.to_string()],
                format!("make {target}"),
                comment.clone(),
            ));
        }
    }

    if items.is_empty() {
        None
    } else {
        Some(ScriptGroup {
            key: format!("make:{cwd}"),
            ecosystem: "make".to_string(),
            source_label,
            source_file,
            cwd: cwd.to_string(),
            package_manager: Some("make".to_string()),
            scripts: items,
        })
    }
}

fn parse_justfile_scripts(dir: &Path, cwd: &str) -> Option<ScriptGroup> {
    let picked = ["justfile", "Justfile", ".justfile"]
        .into_iter()
        .find(|f| dir.join(f).is_file())?;
    let raw = std::fs::read_to_string(dir.join(picked)).ok()?;
    let source_file = rel_join(cwd, picked);
    let source_label = format!("Just · {source_file}");

    let mut items = Vec::new();
    let mut seen = HashSet::new();
    let mut pending_doc: Option<String> = None;

    for raw_line in raw.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            pending_doc = None;
            continue;
        }
        if let Some(doc) = trimmed.strip_prefix('#') {
            pending_doc = Some(doc.trim().to_string());
            continue;
        }
        if raw_line.starts_with(' ') || raw_line.starts_with('\t') {
            pending_doc = None;
            continue;
        }
        if trimmed.starts_with("set ")
            || trimmed.starts_with("alias ")
            || trimmed.starts_with("export ")
        {
            pending_doc = None;
            continue;
        }
        if let Some(colon) = raw_line.find(':') {
            if raw_line[colon..].starts_with(":=") {
                pending_doc = None;
                continue;
            }
            let header = raw_line[..colon].trim();
            let recipe = header
                .trim_start_matches('@')
                .split_whitespace()
                .next()
                .unwrap_or("");
            if !recipe.is_empty()
                && !recipe.starts_with('_')
                && recipe
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                && seen.insert(recipe.to_string())
            {
                items.push(make_cmd_item(
                    "make",
                    &source_label,
                    &source_file,
                    cwd,
                    recipe.to_string(),
                    "just",
                    vec![recipe.to_string()],
                    format!("just {recipe}"),
                    pending_doc.take(),
                ));
            }
        }
        pending_doc = None;
    }

    if items.is_empty() {
        None
    } else {
        Some(ScriptGroup {
            key: format!("just:{cwd}"),
            ecosystem: "make".to_string(),
            source_label,
            source_file,
            cwd: cwd.to_string(),
            package_manager: Some("just".to_string()),
            scripts: items,
        })
    }
}

fn parse_taskfile_scripts(dir: &Path, cwd: &str) -> Option<ScriptGroup> {
    let picked = ["Taskfile.yml", "Taskfile.yaml", "taskfile.yml", "taskfile.yaml"]
        .into_iter()
        .find(|f| dir.join(f).is_file())?;
    let raw = std::fs::read_to_string(dir.join(picked)).ok()?;
    let source_file = rel_join(cwd, picked);
    let source_label = format!("Taskfile · {source_file}");

    let mut items = Vec::new();
    let mut in_tasks = false;
    let mut task_indent: Option<usize> = None;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start_matches(' ').len();
        if indent == 0 {
            in_tasks = trimmed.starts_with("tasks:");
            task_indent = None;
            continue;
        }
        if !in_tasks {
            continue;
        }
        let target_indent = *task_indent.get_or_insert(indent);
        if indent == target_indent && trimmed.ends_with(':') {
            let name = trimmed.trim_end_matches(':').trim();
            if !name.is_empty() && !name.starts_with('_') {
                items.push(make_cmd_item(
                    "make",
                    &source_label,
                    &source_file,
                    cwd,
                    name.to_string(),
                    "task",
                    vec![name.to_string()],
                    format!("task {name}"),
                    None,
                ));
            }
        }
    }

    if items.is_empty() {
        None
    } else {
        Some(ScriptGroup {
            key: format!("taskfile:{cwd}"),
            ecosystem: "make".to_string(),
            source_label,
            source_file,
            cwd: cwd.to_string(),
            package_manager: Some("task".to_string()),
            scripts: items,
        })
    }
}

fn parse_vscode_tasks(workdir: &Path) -> Option<ScriptGroup> {
    let tasks_path = workdir.join(".vscode/tasks.json");
    if !tasks_path.is_file() {
        return None;
    }
    let raw = std::fs::read_to_string(&tasks_path).ok()?;
    let cleaned = strip_jsonc(&raw);
    let json: serde_json::Value = serde_json::from_str(&cleaned).ok()?;
    let tasks = json.get("tasks")?.as_array()?;

    let source_file = ".vscode/tasks.json".to_string();
    let source_label = "VS Code Tasks · .vscode/tasks.json".to_string();
    let mut items = Vec::new();

    for t in tasks {
        let label = t
            .get("label")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let cmd = t
            .get("command")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let (Some(label), Some(cmd)) = (label, cmd) else {
            continue;
        };
        let args: Vec<String> = t
            .get("args")
            .and_then(|a| a.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let display = if args.is_empty() {
            cmd.to_string()
        } else {
            format!("{cmd} {}", args.join(" "))
        };
        let detail = t
            .get("detail")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .or_else(|| Some(display.clone()));

        items.push(make_cmd_item(
            "vscode",
            &source_label,
            &source_file,
            ".",
            label.to_string(),
            cmd,
            args,
            display,
            detail,
        ));
    }

    if items.is_empty() {
        None
    } else {
        Some(ScriptGroup {
            key: "vscode:.".to_string(),
            ecosystem: "vscode".to_string(),
            source_label,
            source_file,
            cwd: ".".to_string(),
            package_manager: Some("vscode".to_string()),
            scripts: items,
        })
    }
}

fn parse_docker_compose_scripts(dir: &Path, cwd: &str) -> Option<ScriptGroup> {
    let picked = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"]
        .into_iter()
        .find(|f| dir.join(f).is_file())?;
    let source_file = rel_join(cwd, picked);
    let source_label = format!("Docker Compose · {source_file}");
    let items = vec![
        make_cmd_item(
            "docker",
            &source_label,
            &source_file,
            cwd,
            "up -d".into(),
            "docker",
            vec!["compose".into(), "up".into(), "-d".into()],
            "docker compose up -d".into(),
            Some("后台启动 Compose 服务".into()),
        ),
        make_cmd_item(
            "docker",
            &source_label,
            &source_file,
            cwd,
            "down".into(),
            "docker",
            vec!["compose".into(), "down".into()],
            "docker compose down".into(),
            Some("停止并移除 Compose 容器".into()),
        ),
        make_cmd_item(
            "docker",
            &source_label,
            &source_file,
            cwd,
            "logs".into(),
            "docker",
            vec![
                "compose".into(),
                "logs".into(),
                "-f".into(),
                "--tail=100".into(),
            ],
            "docker compose logs -f --tail=100".into(),
            Some("实时查看容器日志".into()),
        ),
        make_cmd_item(
            "docker",
            &source_label,
            &source_file,
            cwd,
            "ps".into(),
            "docker",
            vec!["compose".into(), "ps".into()],
            "docker compose ps".into(),
            Some("查看服务运行状态".into()),
        ),
    ];

    Some(ScriptGroup {
        key: format!("docker:{cwd}"),
        ecosystem: "docker".to_string(),
        source_label,
        source_file,
        cwd: cwd.to_string(),
        package_manager: Some("docker".to_string()),
        scripts: items,
    })
}

/// 扫描当前工作区（根目录 + 浅层子项目）解析所有主流语言与工具可执行脚本。
pub fn discover_scripts_internal(workdir: &Path) -> AppResult<Vec<ScriptGroup>> {
    if !workdir.exists() || !workdir.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "Workspace directory does not exist: {}",
            workdir.to_string_lossy()
        )));
    }

    let mut project_dirs: Vec<PathBuf> = Vec::new();
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::new();
    queue.push_back((workdir.to_path_buf(), 0));

    const MAX_SCAN_DEPTH: usize = 2;
    while let Some((dir, depth)) = queue.pop_front() {
        project_dirs.push(dir.clone());
        if depth >= MAX_SCAN_DEPTH {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut subdirs = Vec::new();
        for e in entries.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            if !ft.is_dir() || ft.is_symlink() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            let p = e.path();
            if p.join("CACHEDIR.TAG").exists() {
                continue;
            }
            subdirs.push(p);
        }
        subdirs.sort();
        for s in subdirs {
            queue.push_back((s, depth + 1));
        }
    }

    let mut groups = Vec::new();
    for dir in project_dirs {
        let cwd = rel_path_unix(workdir, &dir);
        if let Some(g) = parse_node_scripts(workdir, &dir, &cwd) {
            groups.push(g);
        }
        if let Some(g) = parse_rust_scripts(&dir, &cwd) {
            groups.push(g);
        }
        if let Some(g) = parse_python_scripts(workdir, &dir, &cwd) {
            groups.push(g);
        }
        if let Some(g) = parse_go_scripts(&dir, &cwd) {
            groups.push(g);
        }
        if let Some(g) = parse_java_scripts(workdir, &dir, &cwd) {
            groups.push(g);
        }
        if let Some(g) = parse_dotnet_scripts(&dir, &cwd) {
            groups.push(g);
        }
        if let Some(g) = parse_composer_scripts(&dir, &cwd) {
            groups.push(g);
        }
        if let Some(g) = parse_makefile_scripts(&dir, &cwd) {
            groups.push(g);
        }
        if let Some(g) = parse_justfile_scripts(&dir, &cwd) {
            groups.push(g);
        }
        if let Some(g) = parse_taskfile_scripts(&dir, &cwd) {
            groups.push(g);
        }
        if let Some(g) = parse_docker_compose_scripts(&dir, &cwd) {
            groups.push(g);
        }
    }

    if let Some(g) = parse_vscode_tasks(workdir) {
        groups.push(g);
    }

    // 去重相同 key 保障稳定性
    let mut seen_keys: HashMap<String, usize> = HashMap::new();
    groups.retain(|g| {
        if seen_keys.contains_key(&g.key) {
            false
        } else {
            seen_keys.insert(g.key.clone(), 1);
            true
        }
    });

    Ok(groups)
}
