---
kind: upgrade-guide
description: "ForgeProvider must list its hosts and name itself, ForgeReadiness carries a sign-in command, and ForgeReviewData lists the review decisions the reader may submit."
---

# Forge providers declare hosts, names, sign-in, and review decisions

English | [中文](guide.zh.md)

## Change

`ForgeProvider` gains three required members: `hosts`, the lowercase host names the provider serves; `label`, the product name readers know those hosts by, such as `GitHub`; and `changeRequestNoun`, `'pull-request'` or `'merge-request'`. `ctx.forge.register` now throws when a provider lists a host, compared without case, that an already registered provider lists. `ctx.forge.describe(forge)` returns the `ForgeDescription` the panel uses to name the code host in its copy.

`ForgeReadiness` gains the required `signIn: { command } | null`. The forge panel shows that command in its sign-in banner instead of building `gh auth login` for the `github` family itself.

`ForgeReviewData` gains the required `reviewEvents`, the decisions the host lets the signed-in user record in a submitted review. The review dialog offers only these, replacing its own rule that the author of a pull request may only comment.

This affects third-party providers and code that builds these values. All types come from `@deepseek-ai/dsh-experimental-forge`. The GitHub provider sets `hosts` from its `hosts` setting, `label: 'GitHub'`, `changeRequestNoun: 'pull-request'`, `signIn` while `gh` is not signed in, and `['comment']` for the author of a pull request.

## Migration

1. Add `hosts`, `label`, and `changeRequestNoun` to each `ForgeProvider`. List every host whose remotes or change request URLs the provider maps, and make sure no other loaded provider lists one of them.
2. Return `signIn: null`, or `{ command }` with the shell command that signs the user in, from every `readiness` result.
3. Return `reviewEvents` from `readReview`: the decisions the signed-in user may submit, or `[]` when `viewerCanReview` is false.
4. Run your type check, then start a profile that loads your provider; it succeeds when the type check passes and `ctx.forge.register` does not throw.
