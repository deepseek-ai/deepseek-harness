# Agent Note: Windows sandbox process primitives have one low-level owner

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-19-shared-win32-process-primitives.zh.md)

## Problem

The Windows ACL sandbox owns restricted-token, SID, DACL, grant, and workspace policy, but its process launch path also carried the generic Koffi ABI, command-line quoting, anonymous pipes, inherited stdio, Job setup, waits, and HANDLE cleanup. A second Windows process consumer would otherwise have to depend on sandbox policy or copy native resource logic, while fixes to allocation and failure cleanup would need to remain synchronized.

## Decision

`@deepseek-ai/dsh-win32-process` owns the reusable Win32 process ABI and native resource operations currently consumed by `sandbox-windows-acl`. The package lazily loads `kernel32.dll` and `advapi32.dll`, verifies the x64 `STARTUPINFOW` and `PROCESS_INFORMATION` layouts, quotes argv for `CreateProcessAsUserW`, and exposes checked restricted-token pipe and inherited-stdio Job operations.

The Windows ACL sandbox remains the only owner of restricted-token creation, SID and DACL policy, grants, writable-path decisions, temporary-directory policy, and the public sandbox child result. It extends the shared binding context with policy-specific APIs, supplies the primary token, combines pipe drains and waits, and closes the caller-owned Job at its lifecycle boundary.

Every native allocation and HANDLE has one owner within each shared operation. A process operation frees its Koffi out-parameters and closes every pipe, thread, process, or Job handle it acquired before a controlled failure. Successful pipe creation returns the process plus stdout/stderr read handles to the sandbox. Inherited-stdio creation starts the target suspended, assigns it to the kill-on-close Job, and resumes it only after assignment, so target code cannot run outside the Job. Assignment failure terminates the suspended target before releasing its handles; resume failure closes the assigned Job. The sandbox retains its existing pipe-drain, direct-wait, result, and returned-Job lifecycle.

The package exports only operations used by the sandbox production path. Ordinary `CreateProcessW`, exact `applicationName`, parent-stdio release, and whole-Job settlement remain absent until an ordinary process consumer needs them. The package is a library, not a Cordis service or a public Windows SDK.

## Verification

The shared suite covers x64 ABI values, command-line quoting, binding extension, pipe EOF and drain allocation reuse, restricted-token process creation, suspended creation followed by Job assignment and resume, wait and exit-code reads, native allocation release, and the acquired-resource failure paths. Sandbox tests retain restricted-token, fail-closed, pipe/inherit, result, and disposal composition without duplicating the low-level matrix. The committed header probes and Windows package tests cover the migrated ABI and native paths; Wine supplies the emulated Windows package and composition signal.

## Alternatives considered

**Keep process primitives inside the sandbox package.** Rejected because a process consumer would inherit ACL/token policy or duplicate the native ABI and cleanup paths.

**Copy the Koffi implementation into each consumer.** Rejected because struct layouts, error capture, and partial-failure cleanup would have multiple owners.

**Publish ordinary-runner operations before a current consumer exists.** Rejected because unused `CreateProcessW`, application-name, parent-stdio, and Job-settlement APIs would freeze speculative obligations and enlarge the failure matrix.

## Consequences

The sandbox keeps its public behavior while generic Win32 resource ownership has one package and one test home. The package boundary adds one workspace dependency and a published library, and callers must explicitly own policy, scheduling, result composition, and returned HANDLE closure. Suspended creation guarantees that target code starts only after Job assignment, but it does not make the runner's create-to-assignment interval atomic against external termination. Future process consumers extend the low-level package only when their production path exists.
