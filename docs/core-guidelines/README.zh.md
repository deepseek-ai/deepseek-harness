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

## 地位与范围

本准则之于 DeepSeek Harness，相当于 C++ Core Guidelines 之于 C++：它是本仓库关于“如何写代码”的编码标准，与代码实现什么功能无关。

一条规则若在代码实现其他功能时依然适用，就属于本准则。例如关于接口、类型、错误、资源所有权、并发、状态、组件结构和数据格式的规则。

业务领域规则不属于本准则。规定某个功能、子系统或产品决策必须如何运作的规则，放在拥有这条规则的文档里：包 README、[子系统页面](../subsystems/README.zh.md)或 [Agent Note](../../.agents/notes/README.zh.md)。针对某类产物已知缺陷的审查规则见[防御性模式](../defensive-patterns/README.zh.md)。

## 引言

完成变更之前，对照本准则的每条规则审查该变更新增或修改的代码。修复每处违规，或在变更中说明该规则为何不适用。变更不必迁移它本来不改动的已有代码。

按编号引用规则，例如“违反 G.2”。同样需要阅读所修改产物对应的[防御性模式](../defensive-patterns/README.zh.md)。
