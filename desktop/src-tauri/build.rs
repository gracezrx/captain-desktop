fn main() {
    // The voice helper is built by `npm run build:voice` before a Mac build.
    // Keep the Rust core buildable without it (voice is Mac-only).
    let target = std::env::var("TARGET").unwrap_or_default();
    let helper = std::path::Path::new("binaries").join(format!("captain-voice-{target}"));
    if !helper.exists() {
        let _ = std::fs::write(&helper, b"");
    }
    tauri_build::build()
}
