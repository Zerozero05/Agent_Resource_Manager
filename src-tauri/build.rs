fn main() {
    let windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if windows_msvc {
        // Tauri links its resource file only into binaries. Library unit tests
        // that exercise AppHandle also import TaskDialogIndirect and need the
        // same Common Controls v6 activation manifest. Let the linker embed it
        // for every linkable target; do not also embed it in Tauri's .res file.
        tauri_build::try_build(
            tauri_build::Attributes::new()
                .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
        )
        .expect("Could not prepare Tauri resources");
        let manifest =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app.manifest");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        // Preserve the original Tauri manifest without adding an elevation rule.
        println!("cargo:rustc-link-arg=/MANIFESTUAC:NO");
    } else {
        tauri_build::build();
    }
}
