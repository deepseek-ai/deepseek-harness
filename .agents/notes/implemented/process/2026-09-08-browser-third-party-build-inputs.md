# Agent Note: Browser third-party libraries as build inputs

Status: implemented

English | [中文](2026-09-08-browser-third-party-build-inputs.zh.md)

## Problem

Prebuilt browser plugins distribute their third-party implementations inside JavaScript, but production npm dependencies still make installers download those libraries separately and resolve their peers. When React is declared only for development, installers can select a different React version for those extra dependencies than the browser artifact uses. Both `use-sync-external-store@1.2.0` and `@tanstack/react-virtual@3.14.9` support the current React 18; this problem does not require a React upgrade.

## Decision

Browser-only third-party dependencies belong in `devDependencies`, including implementations inlined into dynamic plugins, static browser-library inputs, and React shared by the Web shell. This partially supersedes the preservation of ordinary third-party declarations in [published dependency faces](2026-08-26-published-dependency-faces.md); that note continues to govern package selection, Host value dependencies, and Cordis identity.

The dependency classifier collects build inputs from source imports and JSX. Third-party libraries reachable by the Host runtime take precedence as `dependencies`; additional Node build entries must also be checked. Type-only source references do not create Host runtime dependencies. Existing configuration-metadata and shared-Host-export classifications remain unchanged.

Npm sections do not select browser bundling behavior. Dynamic plugins inline private libraries and obtain React and other shared modules from the platform table; static browser libraries retain bare imports and styles for the final Vite build. Static packages are Web-shell build inputs, not independently installed libraries with every rebundling dependency provided. Source builds need development dependencies; installed published Web artifacts do not.

License classification follows distributed content. Dependency resolution through the real browser build configurations covers dynamic plugins and the Web shell; resolved third-party implementations remain [runtime disclosures](2026-07-30-generated-third-party-notices.md) even when manifests declare them for development. Test tools, erased type imports, and build tools do not become distributed code merely by appearing in `devDependencies`.

## Alternatives considered

**Declare another production React or override peer resolution.** This retains an extra installed graph that the browser does not use, without making that installed copy the browser's shared instance.

**Inline every static-library dependency early.** This changes Vite's third-party chunks, caching, and CSS handling; dependency classification does not require those build changes.

**Move every third-party dependency of a Client-bearing package.** Dual-face packages still load Host libraries, including `fflate` for ZIP output and `zod` for RPC validation; those installation relationships must remain.

**Classify license disclosures directly by manifest section.** Distributing browser code and having an installer download a same-named package are different facts; that distinction cannot remove license checks on distributed code.

## Consequences

Production dependencies do not install third-party libraries a second time solely for browser implementations. React and React DOM retain one build version, and plugins consume the Web shell's shared instance. Classification tests constrain browser dev-only inputs, Host precedence, and idempotent repair; publication checks reject React installation leaks, while browser artifact verification independently covers module loading.

Classification remains source-based. License resolution likewise must not depend on existing `lib/` files or write build outputs; its tests cover real resolution, type erasure, asset references, and missing dependencies. Developers independently consuming static packages or public types supply the corresponding build dependencies themselves; this decision adds no standalone browser-library support promise.
