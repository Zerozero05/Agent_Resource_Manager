mod audit;
#[cfg(windows)]
mod backend_host;
#[cfg(windows)]
mod backend_ipc;
mod categories;
mod checks;
mod clients;
mod configuration;
mod export_plan;
mod external;
mod invocation_templates;
mod local;
mod local_roots;
mod maintenance;
mod management_data;
mod mcp;
mod model;
mod network;
mod remote;
mod resource_adapters;
mod resource_automation;
mod resource_capability_evidence;
mod resource_checks;
mod resource_files;
mod resource_github;
mod resource_lifecycle;
mod resource_manifest;
mod resource_package;
mod resource_package_lifecycle;
mod resource_probe;
mod resource_relations;
mod resource_relocation;
mod resource_runtime;
mod resource_scenes;
mod resource_source;
mod resource_space;
mod resource_update;
mod resources;
mod skill_removal;
mod storage;
mod system_ownership;
mod task_outputs;
mod tasks;
mod transaction;
mod workspace;

use model::Manager;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};

fn folder_for_skill(m: &Manager, request: &Value) -> Result<PathBuf, String> {
    let skill = m.skill(request["skillId"].as_str().ok_or("Missing skillId")?)?;
    let path = skill["localPath"]
        .as_str()
        .ok_or("This Skill has no local folder yet")?;
    let folder = local::canonical(std::path::Path::new(path))?;
    if !folder.is_dir() {
        return Err("Skill folder is unavailable".into());
    }
    Ok(folder)
}

fn reject_internal_automation(request: &Value) -> Result<(), String> {
    if request.get("automation").is_some()
        || request["action"]
            .as_str()
            .is_some_and(|action| action.starts_with("__resource_automation_"))
    {
        return Err("自动更新执行封套只能由内部调度产生".into());
    }
    Ok(())
}

