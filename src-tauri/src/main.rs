// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// 屏蔽 MSVC 链接器正常输出引发的 linker_messages 告警
#![allow(linker_messages)]

fn main() {
    git_hunk_lib::run()
}
