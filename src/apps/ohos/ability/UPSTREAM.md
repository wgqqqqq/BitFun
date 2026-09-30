Source: https://github.com/harmony-contrib/openharmony-ability

Revision: `295a276a699ba2352addc69b8cacb6acd3be6ab1`.

Assembled from `package/` and `native_ability/src/main/ets/` at the same revision as the Rust dependency. Do not replace this with the legacy RustAbility fork.

Local adaptation: enable ArkWeb DOM storage for native and embedded WebViews, matching the Desktop frontend storage contract. HarmonyOS disables it by default; leaving it off makes localStorage unavailable during frontend bootstrap.

Web debugging follows the native WebView devtools flag instead of being globally enabled for release builds.
