//! 命令行冒烟验证：直接调用后端的真实业务函数，对一个真实仓库跑完整闭环。
//!
//! 这不是单元测试，而是对业务逻辑的功能验收，用于确认
//! 「打开仓库 → 读状态 → 读 diff → hunk 暂存 → 提交」在真实仓库上成立。
//!
//! 放在 `examples/` 而不是 `src/bin/`：后者会被 Cargo 当作第二个带 `main` 的
//! 可执行目标，导致 `tauri build` 无法确定主程序（failed to find main binary）。
//!
//! 用法：`cargo run --example smoke -- <仓库路径>`

#![allow(linker_messages)]

use std::path::PathBuf;

use git_hunk_lib::smoke::{self, SmokeReport};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args
        .get(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().expect("cwd"));

    println!("== git-hunk 冒烟验证 ==");
    println!("仓库: {}", path.display());

    match smoke::run(&path) {
        Ok(report) => print_report(&report),
        Err(e) => {
            eprintln!("验证失败: {e}");
            std::process::exit(1);
        }
    }
}

fn print_report(r: &SmokeReport) {
    println!("\n-- 1. 打开仓库 --");
    println!("workdir: {}", r.workdir);
    println!("branch : {:?}", r.branch);

    println!("\n-- 2. 状态分组 --");
    println!("已暂存: {}", r.staged);
    println!("已变更: {}", r.unstaged);
    println!("未跟踪: {}", r.untracked);
    for f in &r.file_list {
        println!(
            "  [{:?}] {}  +{} -{}",
            f.area, f.path, f.additions, f.deletions
        );
    }

    println!("\n-- 3. diff 解析 --");
    println!("检查文件: {}", r.diff_path);
    println!("hunk 数量: {}", r.hunk_count);
    for h in &r.hunk_summaries {
        println!("  {h}");
    }

    println!("\n-- 4. hunk 级暂存 --");
    println!("{}", r.stage_result);

    println!("\n-- 5. 提交 --");
    println!("{}", r.commit_result);

    println!("\n-- 6. 提交后状态 --");
    println!("已暂存: {}", r.after_staged);
    println!("已变更: {}", r.after_unstaged);
    println!("未跟踪: {}", r.after_untracked);

    println!("\n== 冒烟验证完成 ==");
}