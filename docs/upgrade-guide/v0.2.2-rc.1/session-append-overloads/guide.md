---
kind: upgrade-guide
description: "Code that replaces Session.append must implement both the single-event and array overloads."
---

# Update replacements for `Session.append`

English | [中文](guide.zh.md)

## Change

In v0.2.2-rc.1, `Session.append` had a single call signature. It now accepts either one typed event call or an array of event tuples. Ordinary single-event calls still compile. Test doubles and wrappers assigned to `Session['append']` must support both overloads.

## Migration

1. For a wrapper around `Session.append`, preserve both overloads by wrapping the original function with a `Proxy` and forwarding from its `apply` trap with `Reflect.apply`. For a test double that only accepts one event, type the single-event helper separately and call it from the relevant test.
2. Typecheck assignments to `Session['append']`. Call replacements with both `append('turn/start', { turn: 1 })` and `append([['turn/start', { turn: 1 }]])` and verify the first returns one event and the second an array.
