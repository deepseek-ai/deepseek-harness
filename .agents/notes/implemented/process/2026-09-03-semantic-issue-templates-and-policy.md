# Agent Note: Semantic Issue templates and presentation-neutral policy

Status: implemented

English | [中文](2026-09-03-semantic-issue-templates-and-policy.zh.md)

## Problem

Issue and pull-request templates mixed intake questions with review evidence and hid their complete contents in `details` elements. Unused frontmatter and separate Idea and Research templates added choices without changing how the repository planned the work.

Issue policy also treated Markdown presentation as repository metadata. Requirements for `details` elements, a 50-unit visible body, Chinese titles, title metadata prefixes, and an `Owner:` body line produced failures without identifying a missing semantic decision.

## Decision

Issue templates cover Bug, Feature, and Task. Bug asks for a summary, reproduction, current behavior, expected behavior, and environment. Feature asks for motivation and behavior. Task asks for a summary and deliverables. Idea and Research belong in Task unless a future decision gives them distinct lifecycle behavior.

Issue-template frontmatter contains only `name`, `about`, and `type`. Markdown headings define the hierarchy, and HTML comments explain what belongs under each heading.

The pull-request template contains `Motivation`; a `Changes` section with adjacent placeholders for public-interface and behavior changes; and `Testing` entries that show each method directly and place its proof in a local `details` element.

Issue policy does not inspect `details` presentation, visible-body length, title language, title prefixes, or body ownership lines. Every other policy check, warning, lifecycle operation, workflow trigger, and pull-request enforcement exemption retains its existing behavior. This decision adds no metadata repair, Issue classification, data migration, or workflow capability.

## Verification

[Issue-management tests](../../../../.github/issue-management/policy.test.mjs) pin the template inventory and headings, the pull-request testing structure, and acceptance of titles, bodies, and assignee states that differ only in presentation.

## Alternatives considered

**Keep Idea and Research templates.** Their forms did not establish lifecycle or policy behavior distinct from Task, so separate entry points increased choice without preserving a meaningful type distinction.

**Keep presentation rules as warnings.** These rules could fail otherwise actionable Issues and could not establish whether the requested work, expected behavior, or deliverables were clear.

**Add automatic metadata repair or Issue classification.** Those behaviors require new mutation rules, permissions, failure handling, and operational evidence. They remain separate decisions rather than accompanying a policy simplification.

## Consequences

Contributors see shorter forms whose headings match the information needed at Issue intake and pull-request review. Policy failures remain focused on the existing semantic metadata checks.

The policy does not rewrite legacy labels, choose missing Issue Types, synchronize Priority, or migrate existing repository data. Any future automation for those operations needs its own decision and review scope.
