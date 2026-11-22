---
kind: upgrade-guide
description: "SDK prompts without a time zone now report the runtime process zone to the model instead of an unavailable zone."
---

# SDK prompts report the process time zone by default

English | [中文](guide.zh.md)

## Change

In earlier releases, every SDK prompt reached the model with `Browser time zone for this request: unavailable.`, so the model asked the user to clarify unqualified dates and times. Now each ordinary prompt reports a zone, as Web prompts do: the `timeZone` passed with the prompt, or else the runtime process zone sampled for that prompt. The model then interprets unqualified dates and times in that zone, for example `Browser time zone for this request: UTC. Interpret otherwise-unqualified dates and times in this zone.`

This affects TypeScript and Python SDK applications, and direct JSON-RPC clients of `session/prompt` and `session/query`, that pass no zone. Containers usually run in `UTC`, which may not be the user's zone. A process zone that is not `UTC` or an IANA Area/Location name, such as `+00:00` under `TZ=GMT`, still reports `unavailable`. An explicit zone outside these formats now fails the request. Native slash commands are unchanged and record no zone.

## Migration

1. Pass the user's zone with each prompt when it differs from the runtime process zone:
   - TypeScript: `session.run(input, { timeZone: 'Asia/Shanghai' })`, `harness.run(input, { timeZone })`, or `client.prompt(sessionId, blocks, { timeZone })`.
   - Python: `session.run(input, time_zone="Asia/Shanghai")`, `harness.run(input, time_zone=...)`, or `client.session_prompt(session_id, blocks, time_zone=...)`.
   - JSON-RPC: add `"timeZone": "Asia/Shanghai"` to `session/prompt` or `session/query` params.
2. Alternatively, when one runtime serves users in one zone, set `TZ` in the runtime environment, for example `TZ=Asia/Shanghai`.
3. Confirm with a prompt that asks for the current time: the model request contains `Browser time zone for this request: <your zone>.`, and a request with an invalid zone such as `CST` fails with a JSON-RPC error naming the value.
