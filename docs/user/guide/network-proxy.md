# Run DSH behind a network proxy

English | [中文](network-proxy.zh.md)

DSH routes its outbound requests — model calls, web search, page fetches, and MCP servers over HTTP — through the proxy named by the standard proxy environment variables. It reads them at launch; nothing else needs configuring. A few paths stay direct by design or by runtime limit, listed under "What stays direct" below.

## Export the variables

```sh
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
```

Put both lines in your shell profile so every `dsh` invocation inherits them, or in `$DSH_HOME/.env` (`~/.dsh/.env` by default) next to your API key; an exported variable always wins over that file. A project's own `.env` cannot set them: it arrives with `git clone`, and DSH refuses to start rather than let a repository decide where your traffic goes.

A proxy that needs credentials takes them in the URL: `http://user:password@proxy.example:8080`. DSH never prints the URL back: a diagnostic names the variable it rejected, so neither the username nor the password appears anywhere.

## Why your browser is proxied but your terminal is not

This is the most common surprise, and it is not specific to DSH. There is no single "system proxy" that all software obeys — there are three unrelated mechanisms:

| Mechanism | Who follows it |
|---|---|
| The operating system's proxy settings | Safari, most native macOS apps, Chrome and Edge |
| The `HTTP_PROXY` / `HTTPS_PROXY` environment variables | `curl`, `git`, `npm`, `pip`, and DSH |
| TUN mode (a virtual network interface) | Everything, transparently |

The "system proxy" switch in a proxy application such as Clash writes only the first one. Browsers pick it up; command-line tools never see it. That is why exporting the variables is a separate step, and why turning on TUN mode makes both work without any variables at all.

DSH does not read the operating system's proxy settings. Export the variables, or use TUN mode.

## Choose what stays direct

`NO_PROXY` lists hosts to reach directly:

```sh
export NO_PROXY=internal.example.com,.corp.example.com,registry.local
```

An entry names a host and matches it together with every subdomain under it: `NO_PROXY=example.com` also sends `api.example.com` direct. A leading `.` or `*.` is accepted and means the same thing. An entry may carry a `:port`, and `*` bypasses everything.

**CIDR ranges do not work.** An operating system bypass list often contains entries like `10.0.0.0/8` or `192.168.0.0/16`; copying those into `NO_PROXY` has no effect. Use host names or domain suffixes instead.

You do not need to list `localhost` or `127.0.0.1`. DSH always bypasses loopback, because its own Web UI and local servers would otherwise route through the proxy and loop.

## Limits worth knowing

**SOCKS proxies are not supported.** A `socks5://` value is reported at startup and skipped, and DSH connects directly for the scheme that named it — setting `HTTPS_PROXY=socks5://…` alongside a usable `HTTP_PROXY` leaves `https:` direct rather than borrowing the HTTP proxy. Point the variables at your proxy application's HTTP port instead — most expose both, and the HTTP one is usually a neighbouring port number.

**`ALL_PROXY` alone is enough.** DSH falls back to it for both schemes, even though Node and curl differ on this. Setting `HTTPS_PROXY` explicitly is still clearer.

**A TLS-intercepting corporate proxy needs its certificate.** If requests fail with a certificate error once the proxy is reachable, point Node at your organisation's CA bundle before launching:

```sh
export NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem
```

Node reads that variable only at process start, so export it before running `dsh`.

**Tools DSH runs for you follow the same proxy.** Commands in the bash tool, `git`, `gh`, and MCP servers started as child processes all inherit these variables. A child that is itself a Node program honors them only on Node 22.21 or later; an older Node connects directly. If one of your proxy variables holds a value DSH rejected — a SOCKS URL, say — Node-based tools also connect directly rather than fail to start, while `curl` and `git` still read that value.

**A password in the proxy URL reaches those tools too.** `HTTPS_PROXY=http://alice:s3cret@proxy.example:8080` is a normal environment variable, so every command DSH runs — including the ones the model writes — can read it, and a command that prints its environment puts the password in output that is kept. This is how the variable already behaves for everything else in your shell. If that matters, give the proxy a credential-free entry point, or authenticate it some other way than in the URL.

## What stays direct

Not every request DSH makes goes through the proxy:

- **Anything on this machine.** Loopback is always direct: `localhost`, the whole `127.0.0.0/8` range, `::1`, and `0.0.0.0`. A proxy cannot usefully reach a service that only listens locally.
- **Code the model writes.** The workflow and code-runtime workers never receive the proxy settings, so a script the model authors cannot read a proxy URL that may carry a password. Such a script reaches the network only if it configures that itself.
- **Usage telemetry.** The OTLP exporter uses Node's own HTTP client rather than the one a proxy configures, so telemetry connects directly and simply fails where direct egress is blocked. Nothing you do in DSH depends on it. Set `DSH_TELEMETRY_MODE=DISABLED` to turn it off entirely.
- **`web_fetch` to a literal private address.** A URL naming an address like `http://10.0.0.5/` is refused rather than handed to the proxy, the same refusal it gets with no proxy configured.

## Check that it worked

Ask the agent to fetch a page and watch your proxy application's connection log:

```sh
dsh --profile headless "fetch https://example.com and tell me the page title"
```

If the request does not appear there, confirm the variables survive into DSH's own environment:

```sh
env | grep -i proxy
```
