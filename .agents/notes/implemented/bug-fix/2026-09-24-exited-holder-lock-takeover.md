# Agent Note: Taking over a writer lock whose holder exited

Status: implemented

English | [中文](2026-09-24-exited-holder-lock-takeover.zh.md)

## Problem

`withFileLock` in [dsh-atomic-write](../../../../packages/util/atomic-write/README.md) creates `<file>.lock` with exclusive create and removes it in a `finally`. A process that ends without running that `finally` leaves the lock behind, and every later writer of the file times out until someone deletes it by hand. The [original decision](../../archived/architecture/2026-07-30-settings-write-path-integrity.md) accepted this because file age cannot distinguish a crashed holder from a paused one.

The profile package lock (`<profile>/package.json.lock`) made the cost visible. `dsh plugin` installs no signal handler, so Ctrl-C, SIGTERM, or closing its terminal ends the process while pnpm runs, and the lock stays. `dsh` and `dsh web` exit right after application disposal resolves, while a cancelled installation is still restoring files and has not released the lock. A crash, SIGKILL, or out-of-memory kill has the same effect. After any of these, every plugin operation on that profile fails after `lockWaitMs` (two minutes by default) without saying that the holder is gone.

## Decision

- The lock keeps the `<pid>\n` record earlier releases wrote, so locks left before this change are taken over and processes of both releases interoperate.
- A contender that finds a lock reads its record. When a signal probe of the PID fails with `ESRCH`, the holder is proven gone and the lock is taken over. `EPERM` means the process exists under another user and the lock is kept. A record naming the contender's own process is kept too: that process is running, and the browser Worker's process shim reports its own PID as absent.
- Contenders that read the same record serialize on a claim file, `<file>.lock.takeover-<first 16 hex digits of the record's SHA-256>`, created with `wx`. The claimant re-reads the lock and probes its PID again, removes it only if it still holds that record and the PID is still absent, removes the claim, and retries acquisition at once. The record's holder cannot release it once its PID is absent, another takeover needs the same claim, and a new holder that reused the PID fails the second probe, so a claimant never removes a lock that another contender acquired after the exited holder's.
- A record that is empty, incomplete, not a decimal PID, or names PID 0 or a PID beyond the int32 range the probe accepts is waited for. None of these proves that the holder stopped.
- Takeover proves only that the recorded process exited, not that the processes it started stopped writing. The [Plugin Manager](../../../../packages/boot/plugin-manager/README.md) records each pnpm run in `.plugin-manager/run.json` while the run lasts; an operation that finds that record waits up to five seconds for the recorded run to stop and otherwise refuses to run, naming the process and the record.
- The probe runs on the contender's host. Writers on several hosts sharing one `DSH_HOME` over a network filesystem are unsupported; the `flock` that guards Session files does not reliably exclude them either.

## Alternatives considered

**Remove a lock older than a fixed age.** Age cannot separate a crashed holder from one running a ten-minute pnpm installation, and the plugin manager legitimately holds the lock that long.

**Kernel-released locks.** The kernel releases them when the holder dies, which removes the problem instead of detecting it. The [Session write lease](../../../../packages/session/session-persistence-jsonl/src/lease.ts) already holds one on both platforms: `flock` through `@deepseek-ai/node-addon-system` on POSIX and a named semaphore through `koffi` on Windows. Moving `withFileLock` onto it would give the zero-dependency `dsh-atomic-write` both dependencies, and processes of earlier releases still exclude each other only through `<file>.lock`, so a transition would have to hold both locks. This stays the stronger fix if PID reuse or shared-filesystem deployments turn out to matter.

**Rename the stale lock aside and restore it when the renamed record differs.** Restoring can race a third contender that acquires the empty path in between, which leaves two holders. The claim file prevents that race without restoring anything.

**Record the hostname and a nonce.** A hostname would keep a writer on another host from probing a PID that is not its own, but no supported deployment shares these files across hosts, and macOS changes its hostname when networks change, which would leave locks from before the change in place. A nonce would make each record unique, but the second probe under the claim already rejects a holder that reused the PID.

**Terminate the recorded pnpm run instead of refusing.** Its PID can have been reused by an unrelated process, which a signal would then kill. Refusing leaves that case to the operator, whom the diagnostic names the process and the record.

**Signal handlers in `dsh plugin` only.** This covers one of the paths that leave a lock and leaves crashes, forced exits, and the other lock files behind.

## Testing

| Evidence | Behaviour |
|---|---|
| [atomic-write.spec.ts](../../../../packages/util/atomic-write/tests/atomic-write.spec.ts) | Takeover of an exited holder's record, through an injected probe everywhere and a really exited process on POSIX; eight contenders over one exited holder never overlap; live, own-process, other-user, empty, incomplete, non-PID, process-group, and out-of-range records are waited for; a holder that reused the PID after the claim, an unreadable lock, a claim held by another contender, and a record replaced after the claim are left in place; a lock that cannot be removed is waited for; an `EPERM` claim refusal is retried, another claim failure surfaces, and a claim that cannot be removed does not fail the operation. |
| [operations.spec.ts](../../../../packages/boot/plugin-manager/tests/operations.spec.ts) | CLI, service, and repair runs are recorded while they run and the record is removed afterwards; an active recorded run refuses the operation before pnpm starts; a stopped one's record is removed; a record that names no run refuses the operation. |
| [operations-process.spec.ts](../../../../packages/boot/plugin-manager/tests/operations-process.spec.ts) | A real recorded run that is still writing finishes before the next operation's pnpm starts. |

## Consequences

- Locks left by an exited process, including those written before this change, no longer need an operator; the next writer proceeds without waiting for its deadline.
- A PID that a live process reused after a reboot keeps the lock in place until an operator removes it, as before.
- Processes that share the lock file but not a PID namespace, such as containers over one volume or hosts over a network filesystem, can see a live holder as exited. Such deployments are not supported.
- A contender that crashes while it holds a claim leaves that claim, and the named lock is then not taken over automatically.
- A pnpm run left by an exited operation blocks later operations until it stops or an operator removes its record.
- A holder that is still alive keeps its lock, so this does not bound how long a live operation holds it.
