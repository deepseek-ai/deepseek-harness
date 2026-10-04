# Publish the Web UI behind a reverse proxy

English | [中文](public-deployments.zh.md)

`dsh --profile web` serves the GUI over plain HTTP on a loopback port, so a browser on another machine cannot reach it, and the process knows nothing about the address you do use. A reverse proxy in front of it owns that external leg — the public host name, TLS, and the path prefix it strips before forwarding to the listener — and `--public-url` tells DSH which address browsers use:

```sh
dsh --profile web --public-url https://app.example/ui/ --trusted-host app.example
```

## What `--public-url` advertises

`--public-url` accepts an `http://` or `https://` root with an optional mount prefix and normalizes it to end in `/`. It supplies the printed and opened startup URL, `DSH_WEB_URL`, and the web-surface orientation. The webserver keeps serving origin-root routes and never learns the mount. The `publicUrl` config field publishes the same advertisement.

## What the proxy must do

- **Preserve the browser-facing `Host`.** The fence compares the received `Host` against the accepted authorities, so the proxy forwards it unchanged instead of rewriting it to the listener's address.
- **Strip the mount prefix.** The listener answers origin-root routes, so a request for `/ui/api/...` must arrive as `/api/...`.
- **Forward upgrades.** Every request and WebSocket upgrade the page opens must reach the listener with its `Upgrade` and `Connection` headers intact; TLS terminates on the proxy's external leg when it serves HTTPS.
- **Rewrite cookie scope.** The backend always issues host-only `Path=/` cookies without `Secure`; the proxy rewrites `Path` to the mount (`/ui/`) and adds `Secure` on its HTTPS leg.
- **Redirect the bare mount.** `/ui/` is the only entry: it alone exchanges the launch token for the session cookie, and it or `/ui/index.html` serves the document to a browser that already holds that cookie, because the served document resolves URLs against its own directory. A request to `/ui` must arrive as `/ui/`, and the stripped backend cannot reconstruct that external path.

## Trust the authority browsers use

The fence accepts loopback plus every authority `--trusted-host` names. A browser that reaches the deployment under any other authority gets 403 for every API call, however correct the proxy is, so name the browser-visible authority with `--trusted-host`; advertising it with `--public-url` is display only and does not admit it. An entry without a port matches any port, which suits a tunnel that binds a different one each time. The fence only admits the request; the launch token in the printed URL and the signed session cookie authenticate it.

Neither the advertised URL nor the fence protects the listening port itself, so restrict the port to the trusted proxy or network.

## Secure the external leg

Terminate TLS at the proxy. An `http://` advertised root sends the launch token and the session cookie unencrypted, and an `https://` root encrypts only the browser-to-proxy leg. The printed URL carries a process credential, so share it only with intended users.

The [Web app reference](../../../packages/bundle/web-app/README.md#public-deployments) owns the `--public-url` and `--trusted-host` command-line contract and the `publicUrl` and `trustedHosts` fields.
