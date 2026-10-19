# HarmonyOS PC host

Keep ArkTS lifecycle, packaging, signing and native platform bridges here. Product logic remains in the current Rust workspace. This host loads `openbitfun_desktop_lib` from `src/apps/desktop`; never ship a legacy desktop library or a probe as the product.

The vendored ability bridge is pinned to the Rust framework dependency; preserve its license and update both sides together. Never put private signing material into tracked files. The phone host under `src/apps/mobile` is independent.

The HAP bypasses Desktop `main.rs`. Initialize the process-lifetime Tokio runtime
in the native Ability entry before Tauri uses it, with the Desktop 8 MiB worker
stack and four workers; share its handle with Tauri. An environment variable set
in `main.rs` cannot configure this entry. After runtime/bootstrap changes, cold
start a debug HAP with `aa start -a EntryAbility -b com.bitfun.app --pb
openbitfun.runtimeDiagnostic true`. Its explicit diagnostic must report both
native 3 MiB stack probes and the `miniapp-dev` Skill load successful. This is
read-only validation without a model request, not a complete Creative turn test.

For host contract checks run `node --test scripts/ohos-host.test.mjs` from the repository root. Full HAP validation additionally requires an OHOS Desktop library, packaged frontend resources and DevEco SDK; no-run Rust checks are not device tests.

For companion fold-edge transfer geometry, run `node --test scripts/ohos-companion-fold.test.mjs`. This covers directional thresholds and landing bounds only; validate screen discovery, gesture latching and actual transfer separately on a half-folded PC with the lower display available.

For MiniApp desktop shortcuts and native-window contracts, run
`node --test scripts/ohos-miniapp.test.mjs`. This exercises OS-confirmation
completion/cancellation, update refusal, quota failure, external removal,
identity validation and process/capability manifests with mocked platform APIs.
It is not evidence of desktop pinning or native-window behavior on a device.

For immersive workbench caption drag routing, run
`node --test scripts/ohos-window-chrome.test.mjs`. This executes the production
caption script and native hit-test adapter with hidden/visible overlays and
interactive controls. Verify real mouse and touch movement on the PC separately.
