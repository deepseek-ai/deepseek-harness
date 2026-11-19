# DSH Core Guidelines

English | [中文](README.zh.md)

## Summary

Rules for writing DeepSeek Harness code, in the style of the [C++ Core Guidelines](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines). Each rule has a stable ID and the parts that [G.1](general.md#g1) defines.

## Sections

- [G: General](general.md)
  - [G.1: Write every rule in the standard format](general.md#g1)
  - [G.2: Avoid callbacks in public interface parameters](general.md#g2)
- [F: Frontend](frontend.md)
- [B: Backend](backend.md)
- [D: Data exchange](data-exchange.md)

## Introduction

Before you finish a change, review the code it adds or modifies against every rule in these guidelines. Fix each violation, or state in the change why the rule does not apply. A change does not have to migrate existing code it does not otherwise touch.

Cite a rule by its ID, for example "violates G.2". Artifact-specific review rules live in [defensive patterns](../defensive-patterns/README.md); read them as well.
