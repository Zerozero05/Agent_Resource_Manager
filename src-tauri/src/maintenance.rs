//! Shared maintenance policy. Reading it never writes or schedules work.
use crate::model::Manager;
use chrono::{DateTime, Duration, Local, TimeZone, Timelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Window {
    start_minute: u16,
    end_minute: u16,
}

impl Window {
    fn validate(&self) -> Result<(), String> {
        if self.start_minute >= 1440
            || self.end_minute >= 1440
            || self.start_minute == self.end_minute
        {
            return Err("维护窗口须为不同的起止时刻，分钟范围为 0 至 1439".into());
        }
        Ok(())
    }

    fn contains(&self, minute: u32) -> bool {
        let start = u32::from(self.start_minute);
        let end = u32::from(self.end_minute);
        if start < end {
            minute >= start && minute < end
        } else {
            minute >= start || minute < end
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Policy {
    revision: u64,
    paused_manually: bool,
    pause_until: Option<DateTime<Utc>>,
    window: Option<Window>,
}

fn read(settings: &Value) -> Result<Policy, String> {
    let object = settings.as_object().ok_or("应用设置不是可读取的对象")?;
    let Some(stored) = object.get("maintenance") else {
        return Ok(Policy::default());
    };
    let policy: Policy =
        serde_json::from_value(stored.clone()).map_err(|_| "维护设置格式无效，需要显式重设")?;
    if policy.paused_manually && policy.pause_until.is_some() {
        return Err("维护暂停方式相互冲突，需要显式重设".into());
    }
    if let Some(window) = &policy.window {
        window.validate()?;
    }
    Ok(policy)
}

fn stored_revision(settings: &Value) -> u64 {
    settings["maintenance"]["revision"].as_u64().unwrap_or(0)
}

fn allowed_at<T: TimeZone>(policy: &Policy, now: &DateTime<T>) -> Result<(), String> {
    if policy.paused_manually {
        return Err("自动维护已暂停，等待手动恢复".into());
    }
    if policy
        .pause_until
        .as_ref()
        .is_some_and(|until| *until > now.with_timezone(&Utc))
    {
        return Err("自动维护仍在定时暂停期间".into());
    }
    if policy
        .window
        .as_ref()
        .is_some_and(|window| !window.contains(now.hour() * 60 + now.minute()))
    {
        return Err("当前不在自动维护时间窗口内".into());
    }
    Ok(())
}

fn snapshot_at<T: TimeZone>(settings: &Value, basic_mode: bool, now: &DateTime<T>) -> Value {
    match read(settings) {
        Ok(policy) => {
            let allowed = if basic_mode {
                Err("基本模式不执行自动维护".into())
            } else {
                allowed_at(&policy, now)
            };
            json!({
                "revision": policy.revision,
                "valid": true,
                "pausedManually": policy.paused_manually,
                "pauseUntil": policy.pause_until,
                "window": policy.window,
                "automaticAllowed": allowed.is_ok(),
                "reason": allowed.err().unwrap_or_default(),
            })
        }
        Err(reason) => json!({
            "revision": stored_revision(settings),
            "valid": false,
            "pausedManually": false,
            "pauseUntil": null,
            "window": null,
            "automaticAllowed": false,
            "reason": format!("自动维护已停止：{reason}"),
        }),
    }
}

pub(crate) fn snapshot(settings: &Value, basic_mode: bool) -> Value {
    snapshot_at(settings, basic_mode, &Local::now())
}

/// Call only for automatic work, before starting it or entering its commit phase.
/// Already committed work still needs to save its final evidence safely.
pub(crate) fn ensure_automatic_allowed(settings: &Value) -> Result<(), String> {
    allowed_at(&read(settings)?, &Local::now())
}

fn handle_at<T: TimeZone>(
    manager: &mut Manager,
    request: &Value,
    now: DateTime<T>,
) -> Result<Option<Value>, String> {
    if request["action"] != "set_maintenance" {
        return Ok(None);
    }
    manager.ensure_request_allowed(request)?;
    let request = request.as_object().ok_or("维护请求必须是对象")?;
    if request
        .keys()
        .any(|key| !["action", "expectedRevision", "pause", "window"].contains(&key.as_str()))
    {
        return Err("维护请求包含不支持的字段".into());
    }
    if !request.contains_key("pause") && !request.contains_key("window") {
        return Err("请选择暂停方式或维护窗口".into());
    }
    let expected = request
        .get("expectedRevision")
        .and_then(Value::as_u64)
        .ok_or("缺少有效的维护设置修订号")?;
    let current = read(&manager.state.settings);
    let revision = current
        .as_ref()
        .map(|policy| policy.revision)
        .unwrap_or_else(|_| stored_revision(&manager.state.settings));
    if expected != revision {
        return Err("维护设置已变化，请重新读取后设置".into());
    }
    let mut next = match current {
        Ok(policy) => policy,
        Err(_) => {
            if !request.contains_key("pause") || !request.contains_key("window") {
                return Err("维护记录无效，请明确重设暂停方式和维护窗口".into());
            }
            Policy::default()
        }
    };
    if let Some(pause) = request.get("pause") {
        let until = match pause.as_str() {
            Some("hour") => Some(
                now.checked_add_signed(Duration::hours(1))
                    .ok_or("暂停时间超出范围")?
                    .with_timezone(&Utc),
            ),
            Some("tomorrow") => {
                let midnight = now
                    .date_naive()
                    .succ_opt()
                    .and_then(|date| date.and_hms_opt(0, 0, 0))
                    .ok_or("次日时间超出范围")?;
                Some(
                    now.timezone()
                        .from_local_datetime(&midnight)
                        .earliest()
                        .ok_or("无法确定次日本地零点，请选择其他暂停方式")?
                        .with_timezone(&Utc),
                )
            }
            Some("manual" | "resume") => None,
            _ => return Err("请选择暂停一小时、到次日、手动暂停或恢复".into()),
        };
        next.paused_manually = pause == "manual";
        next.pause_until = until;
    }
    if let Some(window) = request.get("window") {
        next.window = if window.is_null() {
            None
        } else {
            let parsed: Window =
                serde_json::from_value(window.clone()).map_err(|_| "维护窗口格式无效")?;
            parsed.validate()?;
            Some(parsed)
        };
    }
    next.revision = revision.checked_add(1).ok_or("维护修订号超出范围")?;
    let mut settings = manager.state.settings.clone();
    settings
        .as_object_mut()
        .ok_or("应用设置不是可保存的对象，未改写其他设置")?
        .insert(
            "maintenance".into(),
            serde_json::to_value(next).map_err(|e| e.to_string())?,
        );
    let previous = std::mem::replace(&mut manager.state.settings, settings);
    if let Err(error) = manager.save() {
        manager.state.settings = previous;
        return Err(error);
    }
    Ok(Some(manager.snapshot()))
}

pub(crate) fn handle(manager: &mut Manager, request: &Value) -> Result<Option<Value>, String> {
    handle_at(manager, request, Local::now())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;
    use std::{fs, path::Path};

    fn fixture() -> tempfile::TempDir {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work/maintenance-tests");
        fs::create_dir_all(&root).unwrap();
        tempfile::tempdir_in(root).unwrap()
    }

    fn at(value: &str) -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339(value).unwrap()
    }

    fn set(manager: &mut Manager, fields: Value, now: &str) -> Result<Value, String> {
        let mut request = fields;
        request["action"] = json!("set_maintenance");
        request["expectedRevision"] = json!(stored_revision(&manager.state.settings));
        handle_at(manager, &request, at(now)).map(|value| value.unwrap())
    }

    #[test]
    fn default_and_read_only_snapshot_do_not_create_policy_or_override_skill_mode() {
        let settings = json!({"uiTheme":"eye"});
        let before = settings.clone();
        let current = snapshot_at(&settings, false, &at("2026-10-28T10:00:00+08:00"));
        assert_eq!(current["revision"], 0);
        assert_eq!(current["valid"], true);
        assert_eq!(current["automaticAllowed"], true);
        assert_eq!(
            snapshot_at(&settings, true, &at("2026-10-28T10:00:00+08:00"))["automaticAllowed"],
            false
        );
        assert_eq!(settings, before);
    }

    #[test]
    fn pause_presets_use_absolute_hour_and_next_local_midnight_and_preserve_window() {
        let dir = fixture();
        let mut manager = Manager::new(dir.path().join("state")).unwrap();
        manager.state.check_mode = "manual".into();
        let window = json!({"startMinute":1320,"endMinute":120});
        set(
            &mut manager,
            json!({"window":window}),
            "2026-10-28T23:30:00+08:00",
        )
        .unwrap();
        set(
            &mut manager,
            json!({"pause":"hour"}),
            "2026-10-28T23:30:00+08:00",
        )
        .unwrap();
        assert_eq!(
            manager.state.settings["maintenance"]["pauseUntil"],
            "2026-10-28T16:30:00Z"
        );
        set(
            &mut manager,
            json!({"pause":"tomorrow"}),
            "2026-12-31T23:30:00+08:00",
        )
        .unwrap();
        assert_eq!(
            manager.state.settings["maintenance"]["pauseUntil"],
            "2026-12-31T16:00:00Z"
        );
        set(
            &mut manager,
            json!({"pause":"manual"}),
            "2026-12-31T23:30:00+08:00",
        )
        .unwrap();
        let manual = snapshot_at(
            &manager.state.settings,
            false,
            &at("2027-01-01T01:00:00+08:00"),
        );
        assert_eq!(manual["pausedManually"], true);
        assert_eq!(manual["pauseUntil"], Value::Null);
        assert_eq!(manual["automaticAllowed"], false);
        set(
            &mut manager,
            json!({"pause":"resume"}),
            "2027-01-01T01:00:00+08:00",
        )
        .unwrap();
        assert_eq!(manager.state.settings["maintenance"]["window"], window);
        assert_eq!(
            snapshot_at(
                &manager.state.settings,
                false,
                &at("2027-01-01T01:00:00+08:00")
            )["automaticAllowed"],
            true
        );
        assert_eq!(manager.state.check_mode, "manual");
    }

    #[test]
    fn daily_window_includes_start_excludes_end_and_supports_midnight_crossing() {
        let mut settings = json!({"maintenance":{"revision":1,"pausedManually":false,"pauseUntil":null,"window":{"startMinute":540,"endMinute":1020}}});
        for (time, allowed) in [
            ("08:59:59", false),
            ("09:00:00", true),
            ("16:59:59", true),
            ("17:00:00", false),
        ] {
            assert_eq!(
                snapshot_at(&settings, false, &at(&format!("2026-10-28T{time}+08:00")))
                    ["automaticAllowed"],
                allowed
            );
        }
        settings["maintenance"]["window"] = json!({"startMinute":1320,"endMinute":120});
        for (time, allowed) in [
            ("21:59:59", false),
            ("22:00:00", true),
            ("00:00:00", true),
            ("01:59:59", true),
            ("02:00:00", false),
        ] {
            assert_eq!(
                snapshot_at(&settings, false, &at(&format!("2026-10-28T{time}+08:00")))
                    ["automaticAllowed"],
                allowed
            );
        }
    }

    #[test]
    fn expired_pause_survives_restart_without_writes_and_window_edits_do_not_resume_it() {
        let dir = fixture();
        let state = dir.path().join("state");
        let mut manager = Manager::new(state.clone()).unwrap();
        set(
            &mut manager,
            json!({"pause":"hour"}),
            "2026-10-28T10:00:00+08:00",
        )
        .unwrap();
        set(
            &mut manager,
            json!({"window":{"startMinute":540,"endMinute":1020}}),
            "2026-10-28T10:01:00+08:00",
        )
        .unwrap();
        let stored = manager.state.settings["maintenance"].clone();
        drop(manager);
        let manager = Manager::new(state).unwrap();
        assert_eq!(
            snapshot_at(
                &manager.state.settings,
                false,
                &at("2026-10-28T10:59:59+08:00")
            )["automaticAllowed"],
            false
        );
        assert_eq!(
            snapshot_at(
                &manager.state.settings,
                false,
                &at("2026-10-28T11:00:00+08:00")
            )["automaticAllowed"],
            true
        );
        assert_eq!(
            snapshot_at(
                &manager.state.settings,
                false,
                &at("2026-10-28T17:00:00+08:00")
            )["automaticAllowed"],
            false
        );
        assert_eq!(manager.state.settings["maintenance"], stored);
    }

    #[test]
    fn stale_or_invalid_combined_requests_leave_all_settings_unchanged() {
        let dir = fixture();
        let mut manager = Manager::new(dir.path().join("state")).unwrap();
        set(
            &mut manager,
            json!({"pause":"manual"}),
            "2026-10-28T10:00:00+08:00",
        )
        .unwrap();
        let before = manager.state.settings.clone();
        for request in [
            json!({"action":"set_maintenance","expectedRevision":0,"pause":"resume"}),
            json!({"action":"set_maintenance","expectedRevision":1}),
            json!({"action":"set_maintenance","expectedRevision":1,"pause":"invalid"}),
            json!({"action":"set_maintenance","expectedRevision":1,"pause":null}),
            json!({"action":"set_maintenance","expectedRevision":1,"pause":"resume","confirmed":true}),
            json!({"action":"set_maintenance","expectedRevision":1,"pause":"resume","window":{"startMinute":100,"endMinute":100}}),
            json!({"action":"set_maintenance","expectedRevision":1,"window":{"startMinute":1440,"endMinute":1}}),
            json!({"action":"set_maintenance","expectedRevision":1,"window":{"startMinute":-1,"endMinute":1}}),
            json!({"action":"set_maintenance","expectedRevision":1,"window":{"startMinute":1.5,"endMinute":2}}),
            json!({"action":"set_maintenance","expectedRevision":1,"window":{"startMinute":1,"endMinute":2,"unknown":true}}),
        ] {
            assert!(handle_at(&mut manager, &request, at("2026-10-28T10:00:00+08:00")).is_err());
            assert_eq!(manager.state.settings, before);
        }
    }

    #[test]
    fn malformed_policy_blocks_automatic_work_until_explicit_complete_reset() {
        let dir = fixture();
        let mut manager = Manager::new(dir.path().join("state")).unwrap();
        for invalid in [
            Value::Null,
            json!({"revision":7,"pausedManually":"no"}),
            json!({"revision":7,"pausedManually":false,"pauseUntil":"bad-date","window":null}),
            json!({"revision":7,"pausedManually":true,"pauseUntil":"2026-10-28T12:00:00Z","window":null}),
        ] {
            manager.state.settings["maintenance"] = invalid;
            let before = manager.state.settings.clone();
            let view = snapshot_at(
                &manager.state.settings,
                false,
                &at("2026-10-28T10:00:00+08:00"),
            );
            assert_eq!(view["valid"], false);
            assert_eq!(view["automaticAllowed"], false);
            assert!(view["reason"].as_str().is_some_and(|s| !s.is_empty()));
            assert!(ensure_automatic_allowed(&manager.state.settings).is_err());
            assert!(set(
                &mut manager,
                json!({"pause":"resume"}),
                "2026-10-28T10:00:00+08:00"
            )
            .is_err());
            assert_eq!(manager.state.settings, before);
            set(
                &mut manager,
                json!({"pause":"manual","window":null}),
                "2026-10-28T10:00:00+08:00",
            )
            .unwrap();
            assert_eq!(
                snapshot_at(
                    &manager.state.settings,
                    false,
                    &at("2026-10-28T10:00:00+08:00")
                )["valid"],
                true
            );
            assert!(ensure_automatic_allowed(&manager.state.settings).is_err());
        }
    }

    #[test]
    fn save_failure_restores_live_settings_and_basic_mode_never_writes() {
        let dir = fixture();
        let state = dir.path().join("state");
        let mut manager = Manager::new(state.clone()).unwrap();
        set(
            &mut manager,
            json!({"pause":"manual"}),
            "2026-10-28T10:00:00+08:00",
        )
        .unwrap();
        let before = manager.state.settings.clone();
        let db = rusqlite::Connection::open(state.join("manager.sqlite3")).unwrap();
        db.execute_batch("CREATE TRIGGER fail_maintenance_save BEFORE INSERT ON app_state BEGIN SELECT RAISE(ABORT,'synthetic save denied'); END;").unwrap();
        assert!(set(
            &mut manager,
            json!({"pause":"resume","window":null}),
            "2026-10-28T10:00:00+08:00"
        )
        .is_err());
        assert_eq!(manager.state.settings, before);
        drop(manager);
        let reopened = Manager::new(state.clone()).unwrap();
        assert_eq!(reopened.state.settings, before);
        drop(reopened);
        let storage = crate::storage::Storage::isolated(state);
        let mut basic = Manager::with_storage_mode(storage, true).unwrap();
        assert!(set(
            &mut basic,
            json!({"pause":"resume","window":null}),
            "2026-10-28T10:00:00+08:00"
        )
        .is_err());
        assert_eq!(basic.state.settings, before);
    }
}
