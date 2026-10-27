# Native safe SDK wrapper

Keep this copy aligned with the pinned upstream source; only the additions in
`OPENBITFUN-PATCH.md` are intentional. Do not reformat unrelated upstream code.
It remains an external dependency, not a product runtime owner.

Native lifetime rules in [webrtc-sys](../webrtc-sys/AGENTS.md) also apply here.
Read-only accessors must not introduce callbacks, owner back-references or
handle registries. Actual protocol admission stays in the Desktop adapter.
Use the focused Desktop native test in the patch note; do not run the upstream
whole library suite, whose other tests may contact external services.
