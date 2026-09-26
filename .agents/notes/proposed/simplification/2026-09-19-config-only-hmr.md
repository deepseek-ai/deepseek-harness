# Agent Note: Limit DSH HMR to live profile configuration

Status: proposed

English | [中文](2026-09-19-config-only-hmr.zh.md)

## Problem

[DSH HMR](../../../../packages/boot/hmr/src/index.ts) owns both serialized profile configuration refresh and running JavaScript module replacement. Module replacement adds Node-loader internals, dependency traversal, cache backup, old/new plugin fibers, rollback, module watches, and import-error formatting. The [base composition](../../../../packages/bundle/base/cordis.patch.yml) uses `root: []`; other shipped profiles disable or omit HMR. The default product requires configuration refresh, while source replacement serves an explicit custom-profile opt-in.

That opt-in is real supported behavior: [profile tests](../../../../apps/cli/tests/profile-hmr.spec.ts), module tests, and a [built CLI test](../../../../apps/cli/tests/built-bin.e2e.ts) exercise it, and generated inspection APIs advertise its methods and events. This proposal trades developer continuity for a smaller maintained subsystem; it does not classify the code as unreachable.

## Proposal

Keep `watchConfig`, `runExclusive`, exact profile/home patch and manifest watches, application-readiness coordination, serialized refresh, and disposal drainage. Require a process restart for source-module, arbitrary Include, and framework-dependency changes; remove automatic framework-change calls to `loader.exit()`. Keep browser Client loading independent.

Remove the module watcher and dispatch, dependency graph analysis, module-cache/fiber replacement and restoration, module-only state/options, `baseDir`, `getOuterStack`, `getLinked`, and `hmr/change`/`hmr/reload`. Remove the [import-error formatter](../../../../packages/boot/hmr/src/error.ts), module-only dependencies, and dedicated module/error tests. Keep Chokidar and configuration watcher options actually used by [exact watches](../../../../packages/boot/hmr/src/watch-config.ts). Roughly 400 identified source lines and 372 dedicated test lines belong to the removable module paths; retained configuration code and mixed tests must be counted separately in implementation.

Update the [profile-management decision](../../implemented/architecture/2026-09-14-current-profile-plugin-management.md) and [single-launcher decision](../../implemented/architecture/2026-08-22-single-dsh-application-launcher.md) only where they promise module replacement or its coordination. Their configuration, installation, and launcher responsibilities remain. The [non-transactional Loader decision](../../implemented/simplification/2026-09-09-nontransactional-loader.md) motivates avoiding duplicated rollback but does not already authorize withdrawing source HMR.

## Alternatives considered

**Keep opt-in source replacement.** Plugin authors can edit code without restarting an active Session, and failed replacements restore old plugins. That capability is useful; this proposal deliberately gives it up to remove loader-version coupling and replacement-state ownership from DSH.

**Remove only rollback or delegate replacement elsewhere.** Partial removal can leave cached modules and live fibers from different generations. A wrapper around another HMR implementation retains the public behavior and coordination burden. Neither establishes the complete deletion proposed here.

## Acceptance criteria

- Live profile/home patch and bundle-list changes, Plugin Manager serialization, readiness, self-removal, disposal drainage, and recovery after a later valid edit retain coverage.
- Source and arbitrary Include changes take effect on restart. Removed source options receive an explicit migration/configuration error; update shipped `root: []` rows rather than silently ignoring obsolete options.
- Remove module-only APIs, events, dependencies, generated declarations, and tests. Preserve the remaining public queue/watch APIs and package installation/restart semantics.
- Run focused HMR configuration/watch/coordination and Plugin Manager tests, app-boot reload coverage, and a real built CLI profile-refresh scenario. Replace source-replacement expectations with the agreed restart behavior and update required assembled snapshots and documentation.

## Risks

Custom profiles and installed plugins lose live server-code replacement and its failure restoration. Restarting can interrupt long-lived development work; acceptance therefore requires agreement to this product trade-off. Removing shared configuration coordination or recreating source replacement in another package would defeat the proposal.
