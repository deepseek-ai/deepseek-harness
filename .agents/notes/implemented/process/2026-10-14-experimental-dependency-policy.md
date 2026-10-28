# Agent Note: Experimental packages follow the same dependency declaration rules

Status: implemented

English | [中文](2026-10-14-experimental-dependency-policy.zh.md)

## Problem

A [verify-package-dependencies](../../../../scripts/verify-package-dependencies.ts) scope of `packages/!(experimental)/*/package.json` exempts the whole experimental group from the rule that browser and type relationships belong only in devDependencies ([client dependency rules](../../../../packages/client/AGENTS.md#dependency-declaration)), and [published dependency faces](2026-08-26-published-dependency-faces.md) stated its coverage as "non-experimental packages". Under that scope, 4 experimental client packages declared client, api, session, and similar packages as peerDependencies. The webworker packer follows workspace peers into the image, so browser static libraries became sweep roots, and packing agent-team-profile produced 82 unresolvable requests. The [experimental package rules](../../../../packages/experimental/AGENTS.md) state that experimental status does not relax engineering requirements, which that exemption contradicts.

Checking the 6 experimental packages that declare `dsh.client` under the same rules found 46 violations across the full run, all in experimental packages. In addition, a verifier that traces runtime imports only from the Host entry misclassifies inspector's `ws`, which is used only in its worker_threads entry, as devDependencies-only.

## Decision

- The check reads `packages/*/*/package.json`, so experimental packages follow exactly the release rules with no group-level exemption, and the dependency-section check carries no other experimental exception.
- The verifier also scans each package's own Host-side worker and child-process entries, identified from the build entries the package's `tsdown.config.ts` declares. `readHostBuildEntries` imports that config, evaluates its default export once under the `host` build face and once under the `client` build face (`DSH_BUILD_FACE`), combines the results, and keeps entries whose platform is not browser and whose source is outside `src/client/`. The verifier does not guess from source patterns. The configurations can only be imported asynchronously, so the verifier's state reading is async.
- The affected experimental manifests and the lockfile follow the policy; every entry moved out of `peerDependencies` or `dependencies` was confirmed not to be a runtime requirement. cot-translation applies `instanceof` to translator's `TranslationError`, which requires the same class instance, so `peerRequiredHostExports` classifies that export.
- Host-only experimental packages, like release packages, are checked only when listed in `hostPackages`. Whether to extend the check to every Host-only package is a separate decision.
- This decision partially supersedes the package-selection coverage of [published dependency faces](2026-08-26-published-dependency-faces.md), whose package-selection paragraph links back here; that note's other decisions remain in force.

## Alternatives considered

**Fix only these manifests without changing the check scope.** The same declarations would soon return; a rule without an enforcement point is not a rule.

**Skip browser static libraries as sweep roots in the packer.** This only works around the symptom; the incorrect manifests still affect npm installation and other consumers.

## Consequences

`pnpm run verify-package-dependencies` covers experimental packages that declare `dsh.client`, so the manifests it accepts let the webworker packer pack agent-team-profile and voice-input-bundle, and inspector's published manifest keeps its worker runtime dependencies.

The trade-off costs:

- Published experimental manifests list browser and type relationships only as dev dependencies, so users who install these packages individually from npm receive fewer peer hints.
- The verifier cannot see imports injected by a tsdown `banner`, such as the inspector worker's `@deepseek-ai/dsh-app-boot/worker/profile-resolution-bootstrap`. Such a dependency stays only because it is declared; if it is removed by mistake, the verifier does not detect it.
- `readHostBuildEntries` imports the `tsdown.config.ts` of every covered package with a Host face and evaluates its default export under both build faces, so the gate depends on every such config module importing cleanly, and the modules' import side effects run in the gate process; for example, the inspector's config imports its package-local [`scripts/build-devtools.ts`](../../../../packages/experimental/inspector/scripts/build-devtools.ts).
- Measured: loading the 127 additional tsdown configurations takes about 2 s, and the full-run duration stays essentially the same (4:27 without the scan, 4:21 with it).

## Testing

[verify-package-dependencies.spec.ts](../../../../scripts/verify-package-dependencies.spec.ts) pins three cases: an experimental client package that declares a browser package as a peer is rejected, an experimental package listed in `hostPackages` is checked as a configured Host package, and a runtime dependency used only in a worker entry named by `tsdown.config.ts` stays in dependencies. The same spec pins the peer-required classification of translator's `TranslationError`.
