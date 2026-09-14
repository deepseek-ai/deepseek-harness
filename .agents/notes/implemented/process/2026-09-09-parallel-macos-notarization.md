# Agent Note: Parallel macOS notarization from isolated App copies

Status: implemented

English | [中文](2026-09-09-parallel-macos-notarization.zh.md)

## Problem

The Desktop release distributes a DMG for installation and a ZIP for updates. Waiting for App notarization before creating the DMG serializes two Apple submissions. A proxy improves upload throughput but does not overlap the independent service waits. Stapling modifies the App, so concurrent notarization and packaging cannot safely share that writable directory.

## Decision

The fixed-target installer command signs and verifies one App, then creates two independent copies with `ditto`. The App lane notarizes and staples its copy, verifies its signature, ticket, and Gatekeeper acceptance, and asks electron-builder to create the ZIP and updater metadata. The DMG lane immediately packages its copy, signs the image, and uses the existing artifact-completion hook to notarize, staple, and verify the image. Each electron-builder process receives the actual `.app` path through `--prepackaged`, an isolated output directory, and `--publish never`.

The ZIP contains an individually stapled App. The DMG contains the signed App without an individually stapled ticket; its outer ticket covers the nested code, following Apple's [container guidance](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution). Apple describes [ticket ingestion when Gatekeeper checks the outer container](https://developer.apple.com/forums/thread/125512). Independent extraction of the unstapled App relies on an online or cached ticket; the ZIP supplies an embedded ticket. The directory-only command continues to notarize and staple its App.

Both lanes settle before error propagation or temporary-directory cleanup. Only two successful lanes allow promotion of the DMG, ZIP, ZIP blockmap, and channel metadata. The stapled App replaces the signed directory build, and the caller writes the release completion record last. An error leaves that record absent, so the existing upload validation rejects the incomplete release. Separate output directories also prevent concurrent writes to electron-builder diagnostics and channel metadata.

This refines the notarization ordering in the [Desktop packaging decision](../architecture/2026-08-25-electron-desktop-packaging-and-updates.md); that note remains the owner of release identity, signatures, update ownership, and publishing requirements.

## Alternatives considered

**Share one App between both lanes.** A DMG reader can overlap with `stapler` writes, producing a nondeterministic bundle. Independent copies keep the submitted and distributed bytes stable within each lane.

**Only notarize the DMG.** ZIP updates are distributed independently and need a stapled App. Retaining both submissions keeps that independent qualification explicit.

**Keep serial notarization and only use a proxy.** The same 214.84 MiB DMG uploads in 203.83 seconds directly and 38.59 seconds through the tested system proxy, but neither route removes the serial dependency between Apple submissions. Proxy configuration remains a build-host concern; the packaging script does not change host network settings.

**Run both targets in one electron-builder call before App notarization finishes.** The ZIP must read the stapled copy. Separate prepackaged invocations preserve electron-builder's own archive, blockmap, and metadata implementation without changing its target scheduling or patching the dependency.

## Consequences

On 2026-09-09, full arm64 packaging on the same Mac through the same system proxy took 490.78 seconds with parallel notarization versus 751.33 seconds serially, a 34.7% reduction. The artifact lanes began 8 milliseconds apart and completed in 307.36 seconds for App/ZIP and 268.54 seconds for DMG. Apple accepted both submissions; their uploads completed about one second apart. Each configuration has one full-build sample, so cache and Apple queue variation prevent attributing the entire difference to concurrency.

Two temporary App copies and separate artifact directories increase peak disk usage. Two uploads can contend for network bandwidth, and Apple can queue either submission independently; phase timings describe observed behavior rather than a CI latency budget. A failed lane waits for the other lane to finish before cleanup, which can delay failure reporting but avoids deleting files still owned by a child process.

The [orchestration tests](../../../../apps/desktop/tests/package-macos.spec.ts) use barriers to prove overlap, ticket isolation, both-error collection, and refusal to promote incomplete artifacts. A controlled serial regression fails the overlap assertion. Real signed macOS packaging, extracted ZIP verification, DMG integrity and nested signature checks, and final upload-plan validation qualify the platform tools; cross-version installed updates and offline installation on a clean Mac remain release qualification work.
