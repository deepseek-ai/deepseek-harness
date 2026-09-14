# Agent Note: Issue policy module ownership

Status: implemented

English | [中文](2026-09-07-issue-policy-module-ownership.zh.md)

## Problem

Issue validation and Project lifecycle processing use the same reference parser, metadata rules, and GitHub reads, but they make different decisions and perform different writes. Keeping those responsibilities in the command entry makes it harder to reuse policy rules without also depending on event dispatch and output handling.

## Decision

Issue management separates pure decisions, GitHub access, pull-request evaluation, lifecycle mutations, and command dispatch into owner modules. [The owner reference](../../../../.github/issue-management/README.md#module-ownership) maps those responsibilities to source files. Callers and tests import the module that owns the operation rather than using the command entry as an export collection.

The separation preserves policy results, diagnostics, credentials, API requests, lifecycle mutations, and workflow entry commands. [Selective evaluation](2026-09-07-selective-issue-policy-evaluation.md) remains the independent owner of eligibility, Project-read selection, and event scheduling; this decision does not redefine those behaviors.

## Alternatives considered

**Keep one command module.** A single file avoids imports between local owners, but ties reusable decisions and GitHub access to command handling. Separate owners let PR validation and lifecycle processing share their existing rules and reads without sharing command dispatch.

## Consequences

Maintainers can locate a rule, network operation, or event handler by responsibility. Reuse occurs through ordinary local ESM imports, not a new package or plugin API. The added modules introduce imports that must stay coordinated when a shared function changes.

Module separation does not grant stronger credentials, change check authority, serialize Project mutations, or prevent a future behavior regression. Existing lifecycle races and field-management limitations remain documented by their behavior owners.

## Verification

[Policy tests](../../../../.github/issue-management/policy.test.mjs) exercise the owner modules and check observable policy and lifecycle behavior. [Workflow tests](../../../../scripts/ci-workflow.spec.ts) cover the command wiring and workflow declarations. Their evidence concerns the checked implementation, not a guarantee that later edits preserve behavior.
