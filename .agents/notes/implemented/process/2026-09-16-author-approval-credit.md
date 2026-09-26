# Agent Note: Author approval credit

Status: implemented

English | [中文](2026-09-16-author-approval-credit.zh.md)

## Problem

The approval policy needs author experience to contribute enough points for an established author and one ordinary reviewer to meet the two-point requirement.

## Decision

The [approval policy](../../../../.github/review-ownership/README.md) awards 0.011 points per merged PR in this repository, capped at 1.1 points after 100 PRs. History lookup stops at 100 matching PRs. Author credit alone remains insufficient, and blocking reviews still prevent approval.

## Alternatives considered

**Keep the 0.6-point cap at 150 PRs.** That cap cannot combine with an ordinary one-point review to meet the requirement without an ownership boost.

## Consequences

One ordinary approval with no ownership boost meets the requirement at 91 merged PRs; 90 yields only 1.99 points. The lower counting cap limits required history traversal for prolific authors. Merged PR count measures contribution history rather than review quality.

## Verification

Policy tests cover credit below, at, and above the cap; the 90/91-PR approval threshold; author-only rejection; pagination; and below-threshold scores whose display rounds to two.
