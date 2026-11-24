---
kind: upgrade-guide
description: "forgePanel.reviewLists takes the repository's host, and ForgeReviewHost gains the required signIn."
---

# The review page's lists name a repository's host and a host's sign-in command

English | [中文](guide.zh.md)

## Change

The `forgePanel.reviewLists` Remote took `{ owner, name } | null` as its repository and read that repository on every host. It now takes `ForgeReviewRepository | null`, which adds the required `host`, and reads the repository on that host only. `owner` holds the whole namespace of a GitLab project, nested groups included.

`ForgeReviewHost`, one host's entry in each `ForgeReviewFrame` the Remote streams, gains the required `signIn: string | null`: the command that signs the provider's CLI in to the host while its latest read failed for lack of sign-in, and null otherwise.

This affects code outside `@deepseek-ai/dsh-experimental-client-ui-forge` that calls `forgePanel.reviewLists` with a repository or builds `ForgeReviewHost` values, such as fixtures of the review page's frames. Both types come from that package. Code that only reads frames is unaffected.

## Migration

1. In every `forgePanel.reviewLists` call that passes a repository, add `host`: the host name of the provider that lists it, such as `github.com`, as `ForgeReviewHost.host` of a frame names it. Keep passing `null` for every repository on every host.
2. In every `ForgeReviewHost` your code builds, add `signIn: null`, or the sign-in command when the value stands for a host that is not signed in.
3. Run your type check; it passes once every call and value has the new members.
