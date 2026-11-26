# Agent Note: Environment transports own execution processes

Status: implemented

English | [中文](2026-11-23-environment-transport-process-ownership.zh.md)

## Problem

The environment protocol sends self-contained functions and origin callbacks over a byte channel. Starting, stopping and retaining a process depend on the transport. A common resident Unix listener adds socket naming, permissions, startup locking and worker replacement even when a provider only needs one process for one channel. No function state survives between connections, and sent runs cannot resume or replay.

## Decision

Transports own execution-process startup, shutdown and any persistence mechanism. The registry owns registrations, the function protocol and one cached connection per registration. SSH and local transports start a fresh `daemon.js serve --stdio` process for each new connection; reusing a live channel keeps that process. The daemon serves one connection using Node standard-library APIs. It has no resident listener, socket bridge or remote process supervisor.

This decision partially supersedes the [original environment note](2026-11-04-environment.md): its resident-process and socket-trust decisions are historical; its function I/O, origin callbacks and single-runtime rationale remain active. The original note remains active and cross-linked.

## Alternatives considered

- **A common resident Unix listener.** The original design preserved a process across disconnections, used a lock for exclusive startup, and replaced each connection's worker so a lingering connection or blocked function could not prevent a new connection. It also required socket permissions and a trusted directory. Without resumable runs or retained function state, these mechanisms do not justify common protocol ownership. A provider with a concrete persistence or supervision requirement may implement its own listener.
- **One stdio daemon per connection.** The original note rejected this because disconnection ends the process and each transport needs a launch path. Those properties match transport ownership: the shipped providers already start their execution channel, and the registry never resumes a sent run.
- **A shared listener that refuses a second host.** The original rejection remains relevant to providers choosing shared listeners: a lingering or blocked connection can deny reconnection. Independent execution processes avoid a shared admission decision.
- **A universal remote supervisor.** The original resident requirement excluded the `dsh-ssh` helper because its connection- or lease-scoped cleanup ended managed processes. Removing residency removes that conflict, but does not require a shared helper or supervisor. Each provider owns any stronger termination guarantee.
- **Application keys for authenticated stdio channels.** Channel access already permits execution as the daemon user. SSH authentication and provider-owned local pipes establish the shipped trust scope. Any network provider must authenticate its channel; the protocol's `auth` exchange remains extensible.

## Consequences

- The common daemon needs no socket namespace, filesystem socket permissions, startup lock, idle listener or worker replacement. Independent connections do not replace one another's processes.
- Without a resident listener, the daemon stops blocked execution itself: it runs functions in worker threads and terminates the worker of a cancelled run that does not stop, as the [original note](2026-11-04-environment.md) describes. Closing SSH ends remote code only once the daemon observes its closed input. Stronger remote supervision belongs to a provider that supplies it.
- Callers trust the provider, daemon files and execution machine. `node:vm` separates globals; it is not a sandbox. Filesystem and process operations use the execution process's permissions.
- Disconnection rejects in-flight runs with unknown outcomes, without replay or rollback. A later connection starts a new process; it does not recover execution state.
