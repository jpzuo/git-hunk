//! 后端单元测试：重点验证 hunk 解析与 patch 重建这两块最易出错的地基。

use git2::Repository;

use crate::git;

fn init_repo(dir: &std::path::Path) -> Repository {
    let repo = Repository::init(dir).expect("init repo");
    {
        let mut cfg = repo.config().expect("config");
        cfg.set_str("user.name", "Test").unwrap();
        cfg.set_str("user.email", "test@example.com").unwrap();
    }
    repo
}

fn write_file(repo: &Repository, rel: &str, content: &str) {
    let workdir = repo.workdir().unwrap();
    let abs = workdir.join(rel);
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(abs, content).unwrap();
}

fn commit_all(repo: &Repository, msg: &str) {
    let mut index = repo.index().unwrap();
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .unwrap();
    index.write().unwrap();
    let tree_id = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_id).unwrap();
    let sig = repo.signature().unwrap();
    let parent = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
        .unwrap();
}

#[test]
fn parses_single_hunk_with_line_numbers() {
    let tmp = tempdir();
    let repo = init_repo(&tmp);
    write_file(&repo, "a.txt", "one\ntwo\nthree\n");
    commit_all(&repo, "init");

    // 修改第二行，产生一个替换 hunk
    write_file(&repo, "a.txt", "one\nTWO\nthree\n");

    let diff = git::read_file_diff(&repo, "a.txt", crate::model::StageArea::Unstaged).unwrap();
    assert_eq!(diff.hunks.len(), 1, "应解析出 1 个 hunk");

    let hunk = &diff.hunks[0];
    assert_eq!(hunk.additions, 1);
    assert_eq!(hunk.deletions, 1);

    // 上下文行必须有正确的前后行号
    let ctx: Vec<_> = hunk
        .lines
        .iter()
        .filter(|l| l.kind == crate::model::HunkLineKind::Context)
        .collect();
    assert!(ctx.len() >= 2, "替换 hunk 应带上下文行");

    for line in &ctx {
        assert!(line.old_lineno.is_some());
        assert!(line.new_lineno.is_some());
    }

    // 删除行只有源行号，新增行只有目标行号
    let del = hunk
        .lines
        .iter()
        .find(|l| l.kind == crate::model::HunkLineKind::Deletion)
        .unwrap();
    assert!(del.old_lineno.is_some());
    assert!(del.new_lineno.is_none());
    assert_eq!(del.content, "two");

    let add = hunk
        .lines
        .iter()
        .find(|l| l.kind == crate::model::HunkLineKind::Addition)
        .unwrap();
    assert!(add.old_lineno.is_none());
    assert!(add.new_lineno.is_some());
    assert_eq!(add.content, "TWO");
}

#[test]
fn parses_multiple_separated_hunks() {
    let tmp = tempdir();
    let repo = init_repo(&tmp);
    let original: String = (1..=40).map(|i| format!("line {i}\n")).collect();
    write_file(&repo, "long.txt", &original);
    commit_all(&repo, "init");

    // 两处相距很远的修改 → 两个 hunk
    let modified = original
        .replace("line 2\n", "line TWO\n")
        .replace("line 38\n", "line THIRTYEIGHT\n");
    write_file(&repo, "long.txt", &modified);

    let diff = git::read_file_diff(&repo, "long.txt", crate::model::StageArea::Unstaged).unwrap();
    assert_eq!(diff.hunks.len(), 2, "应有 2 个独立 hunk");
    assert_eq!(diff.hunks[0].index, 0);
    assert_eq!(diff.hunks[1].index, 1);

    // 第二个 hunk 的起始行号应明显大于第一个
    assert!(diff.hunks[1].old_start > diff.hunks[0].old_start);
}

#[test]
fn parses_new_file_as_pure_addition() {
    let tmp = tempdir();
    let repo = init_repo(&tmp);
    write_file(&repo, "seed.txt", "seed\n");
    commit_all(&repo, "init");

    write_file(&repo, "new.txt", "alpha\nbeta\n");

    let status = git::read_status(&repo).unwrap();
    assert!(
        status.untracked.iter().any(|f| f.path == "new.txt"),
        "新文件应出现在未跟踪分组"
    );

    let diff = git::read_file_diff(&repo, "new.txt", crate::model::StageArea::Untracked).unwrap();
    assert!(!diff.hunks.is_empty(), "新文件应有 hunk");
    assert!(diff.hunks.iter().all(|h| h.is_pure_addition()));
}

