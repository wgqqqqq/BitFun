//! Control lease lifetime for one attachment. No grants, clocks, timers or IO.
//! Only the host owner may call grant/renew after validating the authenticated
//! PC, local control grant, media health and GUI reservation. A generation is
//! a stale-work fence, never evidence of permission.
use super::input::ControlGeneration;

pub const CONTROL_LEASE_MS: u64 = 6_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeaseError {
    ControlBusy,
    StaleGeneration,
    LeaseExpired,
    ClockOverflow,
    GenerationExhausted,
}

/// Identifies the retired lease and its invalidation. Not a native drain proof.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LeaseRevocation {
    released: ControlGeneration,
    current: ControlGeneration,
}
impl LeaseRevocation {
    pub fn released_generation(self) -> ControlGeneration {
        self.released
    }
    pub fn current_generation(self) -> ControlGeneration {
        self.current
    }
}

#[derive(Default)]
enum Phase {
    #[default]
    Idle,
    Held {
        generation: ControlGeneration,
        deadline_ms: u64,
    },
    Draining(LeaseRevocation),
}

/// Serial pure state owned with the input queue by the native host facade.
/// Invalidating a lease closes admission immediately; the slot remains busy
/// until that facade has drained in-flight work and released injected keys.
/// Do not recreate this owner to bypass a failed drain or renew a dead lease.
#[derive(Default)]
pub struct ControlLease {
    latest: u64,
    phase: Phase,
}
impl ControlLease {
    pub fn grant(&mut self, now_ms: u64) -> Result<ControlGeneration, LeaseError> {
        if !matches!(self.phase, Phase::Idle) {
            return Err(LeaseError::ControlBusy);
        }
        let deadline_ms = deadline(now_ms)?;
        // Reserve a distinct generation for revocation as well as the grant.
        // Exhaustion must never keep a held lease alive or wrap to an old ID.
        self.latest
            .checked_add(2)
            .ok_or(LeaseError::GenerationExhausted)?;
        self.latest += 1;
        let generation = ControlGeneration::new(self.latest).unwrap();
        self.phase = Phase::Held {
            generation,
            deadline_ms,
        };
        Ok(generation)
    }

    /// Check again immediately before OS submission. Does not rely on a timer
    /// callback being scheduled on time. Other authority checks are external.
    pub fn permits(&self, generation: ControlGeneration, now_ms: u64) -> bool {
        matches!(self.phase, Phase::Held { generation: current, deadline_ms }
            if current == generation && now_ms < deadline_ms)
    }

    pub fn renew(&mut self, generation: ControlGeneration, now_ms: u64) -> Result<(), LeaseError> {
        let Phase::Held {
            generation: current,
            deadline_ms,
        } = self.phase
        else {
            return Err(LeaseError::StaleGeneration);
        };
        if generation != current {
            return Err(LeaseError::StaleGeneration);
        }
        // A delayed renewal cannot revive an already expired lease even when
        // the watchdog has not run. The facade must consume pending_release.
        if now_ms >= deadline_ms {
            self.release(generation)?;
            return Err(LeaseError::LeaseExpired);
        }
        self.phase = Phase::Held {
            generation,
            deadline_ms: deadline(now_ms)?,
        };
        Ok(())
    }

    /// Idempotent for the currently draining lease. Old release messages cannot
    /// suspend a successor. Clear pending input before starting native cleanup.
    pub fn release(
        &mut self,
        generation: ControlGeneration,
    ) -> Result<LeaseRevocation, LeaseError> {
        match self.phase {
            Phase::Held {
                generation: current,
                ..
            } if generation == current => {
                self.latest += 1; // grant reserved this non-overflowing step
                let revocation = LeaseRevocation {
                    released: generation,
                    current: ControlGeneration::new(self.latest).unwrap(),
                };
                self.phase = Phase::Draining(revocation);
                Ok(revocation)
            }
            Phase::Draining(revocation) if revocation.released == generation => Ok(revocation),
            _ => Err(LeaseError::StaleGeneration),
        }
    }

    /// Called with host monotonic time by the facade's watchdog. Timer/worker
    /// failures leave Draining occupied; repeated ticks do not finish cleanup.
    pub fn expire(&mut self, now_ms: u64) -> Option<LeaseRevocation> {
        match self.phase {
            Phase::Held {
                generation,
                deadline_ms,
            } if now_ms >= deadline_ms => self.release(generation).ok(),
            _ => None,
        }
    }

    pub fn pending_release(&self) -> Option<LeaseRevocation> {
        match self.phase {
            Phase::Draining(revocation) => Some(revocation),
            _ => None,
        }
    }

    /// Only call after actual in-flight work and injected-state drainage succeeds.
    /// A stale callback never frees a new held or draining lease. There is no
    /// automatic completion on timeout and failed native cleanup must not call it.
    pub fn finish_release(&mut self, completed: LeaseRevocation) -> bool {
        if !matches!(self.phase, Phase::Draining(current) if current == completed) {
            return false;
        }
        self.phase = Phase::Idle;
        true
    }
}

fn deadline(now_ms: u64) -> Result<u64, LeaseError> {
    now_ms
        .checked_add(CONTROL_LEASE_MS)
        .ok_or(LeaseError::ClockOverflow)
}

#[cfg(test)]
#[path = "lease_tests.rs"]
mod tests;
