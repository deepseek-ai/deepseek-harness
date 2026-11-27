# DSH Core Guidelines

English | [中文](README.zh.md)

## Summary

Rules for writing DeepSeek Harness code, in the style of the [C++ Core Guidelines](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines). Each rule has a stable ID and the parts that [G.1](general.md#g1) defines.

## Sections

- [G: General](general.md)
  - [G.1: Write every rule in the standard format](general.md#g1)
  - [G.2: Avoid callbacks in public interface parameters](general.md#g2)
  - [G.3: Add a gate with every new rule that a script can check](general.md#g3)
- [F: Frontend](frontend.md)
- [B: Backend](backend.md)
  - [B.1: Drive plugin work from lifecycle events, not loops that poll Agent state](backend.md#b1)
  - [B.2: Register independent entries through a registry instead of listing them in one plugin's config](backend.md#b2)
- [D: Data exchange](data-exchange.md)
- [P: Prompt](prompt.md)
  - [P.1: Describe a tool in its schema description, not in a system prompt section](prompt.md#p1)

## Status and scope

These guidelines are to DeepSeek Harness what the C++ Core Guidelines are to C++: the repository's coding standard for how to write code, independent of what the code does.

A rule belongs here when it would still apply if the code implemented a different feature. Examples are rules about interfaces, types, errors, resource ownership, concurrency, state, component structure, and data formats.

Business-domain rules do not belong here. A rule that describes what one feature, subsystem, or product decision must do lives with its owner: the package README, the [subsystem page](../subsystems/README.md), or an [Agent Note](../../.agents/notes/README.md). Review checks for one artifact's known bug classes live in [defensive patterns](../defensive-patterns/README.md).

## Introduction

Before you finish a change, review the code it adds or modifies against every rule in these guidelines. Fix each violation, or state in the change why the rule does not apply. A change does not have to migrate existing code it does not otherwise touch, including existing violations that a gate records ([G.3](general.md#g3)).

Cite a rule by its ID, for example "violates G.2". Read the [defensive patterns](../defensive-patterns/README.md) for the artifacts you change as well.
