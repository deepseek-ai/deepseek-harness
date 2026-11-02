---
kind: upgrade-guide
description: "CUA relative coordinates accept integers from 0 to 999 and reject the former endpoint 1000."
---

# CUA relative coordinates use 0–999

English | [中文](guide.zh.md)

## Change

The `cua` tool and application/window object methods now accept integers from 0 to 999 when `relative: true`. The previous range was 0 to 1000. Coordinates still use thousandths: divide by 1000, scale to window dimensions, and clamp inside the window. Values from 0 to 999 keep their existing positions. This affects `click`, `hover`, `scroll`, and both `drag` endpoints. Absolute screenshot pixels and AX element indices are unchanged.

## Migration

1. Update scripts and prompts that generate relative coordinates. Keep existing values from 0 to 999 unchanged. Replace the old endpoint 1000 with 999, for example with `Math.min(oldValue, 999)` for valid old coordinates. On larger windows, 999 can land farther inside than the former endpoint 1000.
2. Read fresh window state, then invoke the affected action with integer coordinates in 0–999. Verify the result with a fresh observation. Relative values of 1000, negative values, and fractions are rejected before native input.
