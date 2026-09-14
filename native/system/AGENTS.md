# AGENTS.md

This workspace owns `@deepseek-ai/node-addon-system`: the Linux `landlock-run` confinement executable and the POSIX `system.node` binding. It shares the root pnpm workspace and lockfile; native packages have one independent version and release workflow.

## Runtime rules

- Landlock's argv, exit codes, diagnostics, and fail-closed confinement are defined in [docs/cli-contract.md](docs/cli-contract.md). Do not change them when extending another system capability.
- The launcher uses only libc, statically linked against musl. Its kernel UAPI definitions remain in the reviewed C source.
- Node bindings use stable Node-API v8, never NAN, V8 C++ APIs, or experimental Node interfaces. Linux glibc and musl addons are distinct binaries; macOS has its own Mach-O bundle.
- The flock binding attempts only `LOCK_EX | LOCK_NB` in asynchronous work and captures errno on that worker. The caller owns the fd through completion and releases its lock by closing it.
- `./landlock-run` and `./flock` are independent capability exports; the package has no root export. Neither import loads the addon. `./flock` loads it only when called; Windows retains the Harness's existing semaphore implementation.
- Runtime binary selection has no environment-variable overrides. `NALR_REQUIRE_LANDLOCK` is a test-only enforcement requirement.
- There is no install-time compile fallback. Missing Landlock binaries probe unusable; missing flock bindings reject acquisition, never silently grant a lock.

## Layout and commands

`packages/entry/` owns JavaScript, types, and auditable C sources. Platform packages hold only binaries and metadata. `scripts/` owns native builds, packing, validation, and release; `test/` owns real process and lock behavior.

Run `pnpm build:ts`, `pnpm build:native`, `pnpm build:test-oracle`, `pnpm typecheck`, and `pnpm test` in this directory. Linux full builds require musl-gcc; macOS uses cc. Repository tests build only their host addon through the root `build:native-system` script. The independent syscall fixture is test-only and never enters a published platform package.

## Packaging and verification

- `os`/`cpu` and `prebuilds.json` are the checked-in package matrix. CI derives runners from that matrix, builds natively on each architecture, and tests identical addon bytes under several Node releases.
- Linux packages contain `bin/landlock-run`, `bin/glibc/system.node`, and `bin/musl/system.node`. macOS packages contain `bin/system.node`. No Windows platform package is needed by these capabilities.
- Platform prepack rejects missing, undeclared, wrong-format, wrong-architecture, and non-Node-API addon payloads. Launcher executability is checked separately.
- Platform tarballs use npm pack to preserve executable permissions. The entry uses pnpm pack for workspace version conversion.
- Packed-install verification checks manifests, installs local tarballs without a registry, byte-pins payloads, and exercises both the installed flock binding and Landlock's functional probe.
- Build outputs stay ignored. Source/consumer changes and their behavior tests land together; preserve bilingual READMEs and independent native publication.
