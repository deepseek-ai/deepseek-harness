---
kind: upgrade-guide
description: "list_agents returns shared capacity and an agents array instead of a bare array."
---

# Read list_agents members through agents

English | [中文](guide.zh.md)

## Change

The structured result of `list_agents` changes from an array of members to `{ running, limit, agents }`. Consumers that iterate the result directly must use `result.agents`. The text result starts with a capacity line before the existing member lines.

`running` counts occupied subagent slots across the caller's tree, including starting, idle resident, stopping, and external children. It excludes the root and can exceed `limit` after the limit is lowered. Capacity is an observation, not a reservation.

## Migration

1. In code consuming `list_agents` results, replace iteration over `result` with iteration over `result.agents`; member fields are unchanged.
2. Read `result.running` and `result.limit` for capacity. Do not derive occupancy by counting member rows or their `status` values.
3. Verify an empty tree returns `running: 0` and lists the root under `agents`; with an active external child, capacity increases even though that child is absent from the member list.
