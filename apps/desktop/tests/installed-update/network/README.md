---
description: "Operator-owned Windows network fault and recovery for one verified installed update test application."
---

# Test-application network fault

English | [中文](README.zh.md)

## Summary

Interrupt only the installed qualification application's outbound traffic, then remove that exact rule before retrying the update. The tools never disable an adapter, VPN, proxy, or firewall profile. Real traffic interruption remains an operator observation; tests substitute all firewall cmdlets.

## Table of Contents

- [Prepare](#prepare)
- [Block and restore](#operate)
- [Evidence and limitations](#evidence)
- [Dev Note](#dev-note)

<a id="prepare"></a>

## Prepare

Complete version 1 package verification and install that version through the [walkthrough](../README.md). Supply the installed executable, not the extracted payload. From the repository root, prepare its plan:

```powershell
node --import tsx apps/desktop/scripts/prepare-installed-update-network.ts "<run.json>" "<installed-test.exe>" "<verification/result.json>"
```

The preparer requires version 1 identity and signature evidence, the exact test filename, and matching executable bytes. It resolves Windows short paths and refuses executables inside the material run. It exclusively writes `network-fault/plan.json` without changing network state. Retain the original plan; it identifies the one removable rule. Installation registration still requires independent operator verification.

<a id="operate"></a>

## Block and restore

These are pending manual steps, not a report of real firewall qualification. Use an administrator terminal and prepare a second terminal with the Restore command before blocking. Each invocation writes a new record. `Status` is the default and does not change firewall state. The execution-policy option affects only this PowerShell process; it does not change system policy.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps/desktop/scripts/installed-update-network.ps1 -Plan "<plan.json>" -Action Status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps/desktop/scripts/installed-update-network.ps1 -Plan "<plan.json>" -Action Block
powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps/desktop/scripts/installed-update-network.ps1 -Plan "<plan.json>" -Action Restore
```

Start Block, leave its confirmation waiting, then start the download. After positive progress, type the displayed `BLOCK <run-id>` confirmation. The script rechecks executable bytes and rule absence before creating one program-specific outbound block. Observe and capture an actual failed download; rule creation alone is insufficient. Run Restore and type `RESTORE <run-id>` to remove the matching rule, then click retry yourself. Status must report the rule absent. Never change unrelated rules to force a failure.

<a id="evidence"></a>

## Evidence and limitations

The script flushes timestamped stages and final success/failure into `network-fault/records/<id>/events.jsonl`. It stops on errors and never retries or silently removes a rule after failed creation. Run Restore explicitly after any uncertain result. Recovery validates the rule's name, ownership description, direction, action, and exact program path; it does not require the executable to still exist. An absent rule is a safe no-op; a foreign matching rule is not removed.

Windows supports [program-specific outbound rules](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/configure-with-command-line). Local policy, existing connections, and a download finishing before confirmation can prevent the intended interruption. A rule in PersistentStore does not prove effective traffic blocking. Keep the application open and observe its failure and subsequent successful retry; if either is absent, record the attempt as incomplete. The rule persists until removed, including across restart. Keep the plan and recovery terminal available; never install the update with the test rule still present.

<a id="dev-note"></a>

## Dev Note

Local plan validation and the actual PowerShell control flow have inert tests. Real rule creation, effective interruption, and recovery require the operator's authorized installed-app run.
