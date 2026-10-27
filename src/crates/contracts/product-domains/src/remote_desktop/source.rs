//! Intentional source changes retain the attachment while native IO drains.
//! The host adapter must invalidate input before applying Close, confirm actual
//! drainage through media_closed, and supply a fresh PC ID for resume. These
//! methods own no protocol IO, native capture, timers or input lease.
use super::*;

impl ReadOnlyHost {
    pub(super) fn source_attachment(
        &self,
        source: &ControllerIdentity,
        attach_id: &str,
    ) -> Result<&Attachment, ReadOnlyError> {
        let current = self
            .attachment
            .as_ref()
            .filter(|a| a.owner == *source && a.snapshot.attach_id == attach_id)
            .ok_or(ReadOnlyError::StaleConnection)?;
        if !self.allows(source, &current.snapshot.display_id) {
            return Err(ReadOnlyError::AuthorizationRequired);
        }
        if self.relay_lost_at_ms.is_some() {
            return Err(ReadOnlyError::RelayUnavailable);
        }
        Ok(current)
    }

    fn suspend_source(&mut self) -> Vec<MediaEffect> {
        let current = self.attachment.as_mut().unwrap();
        if current.snapshot.phase == ViewPhase::Suspended {
            return Vec::new();
        }
        current.snapshot.phase = ViewPhase::Suspended;
        let connection_id = current.snapshot.connection_id.clone();
        self.retiring_connection = Some(connection_id.clone());
        vec![MediaEffect::Close { connection_id }]
    }

    /// Retire transport authority immediately; the adapter applies Close and
    /// confirms native drainage separately. The attachment remains occupied.
    pub fn suspend(
        &mut self,
        source: &ControllerIdentity,
        attach_id: &str,
        expected_revision: &str,
    ) -> Result<Vec<MediaEffect>, ReadOnlyError> {
        if self.source_attachment(source, attach_id)?.snapshot.phase == ViewPhase::Suspended {
            return Ok(Vec::new());
        }
        if expected_revision != self.revision() {
            return Err(ReadOnlyError::StaleRevision);
        }
        self.advance()?;
        Ok(self.suspend_source())
    }

    /// Select an explicitly authorized source without transferring old control
    /// scope or retaining usable coordinates. Geometry belongs to the adapter.
    pub fn select_display(
        &mut self,
        source: &ControllerIdentity,
        attach_id: &str,
        display_id: &str,
        expected_revision: &str,
    ) -> Result<Vec<MediaEffect>, ReadOnlyError> {
        let current = self.source_attachment(source, attach_id)?;
        if !self.allows(source, display_id) {
            return Err(ReadOnlyError::AuthorizationRequired);
        }
        if current.snapshot.display_id == display_id {
            return Ok(Vec::new());
        }
        if self.retiring_connection.is_some() {
            return Err(ReadOnlyError::CleanupPending);
        }
        if expected_revision != self.revision() {
            return Err(ReadOnlyError::StaleRevision);
        }
        self.advance()?;
        let effects = self.suspend_source();
        self.attachment.as_mut().unwrap().snapshot.display_id = display_id.into();
        Ok(effects)
    }

    /// Prepare viewing only after successful drainage. The adapter supplies a
    /// globally fresh PC ID, rechecks OS/source availability and negotiates the
    /// new transport. This transition never restores an input lease.
    pub fn resume(
        &mut self,
        source: &ControllerIdentity,
        attach_id: &str,
        expected_revision: &str,
        connection_id: &str,
    ) -> Result<Vec<MediaEffect>, ReadOnlyError> {
        let current = self.source_attachment(source, attach_id)?;
        if self.retiring_connection.is_some() {
            return Err(ReadOnlyError::CleanupPending);
        }
        if current.snapshot.phase != ViewPhase::Suspended
            || !valid_id(connection_id)
            || current.snapshot.connection_id == connection_id
        {
            return Err(ReadOnlyError::InvalidRequest);
        }
        if expected_revision != self.revision() {
            return Err(ReadOnlyError::StaleRevision);
        }
        self.advance()?;
        let current = self.attachment.as_mut().unwrap();
        current.snapshot.connection_id = connection_id.into();
        current.snapshot.phase = ViewPhase::Binding;
        Ok(vec![MediaEffect::Prepare {
            connection_id: connection_id.into(),
            display_id: current.snapshot.display_id.clone(),
        }])
    }
}

#[cfg(test)]
mod tests;
