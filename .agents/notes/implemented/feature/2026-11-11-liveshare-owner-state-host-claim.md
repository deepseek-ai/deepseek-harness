# Agent Note: one host claims the LiveShare owner state

Status: implemented

English | [中文](2026-11-11-liveshare-owner-state-host-claim.zh.md)

## Problem

The LiveShare owner state — the persisted shares, the Relay registrations they hold, and the forks recorded beside them — is addressed by the Host's DSH home, not by the process serving it. A second Host that starts on that home restores the same shares and re-registers them with the Liveshare server, which moves each registration onto the new connection. The earlier Host's authority reads then answer for a registration the server has moved, fence the share, and, with it, stop the owner's own turn. The state needed one named owner per directory that does not depend on every Host agreeing to ignore the others.

## Decision

`claimOwnerHost` (packages/experimental/liveshare/src/host/owner-host-claim.ts) writes `owner-host.json` beside the owner state file and names the process serving it. The holder restores, registers, and changes the shares; every other Host loads the records and publishes nothing. The claim is taken once at mount: a Host that loses it to a successor detects that on its next read, because a share operation re-reads the file instead of trusting the claim it took. A lost claim turns every modifying `liveshareShares` operation into the typed refusal `liveshareShares/owner-state-held`, and leaves reads available, so a non-holding Host still shows the owner what is shared. It imports a credential — its own sign-in — but claims and re-registers nothing.

The rules are the ones the [session write lease](2026-08-31-cross-process-session-write-lease.md) settled: ownership carries no expiry, contention is a typed answer rather than a crash, and a record left by a process that is gone is reclaimed. Three properties differ, because this directory is not session data:

- **The claim is advisory, and it gates Relay registrations rather than file writes.** The state file's own registry locking keeps concurrent writes from dropping durable entries, so the claim protects no share data and no Session log. Its whole purpose is that one process owns the server-side registrations at a time.
- **There is deliberately no deadline.** A deadline exists to expropriate a stalled holder, and a wedged Host here keeps only its own registrations; a takeover would register the shares from a second connection while the stalled holder still believes it owns them. A holder that stops serving therefore keeps the state until its process exits.
- **A record naming this process is reclaimed.** Every Host in one process shares the same owner state, so a second mount inside one process must not find itself fenced out by its own pid.

The record is published as one whole file: it is written under a temporary name and then hard-linked to the claim path, so the link publishes the record it names or fails because a claim is there, and no reader ever sees a half-written claim. Taking the claim against a live holder throws `OwnerHostClaimHeldError`; the Host reports that holder's pid and continues without the state rather than failing to start. Teardown releases the claim last, after the tunnel and worker registrations have stopped, so a successor cannot start registering the same shares while the holder is still withdrawing them.

## Alternatives considered

**A lease with an expiry, renewal, and takeover** — the shape a distributed lock usually takes, and the one this repository's Session writes replaced with a kernel lock. Renewal traffic and a takeover race would buy nothing here: no write is torn by a second owner, and the only cost of a stalled holder is that its own shares serve until the process exits.

**Doing nothing and letting every Host serve the shares** — the defect itself: whichever Host registers last wins the registration, and the other fences the share and stops the owner's turn, so two running Hosts make the owner's own Session stop without anyone asking for it.

**A kernel lock held for the life of the process** — the Session write lease's own mechanism, which recovers on crash with no record at all. It cannot express "this Host lost the state to a successor" to a Host that must keep running and serving reads, and it would report contention by failing acquisition rather than by naming a pid the owner can act on. The record is also what a later Host reads to say which process to stop.

**Refusing to start beside a live holder** — a second Host is a legitimate way to look at what this machine shares, and failing its mount would take the rest of that DSH home's startup down with the claim.

## Consequences

Two Hosts on one DSH home now have one authoritative server registration each share, and the non-holding Host answers a modifying operation with a refusal that names the holder rather than silently diverging. The holder's death frees the state at the next Host start; until then the state is unreachable, which is the deliberate cost of not expropriating a stalled holder. Pid reuse can name the claim's holder wrongly: the next Host then runs without the shares until that unrelated process exits or the record is removed, and nothing is lost when it recovers. The claim compares nothing outside this DSH home, so it remains an advisory guard for one user's state directory, not a multi-host authorization service — nothing stops a Host pointed at another home from registering the same shares with the server.
