# Relay Service

This crate owns the reusable Remote Connect relay runtime shared by standalone
and embedded hosts.

## Ownership

- Device state, verified GitHub identity exchange, scoped credentials, HTTP/WebSocket
  routes, and memory/disk web asset stores belong here.
- Standalone host binding, environment configuration, static-file fallback,
  process lifecycle, and administrative CLI parsing/output remain in the app.
- The Desktop embedded host binds TCP, installs its static fallback, and owns
  its task lifecycle in `src/apps/desktop`; assembly controls only product
  start/stop sequencing through a narrow host port.
- Hosts supply the version reported by the shared health and info routes.
- Default account Relay builders expose no remote-desktop capability or route.
  An explicit self-hosted pairing configuration selects the independent desktop
  service: no account login, Pages or general Agent RPC. It owns a separate DB;
  never enable remote control on the official login deployment as a fallback.
- Keep relay messages opaque. Devices retain their own private keys; public-key
  lookup and message routing must enforce authenticated account ownership.
- Keep admission before body buffering and preserve resource permits through
  cancellation and slow-reader failures. Test quota boundaries and isolation.
- The relay forwards; it does not store user content. Session transcripts,
  terminal output and catalogs are host-owned streams read on demand from the
  online device through device RPC (`read_stream`) and encrypted device-event
  hints. Do not reintroduce relay-side session, message or per-account sequence
  tables. The only persisted request bodies are short-lived encrypted RPC
  payload references. Retired history routes stay mapped to `410 Gone` with the
  `relay_session_history_retired` reason (`realtime/retired_session_history.rs`)
  so older clients degrade loudly rather than silently.

## Boundaries

- Do not depend on assembly, interface, or application crates.
- Standalone and embedded hosts must construct the same router from this crate.
- Do not introduce host-specific APIs or duplicate the relay runtime per host.
- The independently built identity verifier supplies a ring `ClientConfig` to
  its own Reqwest client. This narrow standalone exception must not install or
  replace the process-wide provider; embedded product hosts retain the
  `services-core::tls_provider` owner. Boundary checks require the explicit
  client binding and forbid `install_default` in this verifier.

## Verification

Run `cargo test -p openbitfun-relay-service` and
`node scripts/check-core-boundaries.mjs` after changes.

For the dedicated remote desktop signaling lane, use
`cargo test --locked -p openbitfun-relay-service --lib account_transport_tests::remote_desktop::`.
When changing shared identity, admission, or capability discovery, include
`account_transport_tests::` to preserve legacy RPC and both public path layouts.

Account identity supports independent GitHub and email-code users. Preserve legacy
numeric GitHub Relay IDs; email `accountId` values occupy the `email-` namespace.
Never derive identity from the caller's claimed user ID or display name. New
clients opt into the hosted chooser with `methods=all` on the existing start route;
legacy calls keep direct GitHub URLs. Run `cargo test -p openbitfun-relay-service
--lib account_transport_tests::` for account isolation, device RPC and revocation
across both identity kinds and both route layouts.

Attachment authorization links stay ephemeral in `realtime/remote_desktop`.
Use the remote-desktop transport filter above for original socket/token/key
pinning, acknowledged invalidation, reconnect and registration cleanup. Include
`account_transport_tests::` after changing the shared five-second auth owner.
These router tests do not prove native pixels, DTLS binding or media termination.

The same filter checks `credentialBinding` across fresh routers sharing one DB:
the original credential pair stays stable after registry loss, a replacement
token differs even after the old token is revoked, and controller-supplied
metadata is ignored. The binding is opaque host metadata, never a forwarded
token or media authority. Keep legacy discovery and RPC working; new hosts
negotiate `remote_desktop_credential_binding_v1` before advertising media.

For attachment-scoped TURN credential issuance, use the same remote-desktop
transport filter and `cargo test --locked -p openbitfun-relay-service --lib remote_desktop_turn`.
HTTP and Socket.IO must share one association registry. Recheck the original
participant tokens/keys; presence, delegated scopes and replacement tokens
cannot obtain ICE credentials. Signing secrets are host-supplied private config,
never serializable route data. Include `--lib` after HTTP admission/builder changes
to preserve legacy routes and both public mount layouts.
