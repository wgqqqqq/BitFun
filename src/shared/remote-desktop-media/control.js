/* Ordered control client for one bound PC. No account IO or platform UI. */
(function (root) {
  'use strict';
  const decimal = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)
    && (value.length < 20 || value <= '18446744073709551615');
  function createController(hooks) {
    let generation, pending, sequence = 0, renewal, closed = false;
    const emit = (code = 'ok') => hooks.state({ control_generation: generation, code, pending: pending?.kind });
    const clearPending = () => { clearTimeout(pending?.timer); pending = undefined; };
    function retire() {
      generation = undefined;
      clearInterval(renewal); renewal = undefined;
    }
    function fail(code) { closed = true; clearPending(); retire(); emit(code); hooks.fail(code); }
    function request(kind, body) {
      if (closed || pending || !hooks.current()) return false;
      const request_id = String(++sequence);
      if (!Number.isSafeInteger(sequence)) { fail('control_delivery_unknown'); return false; }
      pending = { request_id, kind, releasedGeneration: kind === 'release_control' ? body.control_generation : undefined,
        timer: setTimeout(() => fail('control_delivery_unknown'), 4000) };
      if (!hooks.send({ version: 1, request_id, kind, body })) { fail('input_backpressure'); return false; }
      emit(); return true;
    }
    function release() {
      const released = generation;
      retire(); emit();
      // Health/lifecycle notifications can repeat while the release is in
      // flight. Keep its ACK barrier and deadline; do not reopen acquisition.
      if (pending?.kind === 'release_control') return true;
      // Unknown acquire cannot be undone by guessing a generation: close PC.
      if (pending?.kind === 'acquire_control') { fail('control_delivery_unknown'); return false; }
      clearPending();
      return !released || request('release_control', { control_generation: released });
    }
    function receive(message) {
      if (closed || !hooks.current() || message.version !== 1) return;
      if (message.kind === 'control_revoked') {
        // Host health loss can discard a queued release. Its post-drain
        // revocation is still definitive for this exact retired lease.
        const released = pending?.kind === 'release_control' && pending.releasedGeneration === message.control_generation;
        if (!decimal(message.control_generation) || (message.control_generation !== generation && !released)) return;
        clearPending(); retire(); emit('control_revoked'); return;
      }
      if (message.kind === 'control_error') { fail(message.code || 'input_suspended'); return; }
      if (message.kind !== 'control_result' || !pending || message.request_id !== pending.request_id) return;
      const { kind } = pending;
      clearPending();
      if (message.code !== 'ok') { retire(); emit(message.code || 'input_suspended'); return; }
      if (kind === 'acquire_control') {
        if (!decimal(message.control_generation) || !hooks.healthy()) { fail('control_delivery_unknown'); return; }
        generation = message.control_generation;
        renewal = setInterval(() => {
          if (!generation) return;
          if (!hooks.healthy()) { release(); return; }
          if (!pending) request('renew_control', { control_generation: generation });
        }, 2000);
      } else if (kind === 'renew_control' && message.control_generation !== generation) {
        fail('stale_control'); return;
      }
      emit();
    }
    function acquire(revision) {
      if (generation || !hooks.healthy() || typeof revision !== 'string' || !revision || revision.length > 128) return false;
      return request('acquire_control', { expected_state_revision: revision });
    }
    function input(message) {
      // Preserve the generation captured when this input intent was created.
      if (closed || !generation || message.control_generation !== generation || !hooks.current()) return false;
      if (!hooks.healthy()) { release(); return false; }
      if (!hooks.send(message)) { fail('input_backpressure'); return false; }
      return true;
    }
    function stop() {
      if (closed) return;
      release(); closed = true; clearPending(); retire();
    }
    return { acquire, release, input, receive, stop };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { createController };
  root.OpenBitFunRemoteDesktopControl = { createController };
})(typeof window === 'undefined' ? globalThis : window);
