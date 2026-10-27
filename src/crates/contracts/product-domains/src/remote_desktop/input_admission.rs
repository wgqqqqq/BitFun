//! One pure input admission owner: lease and bounded queue cannot disagree.
//! No identity, permission, GUI ticket, OS handle, timer or native drain lives here.
use super::{
    input::{ControlGeneration, InputError, InputMessage, InputQueue},
    lease::{ControlLease, LeaseError, LeaseRevocation},
};

/// Keep one per logical attachment, including after failed cleanup. Only the
/// authenticated host owner may grant after PC/source, grant, health and GUI
/// checks. Do not reconstruct this object to bypass an occupied drain barrier.
#[derive(Default)]
pub struct InputAdmission {
    lease: ControlLease,
    queue: InputQueue,
}
impl InputAdmission {
    pub fn grant(&mut self, now_ms: u64) -> Result<ControlGeneration, LeaseError> {
        let generation = self.lease.grant(now_ms)?;
        self.queue
            .activate(generation)
            .expect("Input generation history diverged");
        Ok(generation)
    }

    pub fn renew(&mut self, generation: ControlGeneration, now_ms: u64) -> Result<(), LeaseError> {
        let result = self.lease.renew(generation, now_ms);
        if self.lease.pending_release().is_some() {
            self.queue.suspend();
        }
        result
    }

    pub fn release(
        &mut self,
        generation: ControlGeneration,
    ) -> Result<LeaseRevocation, LeaseError> {
        let revocation = self.lease.release(generation)?;
        self.queue.suspend();
        Ok(revocation)
    }

    pub fn expire(&mut self, now_ms: u64) -> Option<LeaseRevocation> {
        let revocation = self.lease.expire(now_ms);
        if revocation.is_some() {
            self.queue.suspend();
        }
        revocation
    }

    /// Recheck immediately before OS submission, including every text chunk.
    /// A dequeued event is not authority; delayed watchdogs grant no grace.
    pub fn permits(&self, generation: ControlGeneration, now_ms: u64) -> bool {
        self.queue.active() && self.lease.permits(generation, now_ms)
    }

    pub fn push(
        &mut self,
        message: InputMessage,
        text_supported: bool,
        now_ms: u64,
    ) -> Result<(), InputError> {
        if self.expire(now_ms).is_some() || !self.queue.active() {
            return Err(InputError::Suspended);
        }
        if !self.lease.permits(message.generation(), now_ms) {
            return Err(InputError::StaleGeneration);
        }
        let generation = message.generation();
        let result = self.queue.push(message, text_supported);
        if result == Err(InputError::Backpressure) {
            // Overflow already cleared the queue. Retire the lease so a
            // previously dequeued event also fails its final native check.
            self.lease
                .release(generation)
                .expect("Active input lease disappeared");
        }
        result
    }

    pub fn pop(&mut self, now_ms: u64) -> Option<InputMessage> {
        self.expire(now_ms);
        self.queue.pop()
    }

    pub fn pending_release(&self) -> Option<LeaseRevocation> {
        self.lease.pending_release()
    }

    /// Only after actual in-flight and recorded native state drainage. A
    /// timeout or client release message does not constitute that confirmation.
    pub fn finish_release(&mut self, revocation: LeaseRevocation) -> bool {
        self.lease.finish_release(revocation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_desktop::input::{InputAction, MAX_PENDING_INPUTS};
    fn key(generation: ControlGeneration) -> InputMessage {
        InputMessage::new(
            generation,
            InputAction::Key {
                usage: 4,
                down: true,
            },
        )
    }
    #[test]
    fn expiry_invalidates_dequeued_input_and_discards_remaining_work_without_a_tick() {
        let mut owner = InputAdmission::default();
        let generation = owner.grant(0).unwrap();
        owner.push(key(generation), false, 1).unwrap();
        owner.push(key(generation), false, 1).unwrap();
        let queued = owner.pop(2).unwrap();
        assert!(!owner.permits(queued.generation(), 6000));
        assert!(owner.pop(6000).is_none());
        assert!(owner.pending_release().is_some());
        assert_eq!(owner.grant(6001), Err(LeaseError::ControlBusy));
    }
    #[test]
    fn pressure_retires_dequeued_input_and_failed_drain_keeps_the_owner_busy() {
        let mut owner = InputAdmission::default();
        let generation = owner.grant(0).unwrap();
        owner.push(key(generation), false, 1).unwrap();
        let dequeued = owner.pop(2).unwrap();
        for _ in 0..MAX_PENDING_INPUTS {
            owner.push(key(generation), false, 3).unwrap();
        }
        assert_eq!(
            owner.push(key(generation), false, 3),
            Err(InputError::Backpressure)
        );
        assert!(!owner.permits(dequeued.generation(), 3));
        assert!(owner.pop(3).is_none());
        assert_eq!(owner.renew(generation, 4), Err(LeaseError::StaleGeneration));
        assert_eq!(owner.grant(4), Err(LeaseError::ControlBusy));
        assert!(owner.finish_release(owner.pending_release().unwrap()));
        assert!(owner.grant(5).is_ok());
    }
    #[test]
    fn stale_messages_and_cleanup_cannot_suspend_the_successor() {
        let mut owner = InputAdmission::default();
        let old = owner.grant(0).unwrap();
        let retired = owner.release(old).unwrap();
        assert!(owner.finish_release(retired));
        let current = owner.grant(1).unwrap();
        owner.push(key(current), false, 2).unwrap();
        assert_eq!(owner.release(old), Err(LeaseError::StaleGeneration));
        assert_eq!(owner.renew(old, 2), Err(LeaseError::StaleGeneration));
        assert_eq!(
            owner.push(key(old), false, 2),
            Err(InputError::StaleGeneration)
        );
        assert!(!owner.finish_release(retired));
        assert!(owner.permits(current, 2));
        assert_eq!(owner.pop(2).unwrap().generation(), current);
    }
    #[test]
    fn expired_renewal_discards_work_and_never_replays_it_after_regrant() {
        let mut owner = InputAdmission::default();
        let old = owner.grant(0).unwrap();
        owner.push(key(old), false, 1).unwrap();
        assert_eq!(owner.renew(old, 6000), Err(LeaseError::LeaseExpired));
        assert!(owner.pop(6000).is_none());
        assert!(owner.finish_release(owner.pending_release().unwrap()));
        let current = owner.grant(6001).unwrap();
        assert!(owner.pop(6002).is_none());
        assert!(owner.permits(current, 6002));
        assert!(!owner.permits(old, 6002));
    }
}
