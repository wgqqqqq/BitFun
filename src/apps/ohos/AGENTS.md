# HarmonyOS PC host

Keep ArkTS lifecycle, packaging, signing and native platform bridges here. Product logic remains in the current Rust workspace. This host loads `openbitfun_desktop_lib` from `src/apps/desktop`; never ship a legacy desktop library or a probe as the product.

The vendored ability bridge is pinned to the Rust framework dependency; preserve its license and update both sides together. Never put private signing material into tracked files. The phone host under `src/apps/mobile` is independent.

For host contract checks run `node --test scripts/ohos-host.test.mjs` from the repository root. Full HAP validation additionally requires an OHOS Desktop library, packaged frontend resources and DevEco SDK; no-run Rust checks are not device tests.

For companion fold-edge transfer geometry, run `node --test scripts/ohos-companion-fold.test.mjs`. This covers directional thresholds and landing bounds only; validate screen discovery, gesture latching and actual transfer separately on a half-folded PC with the lower display available.
