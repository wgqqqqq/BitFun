//! A suspended attachment owns its drained slot until resume, stop or timeout.
//! Native cleanup remains in the media actor; this module never supplies proof
//! of it. All owner access follows owner -> active-slot lock order.
use super::*;
use openbitfun_product_domains::remote_desktop::ViewPhase;

const RETENTION_BUDGET: Duration = Duration::from_secs(60);

impl Slot {
    pub(in crate::remote_desktop) fn route_visible(&self, now: Instant) -> bool {
        !self.canceled() || self.retained_until.get().is_some_and(|until| now < *until)
    }

    /// Caller serializes the pure resume transition and reservation under the
    /// host owner lock. Checking here also fences expiry before the actor tick.
    pub(super) fn replacement_allowed(
        &self,
        pending: &PendingMedia,
        now: Instant,
    ) -> Result<(), &'static str> {
        if !self.canceled()
            || self.pending.generation != pending.generation
            || self.source() != &pending.source
            || self.attach_id() != pending.attach_id
            || self.connection_id() == pending.connection_id
            || self.pending.force_relay != pending.force_relay
            || !Weak::ptr_eq(&self.pending.owner, &pending.owner)
        {
            return Err("cleanup_pending");
        }
        match self.retained_until.get() {
            Some(until) if now < *until => Ok(()),
            Some(_) => Err("sharing_ended"),
            None => Err("cleanup_pending"),
        }
    }

    /// Only the media actor calls this after input and native callback drainage.
    pub(super) fn confirm_drained(&self, now: Instant) -> Result<(), ()> {
        let Some(owner) = self.pending.owner.upgrade() else {
            return Ok(());
        };
        let mut owner = owner.lock().unwrap();
        let Some(host) = owner
            .as_mut()
            .filter(|host| host.account_generation == self.pending.generation)
        else {
            return Ok(());
        };
        host.policy
            .media_closed(self.connection_id())
            .map_err(|_| ())?;
        let suspended = host.policy.snapshot(self.source()).is_ok_and(|state| {
            !state.cleanup_pending
                && state.attachment.is_some_and(|current| {
                    current.attach_id == self.attach_id()
                        && current.connection_id == self.connection_id()
                        && current.phase == ViewPhase::Suspended
                })
        });
        if suspended && self.retained_until.get().is_none() {
            self.retained_until
                .set(now + RETENTION_BUDGET)
                .map_err(|_| ())?;
        }
        Ok(())
    }

    pub(super) fn retain(&self, now: Instant) -> bool {
        let Some(until) = self.retained_until.get() else {
            return false;
        };
        let Some(owner) = self.pending.owner.upgrade() else {
            return false;
        };
        let mut owner = owner.lock().unwrap();
        let Some(host) = owner.as_mut().filter(|host| {
            host.account_generation == self.pending.generation
                && crate::remote_desktop::connection::is_current(self.pending.generation)
        }) else {
            return false;
        };
        let _ = host
            .policy
            .expire_relay_grace(host.started.elapsed().as_millis() as u64);
        let suspended = host.policy.snapshot(self.source()).is_ok_and(|state| {
            state.attachment.is_some_and(|current| {
                current.attach_id == self.attach_id()
                    && current.connection_id == self.connection_id()
                    && current.phase == ViewPhase::Suspended
            })
        });
        if !suspended {
            return false;
        }
        if now >= *until {
            host.failure = Some((self.source().clone(), "sharing_ended"));
            let _ = host.policy.stop();
            return false;
        }
        true
    }

    /// A retired PC must not unregister the Relay association retained by this
    /// attachment, including after its successor has already entered binding.
    pub(super) fn attachment_continues(&self) -> bool {
        self.pending.owner.upgrade().is_some_and(|owner| {
            owner.lock().unwrap().as_ref().is_some_and(|host| {
                host.account_generation == self.pending.generation
                    && host.policy.snapshot(self.source()).is_ok_and(|state| {
                        state
                            .attachment
                            .is_some_and(|a| a.attach_id == self.attach_id())
                    })
            })
        })
    }
}

#[cfg(test)]
mod tests;
