# AGENTS.md — Profile integration tests

This tree owns cross-package behavior of shipped `dsh` profiles. Start product scenarios through `apps/cli/src/bin.ts` with `--profile <name>` or the `<name>` shorthand; a test-only Loader driver is allowed only when the public profile output cannot expose the asserted internal evidence.

Keep a composition here only when the CLI profile assembly is the subject. Move package-specific Loader configurations and drivers into that package's `tests/fixtures/`. Recorded-session replay belongs under top-level `snapshots/`; other expected output uses `*.expected.e2e.ts` and an owner-local `expected/` directory.

User-facing optional overlays live under `apps/cli/config/examples/` and have a published guide under `docs/user/`. They are product assets, not test fixtures.