#[test]
fn stage_file_moves_between_groups() {
    let tmp = tempdir();
    let repo = init_repo(&tmp);
    write_file(&repo, "a.txt", "one\n");
    commit_all(&repo, "init");
    write_file(&repo, "a.txt", "one modified\n");

    let before = git::read_status(&repo).unwrap();
    assert!(before.unstaged.iter().any(|f| f.path == "a.txt"));

    git::stage_file(&repo, "a.txt").unwrap();

    let after = git::read_status(&repo).unwrap();
    assert!(after.staged.iter().any(|f| f.path == "a.txt"));
    assert!(!after.unstaged.iter().any(|f| f.path == "a.txt"));
}

#[test]
fn stage_hunk_only_stages_one_hunk() {
    let tmp = tempdir();
    let repo = init_repo(&tmp);
    let original: String = (1..=40).map(|i| format!("line {i}\n")).collect();
    write_file(&repo, "long.txt", &original);
    commit_all(&repo, "init");

    let modified = original
        .replace("line 2\n", "line TWO\n")
        .replace("line 38\n", "line THIRTYEIGHT\n");
    write_file(&repo, "long.txt", &modified);

    // 只暂存第一个 hunk
    git::stage_hunk(&repo, "long.txt", 0).unwrap();

    let status = git::read_status(&repo).unwrap();
    let staged = status.staged.iter().find(|f| f.path == "long.txt");
    assert!(staged.is_some(), "第一个 hunk 应进入暂存区");

    // 工作区仍有未暂存的第二个 hunk
    let unstaged = status.unstaged.iter().find(|f| f.path == "long.txt");
    assert!(unstaged.is_some(), "第二个 hunk 应仍在未暂存区");

    // 暂存区 diff 只应包含一个 hunk
    let staged_diff =
        git::read_file_diff(&repo, "long.txt", crate::model::StageArea::Staged).unwrap();
    assert_eq!(staged_diff.hunks.len(), 1, "暂存区只应有一个 hunk");

    let unstaged_diff =
        git::read_file_diff(&repo, "long.txt", crate::model::StageArea::Unstaged).unwrap();
    assert_eq!(unstaged_diff.hunks.len(), 1, "工作区仍应有一个 hunk");
}

#[test]
fn commit_records_staged_changes() {
    let tmp = tempdir();
    let repo = init_repo(&tmp);
    write_file(&repo, "a.txt", "one\n");
    commit_all(&repo, "init");

    write_file(&repo, "a.txt", "one changed\n");
    git::stage_file(&repo, "a.txt").unwrap();
    let result = git::commit(&repo, "feat: change").unwrap();

    assert_eq!(result.summary, "feat: change");
    assert!(!result.oid.is_empty());

    let status = git::read_status(&repo).unwrap();
    assert!(status.staged.is_empty(), "提交后暂存区应为空");
    assert!(status.unstaged.is_empty(), "提交后工作区应为干净");
}

#[test]
fn discard_hunk_restores_workdir() {
    let tmp = tempdir();
    let repo = init_repo(&tmp);
    let original: String = (1..=40).map(|i| format!("line {i}\n")).collect();
    write_file(&repo, "long.txt", &original);
    commit_all(&repo, "init");

    let modified = original
        .replace("line 2\n", "line TWO\n")
        .replace("line 38\n", "line THIRTYEIGHT\n");
    write_file(&repo, "long.txt", &modified);

    // 丢弃第二个 hunk
    git::discard_hunk(&repo, "long.txt", 1).unwrap();

    let content = std::fs::read_to_string(repo.workdir().unwrap().join("long.txt")).unwrap();
    assert!(content.contains("line 38"), "被丢弃的改动应还原");
    assert!(content.contains("line TWO"), "未丢弃的改动应保留");

    let diff = git::read_file_diff(&repo, "long.txt", crate::model::StageArea::Unstaged).unwrap();
    assert_eq!(diff.hunks.len(), 1, "丢弃后应只剩一个 hunk");
}

