# Agent Note: the code-runtime seam owns portable-identifier exclusions

Status: implemented

English | [中文](2026-07-31-code-runtime-portable-identifier-seam.zh.md)

## Problem

The code-runtime seam promises that a binding-namespace list valid on one backend is valid on every backend, so a PTC mode consumer can hand the same bindings to any registered runtime without knowing its language. The first backend, `dsh-code-runtime-worker-thread`, privately owned the identifier rules that enforce part of that promise: an `IDENTIFIER` regex that allowed the JS-only `$`, a `RESERVED_WORDS` set holding only ECMAScript keywords, and a `RESERVED_ERROR_PROPERTIES` set of three JS `Error` slots. Those rules described the worker's own language, not the seam's portability contract.

A second backend written against a different language (CPython) would either re-declare its own rules — letting `lambda` pass the worker and fail Python, or `$tools` pass the worker and fail every non-JS backend — or import the worker's, inverting the dependency so a Service Provider reached into a sibling Service Provider. Neither keeps the portability promise real: it would hold only for the backend a caller happened to test against.

## Decision

The Service Definition package (`@deepseek-ai/dsh-code-runtime`) exports the portable-identifier exclusion contract as four named constants, and every Service Provider imports them rather than re-declaring:

- `PORTABLE_RESERVED_WORDS` — the union of ECMAScript and Python reserved words. A namespace global or error-class name matching any is refused on all backends, so `lambda` is refused even though it is a legal JS parameter name. Adding a language widens this union, which is a deliberate breaking review of existing binding names.
- `RESERVED_BINDING_GLOBALS` — globals some backend owns in the program's namespace: `console` (the worker's log capture), `__dsh_main__`/`__builtins__`/`__name__` (the Python bootstrap's wrapper and seeded module globals), and `__debug__` (not a seeded slot but a CPython compile-time constant that rejects assignment, so an injected global under that name is unreachable — the same portability split by a different mechanism). Refused everywhere so a namespace list cannot pick a name that works on one backend and collides on another.
- `RESERVED_ERROR_MEMBERS` — error-member names every backend refuses: the JS `Error` slots (`name`, `message`, `stack`) and Python's exception-protocol members (`args`, `with_traceback`, `add_note`).
- `DUNDER_MEMBER` — the dunder-form regex (`__x__`, non-empty middle), refused as an error member wholesale because several are constrained CPython descriptors whose exact set is an interpreter-version detail.

The Service Definition also narrows the portable identifier subset to `[A-Za-z_][A-Za-z0-9_]*` (documented on `CodeBindingNamespace.global` and `CodeBindingErrorClass`), dropping the JS-only `$`. The worker consumes the shared constants directly under their exported names — `PORTABLE_RESERVED_WORDS` for both binding-global and error-class names, `RESERVED_BINDING_GLOBALS` for backend-owned slots, `RESERVED_ERROR_MEMBERS` plus `DUNDER_MEMBER` for error members — with no local re-alias; its `IDENTIFIER` regex loses `$`.

The constants live in the Service Definition even though the worker is the only shipped backend: the whole point is that the contract is language-agnostic and owned above any single language. A Service Provider that violated it would be the bug, and the shared set is where a reviewer looks to see what "portable" means.

## Scope

This decision delivers the Service Definition extension and the worker-thread backend's adoption of it. The `py-types` renderer and PTC mode language dispatch are owned by the [language-dispatch note](../feature/2026-07-31-ptc-language-dispatch.md). The private experimental CPython subprocess backend (`dsh-experimental-code-runtime-python`) adopts the same portable-identifier contract.

`RESERVED_BINDING_GLOBALS` encodes the Python bootstrap's concrete design ahead of the backend itself: it seeds exactly `__builtins__`/`__name__` and wraps the program under `__dsh_main__`. A Python backend that seeds any additional module global (`__doc__`, `__loader__`, `__spec__`, `__file__`, `__package__`, …) MUST widen this set in the same change, exactly as adding a language widens `PORTABLE_RESERVED_WORDS` — a name the bootstrap seeds but the set omits is the portability split this contract exists to prevent.

## Alternatives considered

**Each backend declares its own exclusions.** Rejected: it makes the portability promise per-backend. A binding list the caller tested on the worker could be refused by Python, which is exactly the split the seam exists to prevent.

**The Python backend imports the worker's constants.** Rejected: it inverts the dependency — the seam's Service Providers would reach into a sibling implementation for a contract neither owns. The contract belongs above both, at the seam.

**Keep `$` in the portable identifier subset.** Rejected: `$` is JS-only spelling. Allowing it would let `$tools` pass the worker and fail every non-JS backend, breaking portability for a purely cosmetic gain.

## Consequences

Bought: one place — the Service Definition package — defines what a portable binding name is, and every backend enforces the same contract by import. A namespace list valid on one backend is valid on all, verifiably, not by coincidence of which backend the caller tested.

Cost: existing worker callers using a `$`-containing global now fail identifier validation. Under the pre-release stance this is a corrected foundation, not a compatibility break to shim. The worker's Service Definition misuse tests gain cases for `$tools`, Python exception members (`args`), dunders (`__dict__`), and a Python-owned global (`__dsh_main__`), proving the shared set is enforced from the worker side.
