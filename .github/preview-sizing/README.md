# PR preview runner sizing

English | [中文](README.zh.md)

## Summary

The [preview workflow](../workflows/build-preview-cloudflare.yml) builds pull-request previews on standard GitHub-hosted `ubuntu-24.04`. Runner sizing compares complete job cost, not price per minute or core count alone.

## Table of Contents

- [Comparison requirements](#comparison-requirements)
- [Publication semantics](#publication-semantics)
- [Dev Note](#dev-note)

<a id="comparison-requirements"></a>

## Comparison requirements

A sizing experiment holds checkout SHA, lockfile, Node and pnpm versions, workspace build, and preview/VFS packing commands constant. Each runner starts without build outputs. Cold installs do not restore dependency caches; pnpm bootstrap files may already exist. Warm installs restore the same exact cache without prefix fallback. Record the actual runner image, CPU, RAM, disk, cache outcome, phase duration, exit status, and peak memory. GNU time maximum RSS reports a process maximum, not simultaneous aggregate memory across the build process tree.

Calculate estimated gross compute as the sum of each completed job’s elapsed minutes rounded upward, multiplied by that runner’s rate. Include setup, cache restoration, cleanup, failures, and measurement-upload overhead. Report seed jobs separately. Queue delay is a latency observation, not executed job time. These estimates are not invoice totals; standard-runner included minutes and storage are separate.

A build-only benchmark does not deploy, access Cloudflare credentials, or post pull-request comments. Its cost does not establish complete preview publication cost. Confirm the selected runner through the actual preview workflow before treating deployment latency and protected-image delivery as verified.

<a id="publication-semantics"></a>

## Publication semantics

Runner selection does not alter pull-request events, per-PR cancellation, immutable installation, restore-only dependency caching, full workspace build, preview packing, sourcemap removal, or the preview page copied to the deployment root. Cloudflare uploads only the built site to the PR branch alias. The protected-image check requires HTTP 200, no transport content encoding, and gzip magic bytes; the URL comment remains idempotent. Dependabot and other PR authors remain on GitHub-hosted machines.

<a id="dev-note"></a>

## Dev Note

The [runner decision](../../.agents/notes/implemented/process/2026-09-06-preview-hosted-runner-sizing.md) records measurements, cost estimates, and image/CPU variation. The build-only experiment does not verify production deployment.
