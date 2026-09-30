# Page Function Runtime

This crate owns the embedded JavaScript runtime used to execute OpenBitFun Page
Functions (rquickjs).

## Ownership

- JS sandbox construction, function invocation, and structured result/error
  mapping belong here.
- Product assembly, relay HTTP routes, and host lifecycle stay outside this crate.
- Keep the runtime free of product capability selection and UI concerns.

## Boundaries

- Do not depend on assembly, interface, or application crates.
- Callers such as `relay-service` may depend on this crate for execution only.

## Verification

Run `cargo test -p openbitfun-page-function-runtime` and
`node scripts/check-core-boundaries.mjs` after changes.

For OHOS binding or native build changes, also run
`node scripts/ohos-cargo.mjs test --locked -p openbitfun-page-function-runtime --no-run`
from the repository root with the OHOS SDK and Rust target installed. This
checks target compilation and linking; it does not execute tests on a device.