#[test]
fn hunk_out_of_range_is_reported() {
    let tmp = tempdir();
    let repo = init_repo(&tmp);
    write_file(&repo, "a.txt", "one\n");
    commit_all(&repo, "init");
    write_file(&repo, "a.txt", "changed\n");

    let err = git::stage_hunk(&repo, "a.txt", 99).unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("out of range"), "应报 hunk 越界: {msg}");
}

#[test]
fn test_read_dir_and_file_preview() {
    let tmp = tempdir();
    let repo = init_repo(&tmp);
    write_file(&repo, "README.md", "# Title\n\nHello Markdown!\n");
    write_file(&repo, "src/main.rs", "fn main() {\n    println!(\"hello\");\n}\n");
    write_file(&repo, "docs/guide.md", "## Guide\n");
    write_file(&repo, "assets/icon.png", "PNG FAKE BINARY DATA");
    commit_all(&repo, "init");

    let workdir = repo.workdir().unwrap();

    // 1. 测试根目录读取
    let root_entries = crate::commands::read_dir_internal(workdir, None).unwrap();
    assert!(root_entries.iter().any(|e| e.name == "README.md" && e.is_markdown));
    assert!(root_entries.iter().any(|e| e.name == "src" && e.is_dir));
    assert!(root_entries.iter().any(|e| e.name == "docs" && e.is_dir));
    assert!(root_entries.iter().any(|e| e.name == "assets" && e.is_dir));
    // 排除 .git 目录
    assert!(!root_entries.iter().any(|e| e.name == ".git"));
    // 文件夹排在前面
    let first_file_idx = root_entries.iter().position(|e| !e.is_dir).unwrap_or(0);
    for e in &root_entries[..first_file_idx] {
        assert!(e.is_dir);
    }

    // 2. 测试子目录读取
    let src_entries = crate::commands::read_dir_internal(workdir, Some("src")).unwrap();
    assert_eq!(src_entries.len(), 1);
    assert_eq!(src_entries[0].name, "main.rs");
    assert!(!src_entries[0].is_dir);

    // 3. 测试 Markdown 文件预览读取
    let md_preview = crate::commands::read_file_internal(workdir, "README.md").unwrap();
    assert!(!md_preview.is_binary);
    assert!(md_preview.is_markdown);
    assert_eq!(md_preview.line_count, Some(3));
    assert!(md_preview.text_content.unwrap().contains("# Title"));

    // 4. 测试代码文件预览读取
    let code_preview = crate::commands::read_file_internal(workdir, "src/main.rs").unwrap();
    assert!(!code_preview.is_binary);
    assert!(!code_preview.is_markdown);
    assert_eq!(code_preview.line_count, Some(3));
    assert!(code_preview.text_content.unwrap().contains("println!"));

    // 5. 测试图片文件预览读取（Base64 返回）
    let img_preview = crate::commands::read_file_internal(workdir, "assets/icon.png").unwrap();
    assert!(img_preview.is_image);
    assert!(img_preview.base64_content.is_some());
    assert_eq!(img_preview.mime_type.as_deref(), Some("image/png"));

    // 6. 测试路径逃逸防御
    let err = crate::commands::read_file_internal(workdir, "../outside.txt").unwrap_err();
    assert!(err.to_string().contains("Parent directory traversal not allowed") || err.to_string().contains("outside"));
}

#[test]
fn test_search_files_and_dirs() {
    let tmp = tempdir();
    let repo = init_repo(&tmp);
    write_file(&repo, "src/views/admin/docWatermark/constants.ts", "export const A = 1;\n");
    write_file(&repo, "src/views/admin/docWatermark/components/RuleListView.vue", "<template />\n");
    write_file(&repo, "src/components/WatermarkBanner.vue", "<template />\n");
    write_file(&repo, "node_modules/pkg-watermark/index.js", "module.exports = {};\n");
    commit_all(&repo, "init");

    let workdir = repo.workdir().unwrap();

    // 1. 少于 3 个字符不进行搜索
    let short = crate::commands::search_files_internal(workdir, "wo", 500).unwrap();
    assert!(short.matches.is_empty());

    // 2. 搜索目录与文件（大小写不敏感），不向下展开 node_modules，且不会因父路径命中导致无关子文件全部返回
    let res = crate::commands::search_files_internal(workdir, "watermark", 500).unwrap();
    let paths: Vec<&str> = res.matches.iter().map(|m| m.path.as_str()).collect();
    assert!(paths.contains(&"src/views/admin/docWatermark"));
    assert!(paths.contains(&"src/components/WatermarkBanner.vue"));
    assert!(!paths.contains(&"src/views/admin/docWatermark/constants.ts"));
    assert!(!paths.contains(&"node_modules/pkg-watermark/index.js"));
    assert!(!res.truncated);

    // 3. 带斜杠路径检索精确命中节点本身
    let path_res = crate::commands::search_files_internal(workdir, "admin/doc", 500).unwrap();
    let p_paths: Vec<&str> = path_res.matches.iter().map(|m| m.path.as_str()).collect();
    assert_eq!(p_paths, vec!["src/views/admin/docWatermark"]);
}

