# AGENTS.md — Performance Benchmarks

This tree owns required, repository-level performance gates whose measured user path crosses package ownership. Package-local diagnostics remain beside their owners and use the `.perf.ts` suffix instead of joining `test:bench`.

- Organize benchmarks by measured user path, one directory per path. Do not mirror the package tree.
- Host cases use `*.bench.ts`; Client-face cases use `*.bench.client.ts`. Worker, fixture, and support modules do not carry a benchmark suffix.
- The private `@deepseek-ai/dsh-benchmarks` workspace owns benchmark-only dependencies. `test:bench` builds workspace libraries and `benchmarks/.dsh-build/` workers before Vitest orchestration. Timed CPU work runs in those workers under plain Node, without a TypeScript loader; runtime package imports must resolve to built `lib/` entries.
- Browser workflow cases drive built Client bundles through the shared shipped-composition Web scaffold. Report its source-resolved test Host separately from published-Host evidence; two animation frames prove a rendering opportunity, not hardware presentation. Use fresh browsers and private scaffold worlds per sample.
- Synthesize fixed inputs from reviewed constants. Never use recorded Sessions, user material, ambient repositories, or network services.
- Run process-level wall-clock and retained-memory samples in fresh children with private `mkdtemp` roots. Pure synchronous folds create a fresh object graph per sample and must not mutate process-global state. Bound every child, await exit, and remove owned roots after failure as well as success.
- Record reference-machine expectations separately from the shared CI time scale and variance headroom. Do not apply the time scale to memory or dimensionless ratios.
- Report enough raw and aggregate measurements to explain each verdict, including whether a budget uses a median, minimum, absolute value, or ratio. Enforce reviewed source constants; environment variables must not override performance budgets.
- Keep scenario-specific support beside its benchmark. Move a helper into `benchmarks/support/` only after at least two benchmark directories require the same behavior.
- Exercise production entry points. Do not copy product algorithms, add production exports solely for measurement, or turn benchmark completion into duplicate semantic assertions.
- A compiled worker may bundle a private integration adapter when no public Node export exposes the measured user path. Keep package imports external so product services resolve through their built package exports.
- Record the workload, timing boundary, memory endpoint, calibration reference, alternatives, and known exclusions in the owning Agent Note.
