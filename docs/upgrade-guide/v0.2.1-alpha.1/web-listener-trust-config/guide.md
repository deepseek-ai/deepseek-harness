---
kind: upgrade-guide
description: "The Web profile replaces the `webRuntime` service and the `web-runtime` row's `trustedHosts` config with `webStartup`, and rejects a wildcard listener host."
---

# Web listener and trust configuration moves to `webStartup`

English | [中文](guide.zh.md)

## Change

The Web profile no longer provides the `webRuntime` service, and the `web-runtime` row no longer declares a `trustedHosts` config value. A profile, overlay, or `--patch` file that injects `webRuntime` now waits for a service that never mounts, and an expression reading `ctx.webRuntime.trustedHosts` fails to evaluate, so the required Connection cannot start.

The `web-startup` row provides one `webStartup` service carrying the invocation's `--trusted-host` authorities, and the `connection` row reads them from `ctx.webStartup.trustedHosts`. The listener host must also be one concrete IPv4 or IPv6 address of a local interface: `host: 0.0.0.0`, `--host ::`, and every other unspecified address are rejected at load, because binding every interface exposes the port to the network.

## Migration

1. Replace `inject: [webRuntime]` with `inject: [webStartup]` on every row that needs invocation trust.
2. Replace `ctx.webRuntime.trustedHosts` expressions with `ctx.webStartup.trustedHosts`, and drop `ctx.webRuntime.lanAddresses`, which no longer exists.
3. Rewrite the `connection` overlay for `webStartup`, and move any `trustedHosts` value that the `web-runtime` row carried into its expression. A patch replaces the matched row's whole `config`, so restate that config completely, and write an array-valued `!!js` expression as a quoted scalar:

   ```yaml
   # before
   - id: connection
     inject: [webRuntime]
     config:
       trustedHosts: !!js "['app.internal', ...ctx.webRuntime.trustedHosts]"
   # after
   - id: connection
     inject: [webStartup]
     config:
       trustedHosts: !!js "['app.internal', ...ctx.webStartup.trustedHosts]"
   ```

4. Replace a wildcard `host` with one concrete address of a local interface. The bind IP itself is accepted by the Host fence with no `--trusted-host` entry; a proxy or DNS authority still needs one.
5. Boot with the migrated overlay: `dsh --profile web --patch ./extra.yml --no-open` must print the `dsh web:` URL line and serve. A row still waiting on `webRuntime` leaves the required Connection pending and reports an activation failure, and a rejected `host` fails at load. `dsh --profile web --patch ./extra.yml --dump-config` prints the composed patch before boot. [The Web bundle README](../../../../packages/bundle/web-app/README.md) owns the composed rows.