#[test]
fn test_search_content_vscode_modes_and_filters() {
    use crate::content_search::{search_content_internal, ContentSearchOptions};

    let tmp = tempdir();
    let repo = init_repo(&tmp);
    write_file(&repo, ".gitignore", "ignored_dir/\n");
    write_file(
        &repo,
        "src/app.ts",
        "const greet = 'Hello World';\n// 中文注释 Hello hello_world Hello\nconst end = 1;\n",
    );
    write_file(
        &repo,
        "src/components/Banner.vue",
        "<template><div>hello Banner</div></template>\n",
    );
    write_file(&repo, "docs/guide.md", "# Hello Guide\nUse hello carefully.\n");
    write_file(&repo, "ignored_dir/secret.ts", "const hidden = 'Hello';\n");
    // 含 null 字节的二进制文件应被跳过
    let bin_path = repo.workdir().unwrap().join("assets/blob.bin");
    std::fs::create_dir_all(bin_path.parent().unwrap()).unwrap();
    std::fs::write(&bin_path, b"Hello\0\0binary").unwrap();
    commit_all(&repo, "init content search");

    let workdir = repo.workdir().unwrap();

    // 1. 默认不区分大小写 + UTF-16 中文偏移精确性 + .gitignore 忽略 + 跳过二进制
    let res = search_content_internal(
        workdir,
        &ContentSearchOptions {
            query: "Hello".into(),
            case_sensitive: false,
            whole_word: false,
            use_regex: false,
            include_pattern: None,
            exclude_pattern: None,
            use_ignore_files: true,
            max_files: None,
            max_matches: None,
        },
    )
    .unwrap();
    let matched_paths: Vec<&str> = res.files.iter().map(|f| f.path.as_str()).collect();
    assert!(matched_paths.contains(&"src/app.ts"));
    assert!(matched_paths.contains(&"src/components/Banner.vue"));
    assert!(matched_paths.contains(&"docs/guide.md"));
    assert!(!matched_paths.contains(&"ignored_dir/secret.ts"));
    assert!(!matched_paths.contains(&"assets/blob.bin"));

    // 校验第 2 行含中文字符时 UTF-16 range 偏移是否精准命中 "Hello"
    let app_file = res.files.iter().find(|f| f.path == "src/app.ts").unwrap();
    let line2 = app_file.matches.iter().find(|m| m.line_number == 2).unwrap();
    let utf16: Vec<u16> = line2.line_text.encode_utf16().collect();
    assert_eq!(line2.ranges.len(), 3);
    let slice0 = String::from_utf16(&utf16[line2.ranges[0].start..line2.ranges[0].end]).unwrap();
    let slice1 = String::from_utf16(&utf16[line2.ranges[1].start..line2.ranges[1].end]).unwrap();
    assert_eq!(slice0, "Hello");
    assert_eq!(slice1, "hello");

    // 2. 区分大小写 + 全词匹配（不应命中 hello 或 hello_world）
    let strict = search_content_internal(
        workdir,
        &ContentSearchOptions {
            query: "Hello".into(),
            case_sensitive: true,
            whole_word: true,
            use_regex: false,
            include_pattern: None,
            exclude_pattern: None,
            use_ignore_files: true,
            max_files: None,
            max_matches: None,
        },
    )
    .unwrap();
    let app_strict = strict.files.iter().find(|f| f.path == "src/app.ts").unwrap();
    let strict_line2 = app_strict.matches.iter().find(|m| m.line_number == 2).unwrap();
    assert_eq!(strict_line2.ranges.len(), 2);

    // 3. 正则模式 + 包含/排除目录（不带 ** 也能匹配目录名）
    let filtered = search_content_internal(
        workdir,
        &ContentSearchOptions {
            query: r"Hello\s+(World|Guide|Banner)".into(),
            case_sensitive: false,
            whole_word: false,
            use_regex: true,
            include_pattern: Some("src".into()),
            exclude_pattern: Some("*.vue".into()),
            use_ignore_files: true,
            max_files: None,
            max_matches: None,
        },
    )
    .unwrap();
    let f_paths: Vec<&str> = filtered.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(f_paths, vec!["src/app.ts"]);

    // 4. 关闭 use_ignore_files 后可检索到被 .gitignore 忽略的文件
    let include_ignored = search_content_internal(
        workdir,
        &ContentSearchOptions {
            query: "hidden".into(),
            case_sensitive: false,
            whole_word: false,
            use_regex: false,
            include_pattern: None,
            exclude_pattern: None,
            use_ignore_files: false,
            max_files: None,
            max_matches: None,
        },
    )
    .unwrap();
    assert!(include_ignored
        .files
        .iter()
        .any(|f| f.path == "ignored_dir/secret.ts"));

    // 5. 非法正则给出明确错误信息
    let bad_re = search_content_internal(
        workdir,
        &ContentSearchOptions {
            query: "(unclosed".into(),
            case_sensitive: false,
            whole_word: false,
            use_regex: true,
            include_pattern: None,
            exclude_pattern: None,
            use_ignore_files: true,
            max_files: None,
            max_matches: None,
        },
    )
    .unwrap_err();
    assert!(bad_re.to_string().contains("正则表达式无效"));
}

