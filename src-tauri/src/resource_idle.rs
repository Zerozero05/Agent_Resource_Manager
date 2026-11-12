//! Monotonic idle accounting. A running use has no expiry masquerading as idleness.
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

pub(super) struct Activity {
    pub last: Instant,
    pub keep_alive: bool,
    pub uses: BTreeMap<String, String>,
}
impl Activity {
    pub fn new(at: Instant) -> Self {
        Self {
            last: at,
            keep_alive: false,
            uses: BTreeMap::new(),
        }
    }
    pub fn touch(&mut self, at: Instant) {
        self.last = self.last.max(at);
    }
    pub fn idle(&self, at: Instant, seconds: u64) -> bool {
        seconds > 0
            && !self.keep_alive
            && self.uses.is_empty()
            && at.saturating_duration_since(self.last) >= Duration::from_secs(seconds)
    }
    pub fn end(&mut self, id: &str, at: Instant) -> bool {
        if self.uses.remove(id).is_some() {
            self.touch(at);
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn idle_tracks_real_activity_and_all_uses_instead_of_time_since_launch() {
        let start = Instant::now();
        let mut activity = Activity::new(start);
        assert!(!activity.idle(start + Duration::from_secs(599), 600));
        activity.touch(start + Duration::from_secs(590));
        assert!(!activity.idle(start + Duration::from_secs(600), 600));
        activity.uses.insert("a".into(), "call".into());
        activity.uses.insert("b".into(), "login".into());
        assert!(!activity.idle(start + Duration::from_secs(10000), 600));
        activity.end("a", start + Duration::from_secs(10000));
        assert!(!activity.idle(start + Duration::from_secs(20000), 600));
        activity.end("b", start + Duration::from_secs(20000));
        assert!(!activity.idle(start + Duration::from_secs(20599), 600));
        assert!(activity.idle(start + Duration::from_secs(20600), 600));
        activity.keep_alive = true;
        assert!(!activity.idle(start + Duration::from_secs(30000), 600));
        activity.keep_alive = false;
        assert!(!activity.idle(start + Duration::from_secs(30000), 0));
    }
}
