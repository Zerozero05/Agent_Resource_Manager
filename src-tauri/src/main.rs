#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() -> std::process::ExitCode {
    std::process::ExitCode::from(skill_manager_lib::run())
}