#[test]
fn test_discover_multi_language_scripts() {
    use crate::project_scripts::discover_scripts_internal;
    use crate::script_runner::resolve_script_cwd;

    let tmp = tempdir();
    let repo = init_repo(&tmp);

    // 前端 package.json + pnpm-lock.yaml
    write_file(&repo, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    write_file(
        &repo,
        "package.json",
        r#"{"name":"web-app","scripts":{"dev":"vite","build":"tsc && vite build"}}"#,
    );
    // Rust 子包 src-tauri + alias
    write_file(
        &repo,
        "src-tauri/Cargo.toml",
        "[package]\nname = \"app-core\"\nversion = \"0.1.0\"\n",
    );
    write_file(&repo, "src-tauri/src/main.rs", "fn main() {}\n");
    write_file(
        &repo,
        "src-tauri/.cargo/config.toml",
        "[alias]\nxtask = \"run --package xtask\"\n",
    );
    // Python + uv.lock + poe
    write_file(&repo, "backend/uv.lock", "version = 1\n");
    write_file(
        &repo,
        "backend/pyproject.toml",
        "[project]\nname = \"py-api\"\n[tool.poe.tasks]\nserve = \"uvicorn main:app\"\n",
    );
    // Go 模块
    write_file(&repo, "services/go.mod", "module example.com/svc\n");
    write_file(&repo, "services/cmd/api/main.go", "package main\nfunc main() {}\n");
    // Makefile
    write_file(
        &repo,
        "Makefile",
        ".PHONY: all deploy\nall: build ## Build everything\n\t@echo ok\ndeploy:\n\t@echo deploy\n",
    );
    // VS Code JSONC tasks.json（含注释、URL 字符串中 // 不误伤与尾随逗号）
    write_file(
        &repo,
        ".vscode/tasks.json",
        "{\n  // 注释\n  \"version\": \"2.0.0\",\n  \"tasks\": [\n    { \"label\": \"Check Docs\", \"command\": \"echo\", \"args\": [\"https://example.com\",], },\n  ],\n}\n",
    );
    // 忽略 node_modules 下的假 package.json
    write_file(
        &repo,
        "node_modules/fake/package.json",
        r#"{"name":"fake","scripts":{"bad":"exit 1"}}"#,
    );

    let workdir = repo.workdir().unwrap();
    let groups = discover_scripts_internal(workdir).unwrap();

    // 1. 前端 pnpm 识别与长驻标记
    let node_grp = groups.iter().find(|g| g.ecosystem == "node" && g.cwd == ".").unwrap();
    assert_eq!(node_grp.package_manager.as_deref(), Some("pnpm"));
    assert!(node_grp.scripts.iter().any(|s| s.name == "dev" && s.display_command == "pnpm run dev" && s.is_long_running));
    assert!(node_grp.scripts.iter().any(|s| s.name == "build" && s.display_command == "pnpm run build" && !s.is_long_running));
    assert!(!groups.iter().any(|g| g.cwd.contains("node_modules")));

    // 2. Rust 子包及 alias
    let rust_grp = groups.iter().find(|g| g.ecosystem == "rust" && g.cwd == "src-tauri").unwrap();
    assert!(rust_grp.scripts.iter().any(|s| s.display_command == "cargo test"));
    assert!(rust_grp.scripts.iter().any(|s| s.display_command == "cargo run"));
    assert!(rust_grp.scripts.iter().any(|s| s.display_command == "cargo xtask"));

    // 3. Python uv + poe
    let py_grp = groups.iter().find(|g| g.ecosystem == "python" && g.cwd == "backend").unwrap();
    assert_eq!(py_grp.package_manager.as_deref(), Some("uv"));
    assert!(py_grp.scripts.iter().any(|s| s.display_command == "uv run poe serve"));

    // 4. Go cmd 入口
    let go_grp = groups.iter().find(|g| g.ecosystem == "go" && g.cwd == "services").unwrap();
    assert!(go_grp.scripts.iter().any(|s| s.display_command == "go run ./cmd/api"));
    assert!(go_grp.scripts.iter().any(|s| s.display_command == "go test ./..."));

    // 5. Makefile（跳过 .PHONY 并提取 ## 注释）
    let make_grp = groups.iter().find(|g| g.source_file == "Makefile").unwrap();
    assert!(make_grp.scripts.iter().any(|s| s.name == "all" && s.detail.as_deref() == Some("Build everything")));
    assert!(!make_grp.scripts.iter().any(|s| s.name == ".PHONY"));

    // 6. VS Code JSONC tasks.json 解析保留 URL
    let vs_grp = groups.iter().find(|g| g.ecosystem == "vscode").unwrap();
    assert!(vs_grp.scripts.iter().any(|s| s.name == "Check Docs" && s.display_command.contains("https://example.com")));

    // 7. cwd 安全边界校验
    assert!(resolve_script_cwd(workdir, "src-tauri").is_ok());
    assert!(resolve_script_cwd(workdir, "../outside").is_err());
}

#[test]
fn test_script_runner_streaming_and_command_exec() {
    use crate::script_runner::{build_shell_command, decode_utf8_streaming};
    use std::io::Read;

    // 1. 验证跨块截断的多字节 UTF-8 中文文本流式解码不乱码
    let msg = "开发服务器已启动";
    let bytes = msg.as_bytes();
    let split_at = 4; // 落在第二个中文字符内部
    let mut pending = Vec::new();
    let part1 = decode_utf8_streaming(&mut pending, &bytes[..split_at]);
    let part2 = decode_utf8_streaming(&mut pending, &bytes[split_at..]);
    assert_eq!(format!("{part1}{part2}"), msg);
    assert!(pending.is_empty());

    // 2. 验证通过 build_shell_command 执行真实命令并捕获标准输出与退出码
    let tmp = tempdir();
    let mut child = build_shell_command("echo git-hunk-script-ok", &tmp)
        .spawn()
        .unwrap();
    let mut out = String::new();
    child.stdout.take().unwrap().read_to_string(&mut out).unwrap();
    let status = child.wait().unwrap();
    assert!(status.success());
    assert!(out.contains("git-hunk-script-ok"), "实际输出: {out}");
}

#[test]
fn content_search_parallel_and_cancellation() {
    use crate::content_search::{search_content_cancellable, search_content_internal, ContentSearchOptions};

    let tmp = tempdir();
    let repo = init_repo(&tmp);
    write_file(&repo, "src/b.ts", "const target = 'needle';\n");
    write_file(&repo, "src/a.ts", "const target = 'needle';\n");
    write_file(&repo, "dist/bundle.js", "const target = 'needle';\n");
    write_file(&repo, ".vite/deps/chunk.js", "const target = 'needle';\n");
    write_file(&repo, "assets/fake.png", "needle pretending to be png text\n");
    commit_all(&repo, "init parallel search");

    let workdir = repo.workdir().unwrap();

    // 1. 默认并行检索：按路径确定性排序，且跳过构建目录与已知静态二进制扩展名
    let res = search_content_internal(
        workdir,
        &ContentSearchOptions {
            query: "needle".into(),
            case_sensitive: false,
            whole_word: false,
            use_regex: false,
            include_pattern: None,
            exclude_pattern: None,
            use_ignore_files: true,
            max_files: None,
            max_matches: None,
        },
    )
    .unwrap();
    let paths: Vec<&str> = res.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, vec!["src/a.ts", "src/b.ts"]);
    assert!(!res.timed_out);

    // 2. 显式包含 dist 时仍可搜索构建目录
    let explicit_dist = search_content_internal(
        workdir,
        &ContentSearchOptions {
            query: "needle".into(),
            case_sensitive: false,
            whole_word: false,
            use_regex: false,
            include_pattern: Some("dist/**".into()),
            exclude_pattern: None,
            use_ignore_files: true,
            max_files: None,
            max_matches: None,
        },
    )
    .unwrap();
    assert_eq!(
        explicit_dist.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
        vec!["dist/bundle.js"]
    );

    // 3. 取消令牌置位时立即提前退出
    let cancelled = search_content_cancellable(
        workdir,
        &ContentSearchOptions {
            query: "needle".into(),
            case_sensitive: false,
            whole_word: false,
            use_regex: false,
            include_pattern: None,
            exclude_pattern: None,
            use_ignore_files: true,
            max_files: None,
            max_matches: None,
        },
        || true,
    )
    .unwrap();
    assert!(cancelled.files.is_empty());
    assert_eq!(cancelled.total_matches, 0);
}

