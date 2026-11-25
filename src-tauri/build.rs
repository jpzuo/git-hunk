fn main() {
    // Ensure Cargo rebuilds Windows resources and embedded window icons when icon files change.
    for path in [
        "icons/icon.ico",
        "icons/icon.png",
        "icons/32x32.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    tauri_build::build()
}
