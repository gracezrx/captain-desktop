`captain-voice-<target>` is built here from `voice/main.swift` by
`npm run build:voice` (macOS only) before the app is built; Tauri bundles it
next to the app's executable. On other systems an empty placeholder is made so
the Rust core still compiles.