#[test]
fn untracked_large_and_binary_files_skip_full_line_count() {
    let tmp = tempdir();
    let repo = init_repo(&tmp);
    write_file(&repo, "init.txt", "ok\n");
    commit_all(&repo, "init");

    // 正常未跟踪文本文件应统计精确行数 (3 行)
    write_file(&repo, "small.txt", "a\nb\nc\n");
    // 含 NUL 的未跟踪二进制文件
    let bin_abs = repo.workdir().unwrap().join("blob.bin");
    std::fs::write(&bin_abs, b"abc\0def").unwrap();
    // 超过 2MB 的未跟踪大文件应跳过全文读取并标记 binary=true
    let huge_abs = repo.workdir().unwrap().join("huge.log");
    let huge_bytes = vec![b'x'; 2 * 1024 * 1024 + 64];
    std::fs::write(&huge_abs, huge_bytes).unwrap();

    let status = crate::git::read_status(&repo).unwrap();
    let small = status.untracked.iter().find(|f| f.path == "small.txt").unwrap();
    assert_eq!(small.additions, 3);
    assert!(!small.binary);

    let bin = status.untracked.iter().find(|f| f.path == "blob.bin").unwrap();
    assert!(bin.binary);
    assert_eq!(bin.additions, 0);

    let huge = status.untracked.iter().find(|f| f.path == "huge.log").unwrap();
    assert!(huge.binary);
    assert_eq!(huge.additions, 0);
}

#[test]
fn window_visibility_signal_wakes_on_restore() {
    use crate::state::WindowVisibilitySignal;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    let signal = Arc::new(WindowVisibilitySignal::default());
    signal.set_visible(false);
    assert!(!signal.is_visible());

    let sig_clone = Arc::clone(&signal);
    let handle = std::thread::spawn(move || {
        let start = Instant::now();
        sig_clone.wait_interval(Duration::from_millis(50), Duration::from_secs(10));
        start.elapsed()
    });

    std::thread::sleep(Duration::from_millis(40));
    signal.set_visible(true);

    let elapsed = handle.join().unwrap();
    assert!(
        elapsed < Duration::from_secs(2),
        "恢复窗口后应在毫秒级唤醒 watcher，而非等待完整 10 秒: {elapsed:?}"
    );
}

// ---------------- 测试辅助 ----------------

/// 在系统临时目录建一个唯一目录；测试结束不自动清理（临时目录会被系统回收）。
fn tempdir() -> std::path::PathBuf {
    let base = std::env::temp_dir();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = base.join(format!("git-hunk-test-{}-{}", std::process::id(), nanos));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}