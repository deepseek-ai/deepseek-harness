# DSH 核心准则

[English](README.md) | 中文

## 概述

编写 DeepSeek Harness 代码的规则，风格沿用 [C++ Core Guidelines](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines)。每条规则有一个稳定编号，以及 [G.1](general.zh.md#g1) 规定的各个部分。

## 分组

- [G：通用](general.zh.md)
  - [G.1：每条规则都按标准格式编写](general.zh.md#g1)
  - [G.2：避免在公共接口参数中使用回调](general.zh.md#g2)
- [F：前端](frontend.zh.md)
- [B：后端](backend.zh.md)
- [D：数据交换](data-exchange.zh.md)

## 引言

完成变更之前，对照本准则的每条规则审查该变更新增或修改的代码。修复每处违规，或在变更中说明该规则为何不适用。变更不必迁移它本来不改动的已有代码。

按编号引用规则，例如“违反 G.2”。针对具体产物的审查规则见[防御性模式](../defensive-patterns/README.zh.md)，同样需要阅读。
