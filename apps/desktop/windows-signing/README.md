---
description: "Configure and operate the Windows packaging runner, signing credentials, EV token and signature cache. Read the accepted isolation risks before running branch code or accessing the token. Hardware failures require operator inspection; packaging success does not establish installation or production readiness."
---

# Windows signing and runner operations

English | [中文](README.zh.md)

## Summary

Configure and operate the Windows packaging runner, signing credentials, EV token and signature cache. Read the accepted isolation risks before running branch code or accessing the token. Hardware failures require operator inspection; packaging success does not establish installation or production readiness.

## Table of Contents

- [Trust and isolation limits](#trust-and-isolation)
- [Machine setup and runner startup](#machine-setup)
- [Signing configuration](#signing-configuration)
- [Signing and timestamp completion](#windows-ev-signing)
- [Failure records and operator recovery](#failure-and-recovery)
- [Signature cache and concurrent stages](#signature-cache)
- [Verification limits](#verification)

<a id="trust-and-isolation"></a>

## Trust and isolation limits

The shared packaging runner assumes trusted internal-team code and operators. Under this assumption, credential and device isolation are deferred and the residual risk is accepted (tracked in #5973); signed/master-only access is not enforced. Unsigned mode skips signing-file loading but cannot prevent branch code running as the same Windows account from reading those files or accessing the token. SafeNet Single Logon may reuse authentication. Direct device calls can bypass the signing scripts and exhaust PIN retries; the persistent failure interlock only protects calls through those scripts. Cross-account token isolation and remaining retry counts are unverified. Reassess runner/account/device isolation before expanding access, executing untrusted contributions, changing runner sharing, or after suspicious activity.

<a id="machine-setup"></a>

## Machine setup and runner startup

Use a runner-owned checkout and keep configuration, certificates and caches outside it. Registration and tool installation remain operator tasks. Packaging inputs and artifact retrieval are described in the [packaging guide](../packaging/README.md#windows-actions).

Run `pwsh -NoProfile -File apps/desktop/scripts/setup-windows-packaging.ps1 -Root <absolute-machine-root>` to prepare private `packaging/{presets,secrets,certificates}` and `cache/windows-signatures` directories and copy templates without overwriting existing files. Add `-CheckOnly` to inspect without writes. Fill the [preset templates](../config/windows-packaging/test.env.example) and [signing template](../config/windows-packaging/windows-signing.env.example) on the machine. Run `start-windows-packaging-runner.ps1 -RunnerRoot <registered-runner-directory> -ConfigRoot <machine-root>/packaging -CheckOnly` from the same scripts directory to inspect PowerShell 7.6.6 under the runner's `tools` directory, Node, Python, Git, tar and Visual C++ tools; packaging `--check` performs the remaining toolchain validation. Omit `-CheckOnly` to start the existing runner with an explicit config root and scrubbed inherited environment. Registration and tool installation are separate; these scripts never create tokens, alter system security settings or clear signing failure records. Use the signing cache maintenance command below to migrate existing entries before changing the preset's cache path.

### Supervised startup

Run `pwsh -NoProfile -File apps/desktop/scripts/windows-runner-task.ps1 -Action install -RunnerRoot <registered-runner-directory> -ConfigRoot <machine-root>/packaging` as the runner's Windows user, using its installed PowerShell 7. The installer checks the environment and copies startup scripts into `runner/dsh-task`; registration, tools and secrets remain separate. It registers a disabled, limited-permission interactive Task Scheduler task without storing an account password. For `-Action start` or `-Action status`, pass only `-RunnerRoot`; configuration and retry options apply only to installation. The task starts after this user's desktop login, including after reboot, and stops on logout. It does not provide unattended boot or unlock a signing Token.

The task permits one instance and has no execution time limit. A repeating trigger checks every `-RestartMinutes` minutes (default `1`) and restarts an exited launcher, including an unexpected zero exit. The persisted budget permits the initial launch plus `-RestartCount` restarts (default `10`) between explicit starts. Every desktop login also consumes this budget; `status` shows the remaining launches. After the budget is exhausted, login alone cannot restart the runner. Starting an already running task does not reset the budget. Missing or invalid budget/configuration files disable automatic starts until repaired. GitHub's launcher owns runner updates; task recovery does not rerun a failed workflow or clear signing interlocks. After retries are exhausted, inspect `runner/dsh-task/run-*.log`, the runner's `_diag` logs and `status`, correct the cause, then run `start`. A running task alone does not prove connectivity: verify `Connected to GitHub` and `Listening for Jobs`, then verify assignment in Actions. Logs are retained for operator-managed cleanup.

Before maintenance, pause new workflow dispatch and wait for the runner to become idle. `-Action stop` refuses an active worker for this runner, disables future starts and stops its task process tree; the local check cannot prevent a concurrent GitHub assignment. `-Action uninstall` requires a stopped, disabled task and retains registration, configuration and logs. To update installed scripts, stop, uninstall and install again. When migrating a manually launched runner, stop its existing launcher only after it is idle, then start the task; never run both launchers together.

Operators can run `pwsh -NoProfile -File apps/desktop/tests/windows-runner-task.ps1` on Windows to exercise installation, automatic recovery, duplicate-start prevention, stop, child-process teardown and uninstall against an isolated fake runner. This opt-in test creates a temporary task and retains diagnostic files; it does not contact GitHub or access signing hardware. Real-machine acceptance additionally checks an idle runner coming online, an Actions job being assigned, and login after an operator-approved reboot. Signed packaging and logout/reboot acceptance require separate operator verification.

<a id="signing-configuration"></a>

## Signing configuration

The [machine preset configuration](../packaging/README.md#configuration-and-local-builds) selects public settings and the signing file. Without a preset, use the target dotenv file.

Fill in `.env.windows` with `DSH_DESKTOP_WINDOWS_CER_FILE` (public EV leaf certificate), `DSH_DESKTOP_WINDOWS_SIGNTOOL` (SafeNet-compatible SignTool), `DSH_DESKTOP_WINDOWS_KEY_CONTAINER` (matching private-key container), and `DSH_DESKTOP_WINDOWS_TOKEN_PIN` (Token Password). The private key stays on the USB token; keep the certificate and local credential file out of Git.

The PIN cannot contain `]`, a quote, or a line break because those characters delimit the SafeNet `/kc` value or its CMD argument. The CMD disables delayed expansion so a PIN containing `!` reaches SafeNet unchanged. Packaging withholds every `DSH_DESKTOP_WINDOWS_*` field from build and runtime-preparation subprocesses, gives signing preflight, the dedicated runtime signing stages and electron-builder only the four configured inputs, gives the signing CMD only the validated signing fields in an otherwise scrubbed environment, clears those fields before SignTool starts, and redacts SignTool diagnostics. SafeNet still requires the PIN in the SignTool process command line. The local `.env.windows` or machine-owned `secrets/windows-signing.env` stores the PIN in plaintext and needs restricted file access. CI reads the machine-owned file outside the checkout and retains it across jobs. Do not commit or share its contents or print credentials in logs. Configuration checks consume no token PIN attempts; signing still stops the batch on its first failure.

Signed Windows configuration derives the updater's `publisherName` from the same public certificate's `CN`, `O`, and `C` attributes. Each must be present, nonempty, and single-valued. These identity attributes allow certificate renewal without pinning a leaf thumbprint. The installed application's `app-update.yml` carries the expected publisher; the downloaded feed does not choose it. Unsigned test builds omit updater configuration. See the [signature qualification record](../tests/README.md) for real-file verification and its limits.

<a id="windows-ev-signing"></a>

## Signing and timestamp completion

Follow the [version and build instructions](../packaging/README.md#release-versions) before starting a signed build. Configuration checks do not establish token authentication.

Signed Windows builds run a supervised signing preflight before compilation or dependency preparation. Static configuration, certificate validity, audit storage, compiler availability and any retained signing interlock are checked without token access. The local .NET Framework C# compiler creates a small private probe; the production signer signs it once, and verification requires the configured certificate and a timestamp before building continues. The probe is never executed. The overall 60-second preflight deadline includes timestamp attempts; deadline expiry, hardware signing errors and verification failures stop the run without another hardware attempt. Success proves the current signing path works, not that the PIN was independently authenticated: SafeNet may reuse login state. Do not log out or repeat authentication to test the PIN. `--check`, preparation-only and `--unsigned` modes do not run this hardware preflight; unsigned artifacts remain ineligible for release upload. Automated regression tests use a fake signer; release operators qualify real hardware separately.

Insert and unlock the token before packaging. The electron-builder hook passes each artifact to the CRLF `scripts/windows-sign.cmd`, which invokes the configured SignTool once with `/f`, SafeNet `/kc "[{{PIN}}]=container"`, `/csp "eToken Base Cryptographic Provider"`, a SHA-256 file digest, without a timestamp. The hook then completes a DigiCert SHA-256 RFC 3161 timestamp on isolated copies without signing credentials. The hook never substitutes electron-builder's bundled SignTool and never retries a failed signing request. Windows release packaging fails instead of emitting unsigned artifacts when the SignTool, certificate, container, PIN, token, or signature is unavailable.

Timestamp completion retries only a normally exited timestamp command returning failure or warning, at most three times with one- and two-second delays. Each attempt starts from the same verified primary signature. Launch errors, uncertain termination and verification failures stop immediately. SignTool operates on short private paths; publication copies verified bytes to the target volume before atomic replacement. Final Windows trust, certificate, timestamp and normalized full-file equality are required. Exhaustion stops packaging and preserves evidence without another hardware call. See the [signature completion decision](../../../.agents/notes/implemented/process/2026-09-17-windows-signature-completion.md).

<a id="failure-and-recovery"></a>

## Failure records and operator recovery

Treat `SignTool Error: No private key is available.` as a signing failure: stop all signing attempts and have the operator inspect the signing configuration and token state before continuing. The device-specific PIN retry limit and remaining attempts are unverified; do not probe them with authentication attempts. Do not retry packaging or signing probes after this error. The signer serializes token operations and rejects all queued tasks after the first failure.

Windows package commands print `DESKTOP_PACKAGING_RECORD` with a unique directory under `.desktop-build/packaging-runs/`. Each run retains `run.json`, timestamped `events.jsonl`, redacted `stdout.log` and `stderr.log`, and `result.json`. A signing failure also writes `fatal.json` and notifies the parent through stderr; the supervisor immediately requests termination of its stage process tree and waits for exit. Failed stages cannot start subsequent stages or create a release completion record. Journal failures also stop the run. Termination errors remain failures and require operator inspection; a missing final record means completion was not established.

Hardware signing requires a supervised run. Before invoking the command interpreter, the signer atomically acquires `%USERPROFILE%/.dsh-desktop-signing/attempt.json` and records the attempt. Only successful signing followed by verification of the configured primary signature releases that file; timestamps are completed afterward without hardware access. Failure, interruption, an existing interlock, or unavailable audit storage prevents further hardware access, including from another signer instance, process, or checkout under the same Windows account. There is no timed recovery or automatic retry. An administrator must inspect the retained evidence and token state before explicitly authorizing interlock recovery; logging into the token or replacing a PIN file does not clear it. The records distinguish signing intent, command-interpreter PID, and completion; they do not measure internal CSP/token authentication attempts. Command arguments, PINs, and credential environments are not recorded. Independent Windows accounts and unrelated signing programs are outside this interlock.

<a id="signature-cache"></a>

## Signature cache and concurrent stages

Runtime signing shares complete signed files across the current Windows account's worktrees. `DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_DIR` in `.env.windows` selects an absolute fixed-drive directory; the default is `%USERPROFILE%\.dsh-desktop-signing\signature-cache\v1`. Cache directories must belong to the current account and exclude other ordinary accounts from their access permissions; linked paths are rejected. Entries identify the original bytes, public certificate and signing toolchain. Every restoration checks the digest, Windows trust, timestamp and certificate before replacing the unsigned file; invalid entries stop packaging without hardware fallback. Cache age alone does not trigger signing. The cache trusts programs running as the same account and does not defend against administrators. The [runtime signature cache decision](../../../.agents/notes/implemented/process/2026-09-17-windows-runtime-signature-cache.md) owns qualification and design limits.

Preflight, primary-runtime signing, application-runtime signing and artifact creation each hold the account's signing-stage lock until their supervised child processes settle. Other builds wait before entering those stages; compilation and preparation do not hold the lock. Runtime signing workers own their locks, so terminating only the outer packaging process does not unlock a surviving cache user. Migration and maintenance acquire the same lock; older or external signing commands do not participate and must be scheduled separately. Stage waiting is outside the preflight deadline. Closing the stage handle releases ordinary contention without removing the separate hardware-attempt interlock; a retained hardware failure still requires operator recovery.

Cache-hit copying, hashing and per-file trust checks run with `DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY` workers from `.env.windows` (default `4`, integer `1`–`8`). All restores and their post-verification finish before cache misses enter serial hardware signing. A restore or verification failure stops new dispatch and drains active work before releasing the stage lock; hardware signing, runtime smoke checks and final integrity validation remain required.

Each runtime stage writes `SIGNATURE_CACHE_SUMMARY` to stdout and its packaging journal, including the actual directory, policy identity, hit/miss counts, newly published and retained entries, signing requests, avoided signing requests and validation failures. Timings distinguish signing, trust verification of restored and newly signed files, and restoration; restoration includes its trust check and staging cleanup. These counters exclude preflight, final artifact signing and the outer runtime signature checks. Stage lock events record waiting separately. Concurrent timings sum per-file work rather than stage wall time.

Use `pnpm --dir apps/desktop run cache:windows-signatures --usage` to inspect structurally complete-entry bytes and counts, or `--from <absolute-old-cache>` to import an explicitly selected cache owned by the same account. Migration leaves the source unchanged, skips staging names, rejects corrupt entries and retains valid existing entries even when their timestamp bytes differ. `--clear` explicitly removes complete entries under the stage lock; no automatic capacity eviction runs. `--directory <absolute-cache>` selects a maintenance destination without loading release credentials. Incomplete staging entries remain untouched and are counted separately; inspect them only after all builds have stopped. These commands never clear hardware failure evidence. Default storage is outside AppData so MSIX launcher virtualization does not split the account's cache; redirected overrides fail explicitly.

<a id="verification"></a>

## Verification limits

Real hardware and installation evidence is owned by the [Desktop qualification record](../tests/README.md) and [installed-update procedure](../tests/installed-update/README.md). This document does not authorize PIN retries, automatic interlock deletion, device initialization or changes to the accepted isolation policy.

## Dev Note

None.
