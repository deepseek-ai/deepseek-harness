# Publish the Web UI behind a reverse proxy

English | [中文](public-deployments.zh.md)

`dsh --profile web` serves the GUI on a loopback port, so a browser on another machine cannot reach it, and the process knows nothing about the address you do use. A reverse proxy in front of it owns that external leg — the public host name, TLS, and the path prefix it strips before forwarding to the listener — and `--public-url` tells DSH which address browsers use:

```sh
dsh --profile web --public-url https://app.example/ui/ --trusted-host app.example
```

## What `--public-url` advertises

`--public-url` accepts an `http://` or `https://` root with an optional mount prefix and normalizes it to end in `/`. It supplies the printed and opened startup URL, `DSH_WEB_URL`, and the web-surface orientation. The webserver keeps serving origin-root routes and never learns the mount. The `publicUrl` config field publishes the same advertisement.

## What the proxy must do

- **Preserve the browser-facing `Host`.** The fence compares the received `Host` against the accepted authorities, so the proxy forwards it unchanged instead of rewriting it to the listener's address.
- **Strip the mount prefix.** The listener answers origin-root routes, so a request for `/ui/api/...` must arrive as `/api/...`.
- **Forward upgrades.** Every request and WebSocket upgrade the page opens must reach the listener with its `Upgrade` and `Connection` headers intact; TLS terminates on the proxy's external leg when it serves HTTPS.
- **Rewrite cookie scope.** A backend serving plain HTTP issues host-only `Path=/` cookies without `Secure`; the proxy then rewrites `Path` to the mount (`/ui/`) and adds `Secure` on its HTTPS leg. A backend listener serving its own TLS already marks the cookie `Secure`, so the proxy only rewrites `Path`.
- **Redirect the bare mount.** `/ui/` is the only entry: it alone exchanges the launch token for the session cookie, and it or `/ui/index.html` serves the document to a browser that already holds that cookie, because the served document resolves URLs against its own directory. A request to `/ui` must arrive as `/ui/`, and the stripped backend cannot reconstruct that external path.

## Trust the authority browsers use

The fence accepts loopback, the listener's own bind address, and every authority `--trusted-host` names. A browser that reaches the deployment under any other authority gets 403 for every API call, however correct the proxy is, so name the browser-visible authority with `--trusted-host`; advertising it with `--public-url` is display only and does not admit it. An entry without a port matches any port, which suits a tunnel that binds a different one each time. The fence only admits the request; the launch token in the printed URL and the signed session cookie authenticate it. TLS, wherever it terminates, changes none of this: the certificate identifies the server to the browser, not the browser to the server.

Neither the advertised URL nor the fence protects the listening port itself, so restrict the port to the trusted proxy or network.

## Secure the external leg

Terminate TLS at the proxy, on the listener itself, or on both; `--public-url` remains an advertisement. An `http://` browser-facing root exposes the launch token in plaintext. An `https://` proxy root protects the browser-to-proxy leg; encryption between proxy and listener depends on the listener's TLS configuration.

To terminate on the listener, pass `--tls-cert` and `--tls-key`, each a path resolved against the process working directory: the certificate file holds the full chain and the key file an unencrypted PEM private key. DSH never obtains, renews, or watches certificates, and the carrier reads the files once, so replace them and reload the listener or restart the process to change them; startup fails on a missing or invalid pair and never falls back to HTTP. The browser applies its own trust store and name checks, so the certificate must cover the hostname or IP you open. The default port stays 3080. Native TLS needs no proxy, but proxy deployments and `--public-url` remain supported independently. A TLS listener marks session cookies `Secure`; keep the public browser-facing leg HTTPS so browsers can return those cookies.

The printed URL carries a process credential, so share it only with intended users.

The [Web app reference](../../../packages/bundle/web-app/README.md#public-deployments) documents the `--public-url`, `--trusted-host`, and `--tls-cert`/`--tls-key` command-line options. In the Web profile, `publicUrl` configures the `web-runtime` row, `trustedHosts` configures the [Connection row](../../../packages/client/connection/README.md), and `tls` configures the [webserver row](../../../docs/subsystems/web-server.md#config).
