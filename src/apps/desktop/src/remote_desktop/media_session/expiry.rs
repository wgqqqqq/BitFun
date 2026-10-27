//! An immutable, fail-closed lifetime for one PC's scoped TURN credentials.
//! Wall-clock corrections can shorten it, never extend or revive it. Timers
//! arrange cleanup; frame/input submission checks this same gate directly.
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub(super) struct CredentialLifetime {
    monotonic_deadline: Instant,
    wall_deadline: SystemTime,
    expired: AtomicBool,
}

impl CredentialLifetime {
    pub(super) fn new(expires_at: u64) -> Option<Self> {
        let monotonic = Instant::now();
        Self::at(expires_at, SystemTime::now(), monotonic)
    }

    pub(super) fn at(expires_at: u64, wall: SystemTime, monotonic: Instant) -> Option<Self> {
        wall.duration_since(UNIX_EPOCH).ok()?;
        let wall_deadline = UNIX_EPOCH.checked_add(Duration::from_secs(expires_at))?;
        let remaining = wall_deadline.duration_since(wall).ok()?;
        if remaining.is_zero() {
            return None;
        }
        Some(Self {
            monotonic_deadline: monotonic.checked_add(remaining)?,
            wall_deadline,
            expired: AtomicBool::new(false),
        })
    }

    /// Relative budget for the controller; no host wall-clock assumption crosses
    /// the wire. Sampling never extends this PC's immutable credential lifetime.
    pub(super) fn remaining_ms(&self) -> u64 {
        self.remaining_at(SystemTime::now(), Instant::now())
    }

    fn remaining_at(&self, wall: SystemTime, monotonic: Instant) -> u64 {
        if !self.valid_at(wall, monotonic) {
            return 0;
        }
        self.wall_deadline
            .duration_since(wall)
            .unwrap_or_default()
            .min(self.monotonic_deadline.saturating_duration_since(monotonic))
            .as_millis()
            .min(u64::MAX as u128) as u64
    }

    pub(super) fn valid(&self) -> bool {
        self.valid_at(SystemTime::now(), Instant::now())
    }

    fn valid_at(&self, wall: SystemTime, monotonic: Instant) -> bool {
        if wall.duration_since(UNIX_EPOCH).is_err()
            || wall >= self.wall_deadline
            || monotonic >= self.monotonic_deadline
        {
            self.expired.store(true, Ordering::Release);
        }
        !self.expired.load(Ordering::Acquire)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_budget_uses_both_clocks_and_expiry_stays_sticky() {
        let wall = UNIX_EPOCH + Duration::from_millis(1_000_750);
        let mono = Instant::now();
        let lifetime = CredentialLifetime::at(1301, wall, mono).unwrap();
        assert_eq!(lifetime.remaining_at(wall, mono), 300_250);
        assert_eq!(
            lifetime.remaining_at(
                wall - Duration::from_secs(100),
                mono + Duration::from_millis(250)
            ),
            300_000
        );
        assert_eq!(
            lifetime.remaining_at(
                wall + Duration::from_secs(240),
                mono + Duration::from_secs(1)
            ),
            60_250
        );
        assert_eq!(
            lifetime.remaining_at(wall + Duration::from_secs(301), mono),
            0
        );
        assert_eq!(lifetime.remaining_at(wall, mono), 0);
    }

    #[test]
    fn fractional_seconds_do_not_add_an_extra_second_to_the_budget() {
        let wall = UNIX_EPOCH + Duration::from_millis(1_000_750);
        let mono = Instant::now();
        let lifetime = CredentialLifetime::at(1001, wall, mono).unwrap();
        assert!(lifetime.valid_at(wall, mono + Duration::from_millis(249)));
        assert!(!lifetime.valid_at(wall, mono + Duration::from_millis(250)));
    }

    #[test]
    fn clock_rollback_cannot_extend_the_original_remaining_lifetime() {
        let wall = UNIX_EPOCH + Duration::from_secs(1000);
        let mono = Instant::now();
        let lifetime = CredentialLifetime::at(1300, wall, mono).unwrap();
        let earlier_wall = wall - Duration::from_secs(200);
        assert!(lifetime.valid_at(earlier_wall, mono + Duration::from_secs(299)));
        assert!(!lifetime.valid_at(earlier_wall, mono + Duration::from_secs(300)));
    }

    #[test]
    fn forward_clock_expiry_is_sticky_after_the_clock_is_corrected() {
        let wall = UNIX_EPOCH + Duration::from_secs(1000);
        let mono = Instant::now();
        let lifetime = CredentialLifetime::at(1300, wall, mono).unwrap();
        assert!(!lifetime.valid_at(wall + Duration::from_secs(300), mono));
        assert!(!lifetime.valid_at(wall, mono + Duration::from_secs(1)));
    }

    #[test]
    fn invalid_clock_and_expired_or_unrepresentable_deadlines_are_rejected() {
        let wall = UNIX_EPOCH + Duration::from_secs(1000);
        let mono = Instant::now();
        assert!(CredentialLifetime::at(1000, wall, mono).is_none());
        assert!(CredentialLifetime::at(999, wall, mono).is_none());
        assert!(CredentialLifetime::at(u64::MAX, wall, mono).is_none());
        assert!(CredentialLifetime::at(1300, UNIX_EPOCH - Duration::from_secs(1), mono).is_none());
        let lifetime = CredentialLifetime::at(1300, wall, mono).unwrap();
        assert!(!lifetime.valid_at(UNIX_EPOCH - Duration::from_secs(1), mono));
        assert!(!lifetime.valid_at(wall, mono));
    }
}
