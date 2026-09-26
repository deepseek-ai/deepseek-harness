# Agent Note: Desktop update policy and installation

Status: proposed

English | [中文](2026-09-08-desktop-update-policy-and-installation.zh.md)

## Problem

Desktop usually runs a local dsh server, so remote business errors cannot reliably deliver mandatory-update policy. Users need automatic discovery, user-initiated downloads, visible preparation state, and separate restart approval that accounts for running tasks.

## Proposal

This proposal records outstanding release and backend work; the [implemented client decision](../../implemented/feature/2026-09-11-desktop-mandatory-update-client.md) and [Desktop README](../../../../apps/desktop/README.md) own current behavior.

| Document | Owns |
|---|---|
| This proposal | Outstanding release, backend, CDN, and product decisions |
| [Mandatory-update API](2026-09-08-desktop-mandatory-update-api.md) | Request and response fields, server policy requirements, backend integration checklist |
| [Deferred extensions](2026-09-08-desktop-update-extensions.md) | Independent Desktop revisions, channel switching, automatic installation, replacement of pending updates |

### Release and backend qualification

Release owners must qualify signed Windows x64 and macOS x64/arm64 upgrades end to end: discovery, download, hash and signature checks, task-safe shutdown, installation, restart, new-version Host startup, and profile reconciliation. Publish immutable packages and blockmaps before the mutable Nightly feed. The [packaging decision](../../implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.md) owns version and artifact rules. The [API proposal](2026-09-08-desktop-mandatory-update-api.md) owns policy fields; production integration must verify guest access, force/no-force responses, errors, platform selection, approved origins, and rate limits. Publish a resolving updater release before enabling mandatory policy.

### Open product choices

Persisting a mandatory block across a same-version offline restart requires product confirmation. If newer C appears while A downloads or waits for installation, retain A until product owners approve replacement; never silently turn approval for A into installation of C. Installed Windows and macOS attention remains subject to notification permissions, focus modes, minimized windows, and stale clicks. The [deferred extensions](2026-09-08-desktop-update-extensions.md) own automatic replacement and installation.

<a id="cdn-and-capacity-qualification"></a>

### CDN and capacity qualification

The following release and operations choices are pending; they are not active CDN settings or completed load qualification.

- [ ] Operations: separate `/dsh-desk/feeds/*` from `/dsh-desk/bin/*`; do not retain a blanket cache bypass for large production downloads. For feeds, evaluate client revalidation with `max-age=0`, a 30–60-second edge TTL, and a purge on publication. Agree on the maximum propagation delay and measure fixed-URL replacement across regions; a purge is not a guarantee of immediate global visibility.
- [ ] Operations and release owner: evaluate a 30-day to one-year edge TTL for versioned or hash-named packages and blockmaps, without overwriting their URLs. Upload and verify binaries, prewarm them, then publish the feed; confirm retention covers older clients' differential-update inputs.
- [ ] Operations and Desktop maintainers: verify node TTL separately from client Cache-Control, using repeat-request cache status, hit ratio, and COS origin metrics. Check whether updater-added query parameters fragment the cache key or bypass caching; ignore only parameters proven irrelevant to content. Verify Range/206, Content-Range, complete-file hashes, and feed freshness through the actual updater. See Tencent's [node TTL](https://cloud.tencent.com/document/product/1552/70777), [browser TTL](https://cloud.tencent.com/document/product/1552/70758), and [cache configuration](https://cloud.tencent.com/document/product/1552/95263) documentation.
- [ ] Desktop maintainers and product owner: confirm startup and overdue-resume burst handling. Periodic jitter and bounded failure backoff are implemented and tested; startup and overdue wakeups still check immediately. Adding a short randomized delay to those triggers needs product confirmation. Mandatory-policy polling remains a separate API and scheduling policy.
- [ ] Operations and release owner: size request and bandwidth budgets using online clients, startup/manual/retry peaks, package sizes, and expected download participation. At evenly distributed ten-minute polling, 100,000 online clients average about 167 checks/second and 1,000,000 about 1,667, before extra triggers. CDN caching reduces origin load, not client download traffic charges; a functional probe is not a load test.
- [ ] Operations: configure cache-hit, origin-QPS, error-rate, bandwidth, and cost alerts with agreed thresholds and an on-call owner. Qualify abuse protection without breaking updater requests or shared-NAT clients; updater endpoints must not require an interactive browser challenge. Record an incident response procedure before launch.

## Alternatives considered

**Automatic package predownload.** This consumes bandwidth before the user requests a download. Automatic discovery remains useful, but every initial transfer and retry requires user action independently of later installation approval.

**Automatic restart or installation on ordinary quit.** This bypasses explicit task-impact approval. Automatic installation requires separate product authorization and platform verification.

**One remote API controlling all updates.** Mandatory policy and ordinary artifact discovery have different responsibilities. Keep the policy page separate from updater metadata and reuse only the installation coordinator when qualified.

## Acceptance criteria

- Signed installed-version upgrades pass on Windows x64 and macOS x64/arm64, including new-version Host startup and retained data.
- Deployed policy integration passes the API proposal’s guest, force/no-force, error, and platform matrix without local fixtures.
- Release owners record CDN freshness, Range and hash behavior, request and bandwidth budgets, alert thresholds, and an incident owner.
- Product owners decide offline mandatory persistence and target replacement before either behavior is promised.

## Risks

Local updater and UI checks do not prove installed-upgrade compatibility, deployed policy availability, or CDN performance. Enabling mandatory policy before a resolving artifact exists can block users without an in-app upgrade path.