fn dispatch(m: &mut Manager, request: &Value) -> Result<Value, String> {
    reject_internal_automation(request)?;
    m.ensure_request_allowed(request)?;
    if request["action"] == "get_content_cache_stats" {
        if request
            .as_object()
            .is_none_or(|fields| fields.keys().any(|field| field != "action"))
        {
            return Err("缓存诊断只接受读取请求".into());
        }
        return network::cache_stats();
    }
    if let Some(value) = resource_capability_evidence::handle(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_update::handle(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_checks::handle(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_automation::handle(m, request)? {
        return Ok(value);
    }
    if let Some(value) = skill_removal::handle(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_scenes::handle(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_source::handle(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_relations::handle(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_space::handle(m, request)? {
        return Ok(value);
    }
    if let Some(value) = invocation_templates::handle(m, request)? {
        return Ok(value);
    }
    if let Some(value) = management_data::handle(m, request)? {
        return Ok(value);
    }
    if let Some(value) = maintenance::handle(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_github::handle(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_package::handle(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_package_lifecycle::handle(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_lifecycle::handle(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_runtime::handle(m, request)? {
        return Ok(value);
    }
    if let Some(mut value) = resources::handle(m, request)? {
        resource_scenes::decorate(m, request, &mut value)?;
        return Ok(value);
    }
    if let Some(value) = local_roots::handle(m, request)? {
        return Ok(value);
    }
    match request["action"].as_str().ok_or("Missing action")? {
        "get_state" => {
            return Ok(m.snapshot());
        }
        "get_startup_status" => return Ok(m.startup_status()),
        "refresh" | "audit_skills" => {
            m.refresh_selection(request)?;
            clients::refresh(m)?;
            m.save()?;
        }
        "set_settings" => {
            let mut settings = m.state.settings.clone();
            if let Some(editor) = request["settings"]["editorPath"].as_str() {
                settings["editorPath"] = json!(editor);
            }
            if let Some(theme) = request["settings"].get("uiTheme") {
                if !matches!(theme.as_str(), Some("light" | "dark" | "eye")) {
                    return Err("Choose light, dark or eye comfort appearance".into());
                }
                settings["uiTheme"] = theme.clone();
            }
            for (name, allowed) in [
                ("libraryMode", &["list", "details", "cards"][..]),
                ("librarySort", &["name", "status", "checked"][..]),
                ("uiAccent", &["violet", "blue", "teal", "rose"][..]),
                ("uiDensity", &["compact", "comfortable"][..]),
                ("uiMotion", &["system", "light", "none"][..]),
            ] {
                if let Some(value) = request["settings"].get(name) {
                    if !value.as_str().is_some_and(|v| allowed.contains(&v)) {
                        return Err(format!("Invalid {name}"));
                    }
                    settings[name] = value.clone();
                }
            }
            if let Some(value) = request["settings"].get("libraryPageSize") {
                if !matches!(value.as_u64(), Some(20 | 50 | 100)) {
                    return Err("Page size must be 20, 50 or 100".into());
                }
                settings["libraryPageSize"] = value.clone();
            }
            for (name, min, max) in [
                ("uiZoom", 80, 160),
                ("uiFontSize", 14, 22),
                ("sidebarWidth", 200, 420),
            ] {
                if let Some(value) = request["settings"].get(name) {
                    let number = value
                        .as_u64()
                        .filter(|n| (min..=max).contains(n))
                        .ok_or_else(|| format!("{name} must be an integer from {min} to {max}"))?;
                    settings[name] = json!(number);
                }
            }
            if let Some(value) = request["settings"].get("sidebarCollapsed") {
                if !value.is_boolean() {
                    return Err("sidebarCollapsed must be true or false".into());
                }
                settings["sidebarCollapsed"] = value.clone();
            }
            settings["checkIntervalMinutes"] = json!(30);
            let previous = std::mem::replace(&mut m.state.settings, settings);
            if let Err(error) = m.save() {
                m.state.settings = previous;
                return Err(error);
            }
            return Ok(m.snapshot());
        }
        "open_local" => {
            let s = m.skill(request["skillId"].as_str().ok_or("Missing skillId")?)?;
            let path = s["localPath"]
                .as_str()
                .ok_or("This skill has not been installed")?;
            if !std::path::Path::new(path).is_dir() {
                return Err("Skill folder is unavailable".into());
            }
            let editor = m.state.settings["editorPath"].as_str().unwrap_or("");
            #[cfg(windows)]
            let mut command = std::process::Command::new(if editor.is_empty() {
                "explorer.exe"
            } else {
                editor
            });
            #[cfg(not(windows))]
            let mut command = std::process::Command::new(if editor.is_empty() {
                "xdg-open"
            } else {
                editor
            });
            command
                .arg(path)
                .spawn()
                .map_err(|e| format!("Could not open editor/folder: {e}"))?;
            return Ok(json!({"opened":true}));
        }
        "open_folder" => {
            let folder = folder_for_skill(m, request)?;
            #[cfg(windows)]
            let mut command = std::process::Command::new("explorer.exe");
            #[cfg(not(windows))]
            let mut command = std::process::Command::new("xdg-open");
            command
                .arg(&folder)
                .spawn()
                .map_err(|e| format!("Could not open Skill folder: {e}"))?;
            return Ok(json!({"opened":true,"path":folder.to_string_lossy()}));
        }
        _ => {}
    }
    if let Some(v) = categories::handle(m, request)? {
        return Ok(v);
    }
    if let Some(v) = storage::handle(m, request)? {
        return Ok(v);
    }
    if let Some(v) = clients::handle(m, request)? {
        return Ok(v);
    }
    if let Some(v) = audit::handle(m, request)? {
        return Ok(v);
    }
    if let Some(v) = network::handle(m, request)? {
        return Ok(v);
    }
    if let Some(v) = export_plan::handle(m, request)? {
        return Ok(v);
    }
    if let Some(v) = external::handle(m, request)? {
        return Ok(v);
    }
    if let Some(v) = remote::file_request(m, request)? {
        return Ok(v);
    }
    if let Some(v) = local::handle(m, request)? {
        if request["action"] == "add_local" && !m.state.sources.is_empty() {
            return remote::handle(m, &json!({"action":"auto_associate"}))?
                .ok_or_else(|| "Automatic source association is unavailable".into());
        }
        return Ok(v);
    }
    if let Some(v) = remote::handle(m, request)? {
        return Ok(v);
    }
    Err("Unknown action".into())
}

// Only the local Tauri window route uses this dispatcher. Agent/MCP callers use
// dispatch and cannot grant themselves executable definitions through JSON flags.
fn dispatch_local(m: &mut Manager, request: &Value) -> Result<Value, String> {
    reject_internal_automation(request)?;
    m.ensure_request_allowed(request)?;
    if let Some(value) = resource_relocation::preview_local(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_relocation::apply_local(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_adapters::preview_local(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_adapters::apply_local(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_automation::preview_local(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_automation::apply_local(m, request)? {
        return Ok(value);
    }
    if request["action"] == "preview_resource_recover" {
        if request.as_object().is_none_or(|fields| {
            fields
                .keys()
                .any(|key| !["action", "rootPath"].contains(&key.as_str()))
        }) {
            return Err("恢复预览不接受权限或命令参数".into());
        }
        let path = request["rootPath"]
            .as_str()
            .filter(|path| !path.is_empty())
            .ok_or("请选择资源原目录")?;
        return resource_manifest::recover(std::path::Path::new(path));
    }
    if request["action"] == "open_system_apps" {
        if request
            .as_object()
            .is_none_or(|fields| fields.keys().any(|key| key != "action"))
        {
            return Err("系统卸载入口不接受自定义命令或地址".into());
        }
        #[cfg(windows)]
        {
            tauri_plugin_opener::open_url("ms-settings:appsfeatures", None::<&str>)
                .map_err(|error| format!("无法打开 Windows 已安装的应用：{error}"))?;
            return Ok(json!({"opened":true,"uninstalled":false}));
        }
        #[cfg(not(windows))]
        return Err("此系统卸载入口仅适用于 Windows".into());
    }
    if let Some(value) = resource_probe::apply_local(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_update::apply_local(m, request)? {
        return Ok(value);
    }
    if let Some(value) = skill_removal::apply_local(m, request)? {
        return Ok(value);
    }
    if let Some(value) = configuration::apply_local(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_scenes::apply_local(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_source::apply_local(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_relations::apply_local(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_github::apply_local(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_package::apply_local(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_package_lifecycle::apply_local(m, request)? {
        return Ok(value);
    }
    if let Some(value) = remote::apply_local(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_lifecycle::apply_local(m, request)? {
        return Ok(value);
    }
    if let Some(value) = resource_runtime::configure(m, request)? {
        return Ok(value);
    }
    dispatch(m, request)
}

#[cfg(test)]
mod settings_tests {
    use super::*;

    #[test]
    fn export_inventory_does_not_promote_optional_readme_image_into_default_zip() {
        let parent = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/export-inventory-tests");
        std::fs::create_dir_all(&parent).unwrap();
        let fixture = tempfile::tempdir_in(parent).unwrap();
        let root = fixture.path().join("skill");
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::write(
            root.join("SKILL.md"),
            "---\nname: inventory\n---\nUse the skill.\n",
        )
        .unwrap();
        std::fs::write(
            root.join("README.md"),
            "![Optional illustration](assets/readme.png)",
        )
        .unwrap();
        std::fs::write(root.join("assets/readme.png"), b"synthetic image fixture").unwrap();
        let mut m = Manager::new(fixture.path().join("state")).unwrap();
        let mut skill = local::draft(&root).unwrap();
        skill["id"] = json!("inventory");
        skill["runtimeConfirmed"] = json!(true);
        skill["runtimeFiles"] = json!(["SKILL.md", "README.md", "assets/readme.png"]);
        m.state.skills.push(skill);
        let files = dispatch(
            &mut m,
            &json!({"action":"get_files", "skillId":"inventory"}),
        )
        .unwrap();
        assert!(files["requiredFiles"]
            .as_array()
            .unwrap()
            .contains(&json!("assets/readme.png")));
        assert_eq!(files["exportRequiredFiles"], json!(["SKILL.md"]));
        assert!(files["exportError"].is_null());
        assert!(root.join("README.md").exists());
    }

    #[test]
    fn source_folder_uses_registered_path_independently_of_editor_and_rejects_unavailable_entries()
    {
        let parent = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/folder-tests");
        std::fs::create_dir_all(&parent).unwrap();
        let fixture = tempfile::tempdir_in(parent).unwrap();
        let folder = fixture.path().join("a folder with spaces");
        std::fs::create_dir(&folder).unwrap();
        let mut m = Manager::new(fixture.path().join("state")).unwrap();
        m.state.settings["editorPath"] = json!("not-an-executable");
        m.state
            .skills
            .push(json!({"id":"local","localPath":folder.to_string_lossy()}));
        m.state.skills.push(json!({"id":"remote","localPath":null}));
        let request = json!({"skillId":"local","path":"ignored-arbitrary-path"});
        assert_eq!(
            folder_for_skill(&m, &request).unwrap(),
            local::canonical(&folder).unwrap()
        );
        assert!(folder_for_skill(&m, &json!({"skillId":"remote"})).is_err());
        assert!(folder_for_skill(&m, &json!({"skillId":"unknown"})).is_err());
        m.state.skills[0]["localPath"] = json!(folder.join("missing").to_string_lossy());
        assert!(folder_for_skill(&m, &request).is_err());
    }

    #[test]
    fn display_preferences_survive_restart_and_invalid_values_do_not_partially_apply() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/settings-tests");
        std::fs::create_dir_all(&root).unwrap();
        let fixture = tempfile::tempdir_in(root).unwrap();
        {
            let mut m = Manager::new(fixture.path().to_path_buf()).unwrap();
            dispatch(&mut m, &json!({"action":"set_settings","settings":{"uiTheme":"dark","uiZoom":125,"uiFontSize":18,"uiAccent":"teal","uiDensity":"comfortable","uiMotion":"none"}})).unwrap();
            let before = m.state.settings.clone();
            for change in [
                json!({"uiTheme":"unknown"}),
                json!({"uiZoom":200}),
                json!({"uiFontSize":9}),
                json!({"uiZoom":100.5}),
                json!({"uiAccent":"invalid"}),
                json!({"uiDensity":"large"}),
                json!({"uiMotion":true}),
                json!({"uiTheme":"light","uiAccent":"invalid"}),
            ] {
                assert!(
                    dispatch(&mut m, &json!({"action":"set_settings","settings":change})).is_err()
                );
                assert_eq!(m.state.settings, before);
            }
        }
        let m = Manager::new(fixture.path().to_path_buf()).unwrap();
        assert_eq!(m.state.settings["uiTheme"], "dark");
        assert_eq!(m.state.settings["uiZoom"], 125);
        assert_eq!(m.state.settings["uiFontSize"], 18);
        assert_eq!(m.state.settings["uiAccent"], "teal");
        assert_eq!(m.state.settings["uiDensity"], "comfortable");
        assert_eq!(m.state.settings["uiMotion"], "none");
    }

    #[test]
    fn list_preferences_persist_without_resetting_display_and_reject_invalid_values() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/settings-tests");
        std::fs::create_dir_all(&root).unwrap();
        let fixture = tempfile::tempdir_in(root).unwrap();
        {
            let mut m = Manager::new(fixture.path().to_path_buf()).unwrap();
            dispatch(&mut m, &json!({"action":"set_settings","settings":{"uiTheme":"eye","uiZoom":115,"uiFontSize":17}})).unwrap();
            dispatch(&mut m, &json!({"action":"set_settings","settings":{"libraryMode":"details","libraryPageSize":50,"librarySort":"status"}})).unwrap();
            assert_eq!(m.state.settings["uiTheme"], "eye");
            assert_eq!(m.state.settings["uiZoom"], 115);
            let saved = m.state.settings.clone();
            for settings in [
                json!({"libraryMode":"unknown"}),
                json!({"libraryPageSize":0}),
                json!({"libraryPageSize":50.5}),
                json!({"librarySort":"other"}),
            ] {
                assert!(dispatch(
                    &mut m,
                    &json!({"action":"set_settings","settings":settings})
                )
                .is_err());
                assert_eq!(m.state.settings, saved);
            }
        }
        let m = Manager::new(fixture.path().to_path_buf()).unwrap();
        assert_eq!(m.state.settings["libraryMode"], "details");
        assert_eq!(m.state.settings["libraryPageSize"], 50);
        assert_eq!(m.state.settings["librarySort"], "status");
        assert_eq!(m.state.settings["uiFontSize"], 17);
    }

    #[test]
    fn cards_mode_preserves_unknown_settings_and_invalid_combined_writes_are_atomic() {
        let parent = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/settings-tests");
        std::fs::create_dir_all(&parent).unwrap();
        let directory = tempfile::tempdir_in(parent).unwrap();
        let mut m = Manager::new(directory.path().to_path_buf()).unwrap();
        m.state.settings["futurePreference"] = json!({"keep": [1,2,3]});
        dispatch(
            &mut m,
            &json!({"action":"set_settings","settings":{"libraryMode":"cards"}}),
        )
        .unwrap();
        let saved = m.state.settings.clone();
        assert!(dispatch(
            &mut m,
            &json!({"action":"set_settings","settings":{"libraryMode":"unknown","uiFontSize":22}})
        )
        .is_err());
        assert_eq!(m.state.settings, saved);
        let restored = Manager::new(directory.path().to_path_buf()).unwrap();
        assert_eq!(restored.state.settings["libraryMode"], "cards");
        assert_eq!(
            restored.state.settings["futurePreference"],
            json!({"keep": [1,2,3]})
        );
        assert_eq!(restored.state.settings["uiZoom"], saved["uiZoom"]);
    }

    #[test]
    fn layout_preferences_are_partial_validated_and_roll_back_when_saving_fails() {
        let parent = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/settings-tests");
        std::fs::create_dir_all(&parent).unwrap();
        let fixture = tempfile::tempdir_in(parent).unwrap();
        let mut m = Manager::new(fixture.path().to_path_buf()).unwrap();
        dispatch(
            &mut m,
            &json!({"action":"create_category","name":"Research"}),
        )
        .unwrap();
        let categories = m.state.settings["categories"].clone();
        dispatch(&mut m, &json!({"action":"set_settings","settings":{"uiTheme":"eye","uiZoom":113,"uiFontSize":17}})).unwrap();
        dispatch(&mut m, &json!({"action":"set_settings","settings":{"sidebarWidth":380,"sidebarCollapsed":true}})).unwrap();
        let saved = m.state.settings.clone();
        assert_eq!(saved["categories"], categories);
        assert_eq!(saved["uiTheme"], "eye");
        assert_eq!(saved["uiZoom"], 113);
        assert_eq!(saved["uiFontSize"], 17);
        for settings in [
            json!({"sidebarWidth":199}),
            json!({"sidebarWidth":421}),
            json!({"sidebarWidth":224.5}),
            json!({"sidebarWidth":250,"sidebarCollapsed":"false"}),
            json!({"sidebarCollapsed":null}),
        ] {
            assert!(dispatch(
                &mut m,
                &json!({"action":"set_settings","settings":settings})
            )
            .is_err());
            assert_eq!(m.state.settings, saved);
        }
        drop(m);
        let mut m = Manager::new(fixture.path().to_path_buf()).unwrap();
        assert_eq!(m.state.settings, saved);
        let db = rusqlite::Connection::open(fixture.path().join("manager.sqlite3")).unwrap();
        db.execute_batch("CREATE TRIGGER prevent_insert BEFORE INSERT ON app_state BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;").unwrap();
        assert!(dispatch(&mut m, &json!({"action":"set_settings","settings":{"sidebarWidth":224,"sidebarCollapsed":false,"uiZoom":100}})).is_err());
        assert_eq!(m.state.settings, saved);
    }

    #[test]
    fn selected_refresh_only_checks_requested_local_skills_and_validates_before_changes() {
        let parent = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/selection-tests");
        std::fs::create_dir_all(&parent).unwrap();
        let fixture = tempfile::tempdir_in(parent).unwrap();
        let mut m = Manager::new(fixture.path().join("state")).unwrap();
        let roots: Vec<_> = (0..3)
            .map(|n| {
                let root = fixture.path().join(format!("skill-{n}"));
                std::fs::create_dir_all(&root).unwrap();
                std::fs::write(
                    root.join("SKILL.md"),
                    format!("---\nname: skill-{n}\ndescription: before\n---\nSynthetic.\n"),
                )
                .unwrap();
                root
            })
            .collect();
        dispatch(&mut m, &json!({"action":"add_local","paths":roots})).unwrap();
        let ids: Vec<_> = m
            .state
            .skills
            .iter()
            .map(|s| s["id"].as_str().unwrap().to_string())
            .collect();
        let untouched = m.skill(&ids[2]).unwrap();
        for (n, root) in roots.iter().enumerate() {
            std::fs::write(
                root.join("SKILL.md"),
                format!("---\nname: skill-{n}\ndescription: after\n---\nSynthetic changed.\n"),
            )
            .unwrap();
        }
        dispatch(
            &mut m,
            &json!({"action":"refresh","skillIds":[ids[0],ids[1],ids[0]]}),
        )
        .unwrap();
        assert_eq!(m.skill(&ids[0]).unwrap()["description"], "after");
        assert_eq!(m.skill(&ids[1]).unwrap()["description"], "after");
        assert_eq!(m.skill(&ids[2]).unwrap(), untouched);
        let before = serde_json::to_value(&m.state).unwrap();
        for request in [
            json!({"action":"refresh","skillIds":[]}),
            json!({"action":"refresh","skillIds":[ids[0],"missing"]}),
            json!({"action":"refresh","skillIds":[ids[0]],"skillId":ids[1]}),
            json!({"action":"refresh","skillIds":"not a list"}),
        ] {
            assert!(dispatch(&mut m, &request).is_err());
            assert_eq!(serde_json::to_value(&m.state).unwrap(), before);
        }
    }
}

#[tauri::command]
#[cfg(windows)]
async fn renderer_probe(window: tauri::WebviewWindow, operation: String, data: Option<Value>) -> Result<Value, String> {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::HSTRING;
    if std::env::var("GITHUB_ACTIONS").as_deref() != Ok("true") || std::env::var("RUNNER_ENVIRONMENT").as_deref() != Ok("github-hosted") || window.label() != "main" {
        return Err("Hosted synthetic main window required".into());
    }
    let variant = std::env::var("ARM_RENDERER_PROBE_VARIANT").map_err(|e| e.to_string())?;
    if variant != "navigation" && variant != "check" { return Err("Unknown diagnostic group".into()); }
    let root = PathBuf::from(r"D:\arm-renderer-probe-6239").join(&variant);
    let args: Vec<_> = std::env::args_os().collect();
    let data_dir = resolve_data_dir(&args, None, Err("Explicit synthetic data required".into()))?;
    if data_dir != root.join("data") || !root.join("fixture-owner.json").is_file() { return Err("Wrong synthetic data directory".into()); }
    if operation == "start" { return Ok(json!({"variant":variant,"pid":std::process::id()})); }
    if operation == "report" {
        use std::io::Write;
        let value = data.ok_or("No sample")?;
        let stage = value["stage"].as_str().ok_or("No stage")?;
        if !["baseline","pair2","pair4","pair6","final","failure"].contains(&stage) { return Err("Unknown sample stage".into()); }
        let bytes = serde_json::to_vec(&value).map_err(|e|e.to_string())?;
        if bytes.len()>64*1024 { return Err("Oversize probe report".into()); }
        let part = root.join(format!("probe-{stage}.part"));
        let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(&part).map_err(|e|e.to_string())?;
        file.write_all(&bytes).map_err(|e|e.to_string())?; drop(file);
        std::fs::rename(part, root.join(format!("probe-{stage}.json"))).map_err(|e|e.to_string())?;
        return Ok(Value::Null);
    }
    let method = match operation.as_str() {
        "heap" => "Runtime.getHeapUsage",
        "dom" => "Memory.getDOMCounters",
        "collect" => "HeapProfiler.collectGarbage",
        _ => return Err("Unsupported diagnostic measurement".into()),
    };
    let (tx, rx) = std::sync::mpsc::channel::<Result<String,String>>();
    window.with_webview(move |view| {
        let done = tx.clone();
        let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status, result| {
            let _ = done.send(status.map(|_| result).map_err(|e|e.to_string())); Ok(())
        }));
        let issued = unsafe { view.controller().CoreWebView2().and_then(|web| web.CallDevToolsProtocolMethod(&HSTRING::from(method), &HSTRING::from("{}"), &handler)) };
        if let Err(e) = issued { let _ = tx.send(Err(e.to_string())); }
    }).map_err(|e|e.to_string())?;
    let raw = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(8))).await.map_err(|e|e.to_string())?.map_err(|e|e.to_string())??;
    serde_json::from_str(&raw).map_err(|e|e.to_string())
}

#[tauri::command]
async fn manager_request(
    state: tauri::State<'_, Arc<tasks::TaskSystem>>,
    workspace: tauri::State<'_, Arc<workspace::WorkspaceSystem>>,
    window: tauri::WebviewWindow,
    mut request: Value,
) -> Result<Value, String> {
    use tauri::Manager;
    let service = state.inner().clone();
    let workspace = workspace.inner().clone();
    let label = window.label().to_owned();
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(value) = workspace.handle(&app, &label, &request)? {
            return Ok(value);
        }
        workspace.inject_origin(&label, &mut request)?;
        service.execute(request, dispatch_local)
    })
    .await
    .map_err(|_| "Background operation failed".to_string())?
}

fn resolve_data_dir(
    args: &[std::ffi::OsString],
    environment: Option<std::ffi::OsString>,
    executable: Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    if let Some(index) = args.iter().position(|arg| arg == "--data-dir") {
        let value = args
            .get(index + 1)
            .filter(|value| !value.is_empty() && !value.to_string_lossy().starts_with("--"))
            .ok_or("--data-dir requires a directory path")?;
        return Ok(PathBuf::from(value));
    }
    if let Some(value) = environment {
        if value.is_empty() {
            return Err("SKILL_MANAGER_DATA_DIR must not be empty".into());
        }
        return Ok(PathBuf::from(value));
    }

    let executable = executable?;
    let executable_dir = executable
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or("Could not determine the application directory")?;
    let config_path = executable_dir.join("data-directory.txt");
    let config = match std::fs::File::open(&config_path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let legacy = executable_dir.join("Skill_Manager_Data");
            let has_legacy = [
                "manager.sqlite3",
                "manager.sqlite3-wal",
                "manager.sqlite3-shm",
            ]
            .iter()
            .any(|name| legacy.join(name).exists());
            if executable
                .file_stem()
                .is_some_and(|name| name.eq_ignore_ascii_case("agent-resource-manager"))
                && !has_legacy
            {
                return Ok(executable_dir.to_owned());
            }
            return Ok(legacy);
        }
        Err(error) => {
            return Err(format!("Could not read {}: {error}", config_path.display()));
        }
    };
    use std::io::Read;
    let mut bytes = Vec::new();
    config
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read {}: {error}", config_path.display()))?;
    if bytes.len() > 4096 {
        return Err(format!(
            "{} must be at most 4096 bytes",
            config_path.display()
        ));
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| format!("{} must contain a UTF-8 path", config_path.display()))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let line = text
        .strip_suffix("\r\n")
        .or_else(|| text.strip_suffix('\n'))
        .unwrap_or(text);
    if line.contains(['\r', '\n', '\0']) || line.trim().is_empty() {
        return Err(format!(
            "{} must contain one non-empty directory path on a single line",
            config_path.display()
        ));
    }
    let path = PathBuf::from(line.trim());
    if path.is_absolute() {
        Ok(path)
    } else if path.has_root()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::Prefix(_)))
    {
        Err(format!(
            "{} must contain an absolute path or a path relative to the application directory",
            config_path.display()
        ))
    } else {
        Ok(executable_dir.join(path))
    }
}

#[cfg(test)]
mod data_directory_tests {
    use super::*;
    use std::ffi::OsString;

    fn fixture() -> tempfile::TempDir {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/data-directory-tests");
        std::fs::create_dir_all(&root).unwrap();
        tempfile::tempdir_in(root).unwrap()
    }

    #[test]
    fn explicit_paths_take_priority_without_requiring_an_executable_path() {
        let args = [
            OsString::from("app"),
            OsString::from("--data-dir"),
            OsString::from("selected"),
        ];
        assert_eq!(
            resolve_data_dir(&args, Some("environment".into()), Err("unavailable".into())).unwrap(),
            PathBuf::from("selected")
        );
        assert_eq!(
            resolve_data_dir(&[], Some("environment".into()), Err("unavailable".into())).unwrap(),
            PathBuf::from("environment")
        );
    }

    #[test]
    fn sidecar_supports_absolute_and_application_relative_paths() {
        let root = fixture();
        let exe = root.path().join("skill-manager.exe");
        let sidecar = root.path().join("data-directory.txt");
        let resolve = || resolve_data_dir(&[], None, Ok(exe.clone()));
        assert_eq!(resolve().unwrap(), root.path().join("Skill_Manager_Data"));
        std::fs::write(&sidecar, "\u{feff}state/管理数据\r\n").unwrap();
        assert_eq!(resolve().unwrap(), root.path().join("state/管理数据"));
        let absolute = root.path().join("absolute-data");
        std::fs::write(&sidecar, absolute.to_str().unwrap()).unwrap();
        assert_eq!(resolve().unwrap(), absolute);
        std::fs::write(&sidecar, "invalid\nconfiguration").unwrap();
        assert_eq!(
            resolve_data_dir(&[], Some("override".into()), Ok(exe)).unwrap(),
            PathBuf::from("override")
        );
    }

    #[test]
    fn renamed_program_uses_fresh_product_layout_but_preserves_existing_legacy_data() {
        let root = fixture();
        let exe = root.path().join("agent-resource-manager.exe");
        assert_eq!(
            resolve_data_dir(&[], None, Ok(exe.clone())).unwrap(),
            root.path()
        );
        let legacy = root.path().join("Skill_Manager_Data");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("manager.sqlite3-wal"), b"existing state").unwrap();
        assert_eq!(
            resolve_data_dir(&[], None, Ok(exe.clone())).unwrap(),
            legacy
        );
        std::fs::write(root.path().join("data-directory.txt"), "chosen-data").unwrap();
        assert_eq!(
            resolve_data_dir(&[], None, Ok(exe)).unwrap(),
            root.path().join("chosen-data")
        );
        assert_eq!(
            std::fs::read(legacy.join("manager.sqlite3-wal")).unwrap(),
            b"existing state"
        );
    }

    #[test]
    fn packaged_sidecar_selects_the_fresh_layout_after_path_resolution() {
        let root = fixture();
        let app = root.path().join("product/app");
        std::fs::create_dir_all(&app).unwrap();
        let exe = app.join("agent-resource-manager.exe");
        std::fs::write(app.join("data-directory.txt"), ".\n").unwrap();
        let base = resolve_data_dir(&[], None, Ok(exe.clone())).unwrap();
        let storage = storage::Storage::load(base, &exe, "legacySidecar", false).unwrap();
        let product = app.parent().unwrap();
        for (kind, relative) in [
            ("state", "data"),
            ("webview", "cache/webview"),
            ("temp", "cache/temp"),
            ("recovery", "data/recovery"),
            ("receipts", "data/receipts"),
            ("export", "exports"),
        ] {
            assert_eq!(storage.path(kind).unwrap(), product.join(relative));
        }
        assert!(!app.join("manager.sqlite3").exists());
        assert!(!app.join("webview").exists());
    }

    #[test]
    fn packaged_sidecar_preserves_existing_or_explicit_data_locations() {
        for locked in [false, true] {
            let root = fixture();
            let app = root.path().join("product/app");
            std::fs::create_dir_all(&app).unwrap();
            let exe = app.join("agent-resource-manager.exe");
            std::fs::write(app.join("data-directory.txt"), ".\n").unwrap();
            if !locked {
                std::fs::write(app.join("manager.sqlite3-wal"), b"existing state").unwrap();
            }
            let base = resolve_data_dir(&[], None, Ok(exe.clone())).unwrap();
            let storage = storage::Storage::load(base, &exe, "legacySidecar", locked).unwrap();
            assert_eq!(storage.path("state").unwrap(), app);
            assert!(!app.join("storage-paths.json").exists());
            if !locked {
                assert_eq!(
                    std::fs::read(app.join("manager.sqlite3-wal")).unwrap(),
                    b"existing state"
                );
            }
        }
    }

    #[test]
    fn packaged_sidecar_parent_traversal_remains_invalid() {
        let root = fixture();
        let app = root.path().join("product/app");
        std::fs::create_dir_all(&app).unwrap();
        let exe = app.join("agent-resource-manager.exe");
        std::fs::write(app.join("data-directory.txt"), "../chosen\n").unwrap();
        let base = resolve_data_dir(&[], None, Ok(exe.clone())).unwrap();
        assert!(storage::Storage::load(base, &exe, "legacySidecar", false).is_err());
        assert!(!app.join("storage-paths.json").exists());
        assert!(!app.parent().unwrap().join("chosen").exists());
    }

    #[test]
    fn invalid_sidecars_fail_instead_of_silently_selecting_another_database() {
        let cases: Vec<Vec<u8>> = vec![
            Vec::new(),
            b" \t\r\n".to_vec(),
            b"one\ntwo".to_vec(),
            b"one\n\n".to_vec(),
            b"one\rtwo".to_vec(),
            b"one\0two".to_vec(),
            vec![b'a'; 4097],
            vec![0xff],
        ];
        for bytes in cases {
            let root = fixture();
            std::fs::write(root.path().join("data-directory.txt"), bytes).unwrap();
            assert!(resolve_data_dir(&[], None, Ok(root.path().join("app.exe"))).is_err());
            assert!(!root.path().join("Skill_Manager_Data").exists());
        }
        let root = fixture();
        std::fs::create_dir(root.path().join("data-directory.txt")).unwrap();
        assert!(resolve_data_dir(&[], None, Ok(root.path().join("app.exe"))).is_err());
    }

    #[test]
    fn empty_explicit_values_and_unavailable_executable_fail() {
        for args in [
            vec![OsString::from("--data-dir")],
            vec![OsString::from("--data-dir"), OsString::new()],
            vec![OsString::from("--data-dir"), OsString::from("--other")],
        ] {
            assert!(
                resolve_data_dir(&args, Some("fallback".into()), Err("no exe".into())).is_err()
            );
        }
        assert!(resolve_data_dir(&[], Some(OsString::new()), Err("no exe".into())).is_err());
        assert!(resolve_data_dir(&[], None, Err("no exe".into())).is_err());
    }
}

fn basic_mode_from_args(args: &[std::ffi::OsString]) -> bool {
    args.iter().any(|arg| arg == "--basic-mode")
}

fn initialize_manager(storage: Arc<storage::Storage>, basic_mode: bool) -> Result<Manager, String> {
    let mut manager = if basic_mode {
        Manager::with_storage_mode(storage.clone(), true)?
    } else {
        Manager::with_storage(storage.clone())?
    };
    if !basic_mode {
        let recovered = transaction::recover_in(&storage.path("recovery")?)?;
        if !recovered.is_empty() {
            manager.state.settings["recoveryMessages"] = json!(recovered);
        }
    }
    Ok(manager)
}

fn startup_failure(error: &str) {
    let message = format!("Agent 资源管理器未能启动。\n\n{error}\n\n原有数据和设置未被重建。可核对保存位置，或使用 --basic-mode 只读诊断。");
    eprintln!("{message}");
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        unsafe extern "system" {
            fn MessageBoxW(
                window: *mut std::ffi::c_void,
                text: *const u16,
                caption: *const u16,
                kind: u32,
            ) -> i32;
        }
        let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
        let title: Vec<u16> = "Agent 资源管理器 · 启动未完成"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        unsafe {
            MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), 0x10);
        }
    }
}

#[cfg(test)]
mod startup_profile;

#[cfg(test)]
mod basic_mode_tests {
    use super::*;
    use std::fs;

    fn fixture() -> tempfile::TempDir {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/basic-mode-tests");
        fs::create_dir_all(&root).unwrap();
        tempfile::tempdir_in(root).unwrap()
    }

    #[test]
    fn basic_mode_argument_is_explicit_and_does_not_change_data_directory_selection() {
        let args = vec![
            "app".into(),
            "--basic-mode".into(),
            "--data-dir".into(),
            "chosen".into(),
        ];
        assert!(basic_mode_from_args(&args));
        assert_eq!(
            resolve_data_dir(&args, None, Err("unused".into())).unwrap(),
            PathBuf::from("chosen")
        );
        assert!(!basic_mode_from_args(&[
            "app".into(),
            "--basic-mode-other".into()
        ]));
    }

    #[test]
    fn basic_mode_reads_old_schema_without_creating_tables_or_overwriting_settings() {
        let dir = fixture();
        let database = dir.path().join("manager.sqlite3");
        let db = rusqlite::Connection::open(&database).unwrap();
        db.execute_batch("CREATE TABLE app_state(id INTEGER PRIMARY KEY,payload TEXT NOT NULL)")
            .unwrap();
        let state = json!({"skills":[],"sources":[],"connections":[],"settings":{"uiTheme":"eye","uiAccent":"rose"},"checkMode":"auto"});
        db.execute(
            "INSERT INTO app_state(id,payload) VALUES(1,?1)",
            [state.to_string()],
        )
        .unwrap();
        drop(db);
        let before = fs::read(&database).unwrap();
        let manager =
            initialize_manager(storage::Storage::isolated(dir.path().to_owned()), true).unwrap();
        let service = tasks::TaskSystem::new(manager).unwrap();
        let snapshot = service
            .execute(json!({"action":"get_state"}), dispatch)
            .unwrap();
        assert_eq!(snapshot["settings"], state["settings"]);
        assert_eq!(snapshot["checkMode"], "auto");
        assert_eq!(snapshot["startup"]["basicMode"], true);
        assert_eq!(snapshot["startup"]["resourceCatalogAvailable"], false);
        let listed = service
            .execute(json!({"action":"resource_list"}), dispatch)
            .unwrap();
        assert_eq!(listed["resources"], json!([]));
        assert!(listed["unavailableReason"].is_string());
        let downloads = service
            .execute(json!({"action":"resource_downloads"}), dispatch)
            .unwrap();
        assert_eq!(downloads["downloads"], json!([]));
        assert_eq!(downloads["total"], 0);
        for request in [
            json!({"action":"resource_invoke","id":"not-needed"}),
            json!({"action":"preview_resource_resume","downloadId":"not-needed"}),
            json!({"action":"set_settings","settings":{"uiTheme":"dark"}}),
            json!({"action":"repair_client_connections"}),
            json!({"action":"check_now","automatic":true}),
            json!({"action":"apply_install","previewId":"not-needed"}),
        ] {
            assert!(service
                .execute(request, dispatch_local)
                .unwrap_err()
                .contains("基本模式"));
        }
        service
            .store_workspace_state(&json!({"test":"session only"}))
            .unwrap();
        drop(service);
        assert_eq!(fs::read(&database).unwrap(), before);
        let db = rusqlite::Connection::open_with_flags(
            &database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let count: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn basic_mode_preserves_catalog_history_workspace_and_pending_recovery() {
        let dir = fixture();
        let storage = storage::Storage::isolated(dir.path().join("state"));
        let mut manager = Manager::with_storage(storage.clone()).unwrap();
        manager.state.settings["uiTheme"] = json!("eye");
        manager.save().unwrap();
        let root = dir.path().join("synthetic-resource");
        fs::create_dir(&root).unwrap();
        dispatch(
            &mut manager,
            &json!({"action":"resource_register","name":"synthetic","kind":"cli","rootPath":root}),
        )
        .unwrap();
        manager
            .store_workspace_state(&json!({"invalid":"old workspace remains untouched"}))
            .unwrap();
        manager.store_task_history(&[json!({"id":"old-task","action":"refresh","label":"previous task","status":"running","stage":"reading","createdAt":"2026-01-01"})]).unwrap();
        drop(manager);
        let recovery = storage.path("recovery").unwrap().join("pending");
        fs::create_dir_all(&recovery).unwrap();
        let journal =
            json!({"root":root,"state":"applying","created_at":"2026-01-01","entries":[]})
                .to_string();
        fs::write(recovery.join("journal.json"), &journal).unwrap();
        let database = storage.path("state").unwrap().join("manager.sqlite3");
        let before = fs::read(&database).unwrap();
        let manager = initialize_manager(storage, true).unwrap();
        assert_eq!(manager.workspace_state().unwrap(), None);
        let service = tasks::TaskSystem::new(manager).unwrap();
        assert_eq!(
            service
                .execute(json!({"action":"resource_list"}), dispatch)
                .unwrap()["resources"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            service
                .execute(json!({"action":"list_tasks"}), dispatch)
                .unwrap()["tasks"][0]["status"],
            "interrupted"
        );
        assert_eq!(service.check_configuration().unwrap()["mode"], "manual");
        drop(service);
        assert_eq!(
            fs::read_to_string(recovery.join("journal.json")).unwrap(),
            journal
        );
        assert_eq!(fs::read(&database).unwrap(), before);
    }

    #[test]
    fn basic_mode_missing_or_unreadable_database_never_creates_a_replacement() {
        let dir = fixture();
        let missing = dir.path().join("missing");
        assert!(initialize_manager(storage::Storage::isolated(missing.clone()), true).is_err());
        assert!(!missing.exists());
        let corrupt = dir.path().join("manager.sqlite3");
        fs::write(&corrupt, b"unique corrupted input").unwrap();
        assert!(
            initialize_manager(storage::Storage::isolated(dir.path().to_owned()), true).is_err()
        );
        assert_eq!(fs::read(&corrupt).unwrap(), b"unique corrupted input");
    }

    #[test]
    fn basic_mode_rejects_nested_mutations_before_creating_tasks_or_using_local_grants() {
        let dir = fixture();
        let storage = storage::Storage::isolated(dir.path().to_owned());
        let manager = Manager::with_storage(storage.clone()).unwrap();
        manager.save().unwrap();
        drop(manager);
        let database = dir.path().join("manager.sqlite3");
        let download_directory = storage.path("newSkill").unwrap();
        let original = fs::read(&database).unwrap();
        let service = tasks::TaskSystem::new(initialize_manager(storage, true).unwrap()).unwrap();
        for business in [
            json!({"action":"apply_update","previewId":"preview","backupPlanId":"plan","confirmed":true}),
            json!({"action":"apply_resource_remove","previewId":"preview","confirmed":true}),
            json!({"action":"apply_resource_repair","previewId":"preview","confirmed":true}),
            json!({"action":"apply_resource_download","previewId":"preview"}),
            json!({"action":"resource_action_set","id":"tool","definition":{}}),
            json!({"action":"storage_default_path","kind":"newSkill"}),
            json!({"action":"resource_list","automatic":true}),
            json!({"action":"undo_management"}),
            json!({"action":"redo_management","expectedEntryId":"synthetic-entry"}),
            json!({"action":"set_maintenance","expectedRevision":0,"pause":"resume"}),
        ] {
            let request = json!({"action":"start_task","request":business});
            assert!(service
                .execute(request, dispatch_local)
                .unwrap_err()
                .contains("基本模式"));
        }
        assert!(service
            .execute(json!({"action":"clear_task_history"}), dispatch_local)
            .unwrap_err()
            .contains("基本模式"));
        assert!(service
            .execute(json!({"action":"list_tasks"}), dispatch_local)
            .unwrap()["tasks"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(service
            .execute(json!({"action":"storage_get"}), dispatch_local)
            .is_ok());
        drop(service);
        assert_eq!(fs::read(&database).unwrap(), original);
        assert!(!download_directory.exists());
    }
}

pub fn run() -> u8 {
    let args: Vec<_> = std::env::args_os().collect();
    let basic_mode = basic_mode_from_args(&args);
    let background = args.iter().any(|arg| arg == "--background");
    let startup_error = |error: &str| {
        if background || args.iter().any(|arg| arg == "--mcp") {
            eprintln!("{error}");
        } else {
            startup_failure(error);
        }
    };
    #[cfg(windows)]
    let requested_data = if args.iter().any(|arg| arg == "--data-dir")
        || std::env::var_os("SKILL_MANAGER_DATA_DIR").is_some()
    {
        match resolve_data_dir(
            &args,
            std::env::var_os("SKILL_MANAGER_DATA_DIR"),
            std::env::current_exe().map_err(|error| error.to_string()),
        ) {
            Ok(path) => Some(path),
            Err(error) => {
                startup_error(&error);
                return 1;
            }
        }
    } else {
        None
    };
    #[cfg(windows)]
    if args.iter().any(|arg| arg == "--mcp") {
        if basic_mode {
            eprintln!("--mcp 不能与 --basic-mode 合并。请先以基本模式打开管理器，再通过 MCP 查看只读状态。");
            return 1;
        }
        return match backend_host::stdio(requested_data) {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("{error}");
                1
            }
        };
    }
    #[cfg(windows)]
    let mut backend =
        match backend_host::Host::claim(requested_data.as_deref(), basic_mode, background) {
            Ok(Some(host)) => host,
            Ok(None) => return 0,
            Err(error) => {
                startup_error(&error);
                return 1;
            }
        };
    let data_dir = match resolve_data_dir(
        &args,
        std::env::var_os("SKILL_MANAGER_DATA_DIR"),
        std::env::current_exe()
            .map_err(|error| format!("Could not determine the application path: {error}")),
    ) {
        Ok(path) => path,
        Err(error) => {
            startup_error(&error);
            return 1;
        }
    };
    let source = if args.iter().any(|a| a == "--data-dir") {
        "commandLine"
    } else if std::env::var_os("SKILL_MANAGER_DATA_DIR").is_some() {
        "environment"
    } else if std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.join("data-directory.txt")))
        .is_some_and(|p| p.exists())
    {
        "legacySidecar"
    } else {
        "applicationDefault"
    };
    let storage = match std::env::current_exe()
        .map_err(|e| e.to_string())
        .and_then(|exe| {
            if basic_mode {
                storage::Storage::load_for_mode(
                    data_dir.clone(),
                    &exe,
                    source,
                    matches!(source, "commandLine" | "environment"),
                    true,
                )
            } else {
                storage::Storage::load(
                    data_dir.clone(),
                    &exe,
                    source,
                    matches!(source, "commandLine" | "environment"),
                )
            }
        }) {
        Ok(storage) => storage,
        Err(error) => {
            startup_error(&error);
            return 1;
        }
    };
    let manager = initialize_manager(storage.clone(), basic_mode);
    let service = match manager.and_then(tasks::TaskSystem::new) {
        Ok(service) => service,
        Err(e) => {
            startup_error(&e);
            return 1;
        }
    };
    let mut context = tauri::generate_context!();
    #[cfg(debug_assertions)]
    for window in &mut context.config_mut().app.windows {
        if let Ok(port) = std::env::var("SKILL_MANAGER_DEBUG_PORT")
            .unwrap_or_default()
            .parse::<u16>()
        {
            if port >= 1024 {
                window.additional_browser_args = Some(format!(
                    "--remote-debugging-port={port} --remote-debugging-address=127.0.0.1"
                ));
            }
        }
    }
    let windows: Vec<_> = context
        .config()
        .app
        .windows
        .iter()
        .filter(|w| w.create)
        .cloned()
        .collect();
    for window in &mut context.config_mut().app.windows {
        window.create = false;
    }
    let workspace = match workspace::WorkspaceSystem::new(
        service.clone(),
        storage
            .path("webview")
            .expect("validated WebView directory"),
        windows.first().cloned().unwrap_or_default(),
    ) {
        Ok(workspace) => workspace,
        Err(error) => {
            startup_error(&error);
            return 1;
        }
    };
    #[cfg(windows)]
    if let Err(error) = backend.start(service.clone(), workspace.clone()) {
        startup_error(&error);
        return 1;
    }
    #[cfg(windows)]
    let ready_slot = backend.ready_slot();
    #[cfg(windows)]
    let ipc_shutdown = backend.shutdown_handle();
    let application = tauri::Builder::default()
        .manage(service.clone())
        .manage(workspace.clone())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![manager_request, renderer_probe])
        .setup(move |app| {
            use tauri::Emitter;
            let handle = app.handle().clone();
            service.set_events(Arc::new(move |payload| {
                let event = if payload["clearedTaskIds"].is_array() {
                    "task-history-cleared"
                } else {
                    "task-updated"
                };
                let _ = handle.emit(event, payload);
            }));
            let handle = app.handle().clone();
            service.set_state_events(Arc::new(move |revision| {
                let _ = handle.emit("state-changed", json!({"stateRevision":revision}));
            }))?;
            let handle = app.handle().clone();
            service.set_resource_events(Arc::new(move |payload| {
                let _ = handle.emit("resource-runtime-updated", payload);
            }))?;
            #[cfg(windows)]
            backend_host::tray(app.handle(), workspace.clone(), service.clone())?;
            if !background {
                workspace.restore_windows(app.handle())?;
            }
            workspace.schedule();
            #[cfg(windows)]
            {
                *ready_slot.lock().map_err(|_| "后台启动状态不可用")? = Some(app.handle().clone());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                use tauri::Manager;
                let prevent = window
                    .app_handle()
                    .try_state::<Arc<workspace::WorkspaceSystem>>()
                    .is_some_and(|workspace| {
                        workspace.native_close_requested(window.app_handle(), window.label())
                    });
                // The approved handshake uses destroy(), which does not re-enter this gate.
                if prevent {
                    api.prevent_close();
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                use tauri::Manager;
                if let Some(workspace) = window
                    .app_handle()
                    .try_state::<Arc<workspace::WorkspaceSystem>>()
                {
                    workspace.destroyed(window.app_handle(), window.label());
                }
            }
        })
        .build(context);
    let application = match application {
        Ok(application) => application,
        Err(error) => {
            startup_error(&error.to_string());
            return 1;
        }
    };
    let exit_code = application.run_return(move |_app, event| {
        #[cfg(windows)]
        if matches!(event, tauri::RunEvent::Exit) {
            ipc_shutdown();
        }
        if let tauri::RunEvent::ExitRequested {
            code: None, api, ..
        } = event
        {
            // Closing windows leaves the one backend available to its tasks
            // and clients. Explicit quit/restart has a code and bypasses this.
            api.prevent_exit();
        }
    });
    u8::try_from(exit_code).unwrap_or(1)
}
