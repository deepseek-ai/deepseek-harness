# Agent Note: Web preview product badge

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-05-web-preview-product-badge.zh.md)

## Problem

The Web empty state does not identify the product as a preview. Users can enter the main session surface without seeing that the product is pre-release, while a deployment setting would misrepresent a product-wide lifecycle decision as an operator choice.

## Decision

The empty hero always renders a localized `Preview` / `预览版` badge beneath the headline. It has no configuration switch: preview status is one product identity shared by every deployment, not a deployment-varying tunable.

The badge keeps the business-tertiary background so both themes retain the product-blue context, and uses the theme's primary label token for text. That pairing gives ordinary 12px text sufficient contrast in both light and dark themes; the business-primary foreground is reserved for larger or non-text accents because it does not reach the required contrast on this background.

The badge leaves the product when the first tagged release removes the repository's pre-release stance, or when the owning product decision declares the preview phase complete. That change removes the badge and its locale key together rather than adding a runtime toggle.

## Alternatives considered

**Make preview status configurable.** Rejected because two deployments of the same pre-release product must not present different lifecycle identities, and a configuration field would turn product release state into an unsupported operator choice.

**Use business-primary text on the business-tertiary background.** Rejected because the resulting light- and dark-theme contrast is below the 4.5:1 requirement for the badge's 12px text.

**Hide the badge from the accessibility tree.** Rejected because preview status is product information rather than decoration; the accessible headline therefore includes the badge text.

## Consequences

Every new session exposes the same localized preview identity in visual and accessibility output. Removing preview status is an explicit product-release edit, and the badge favors readable neutral text over an all-blue treatment while retaining the business-tinted background.

## Testing

The conversation component test covers both localized badge values, and the Web lifecycle snapshots pin the English badge in the assembled empty hero.
