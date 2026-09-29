---
description: "Outbound HTTP proxy support for the harness: how one policy resolved from the launch environment reaches every request Node's fetch would otherwise send direct."
kind: "package-reference"
---

# @deepseek-ai/dsh-http-proxy

English | [中文](README.zh.md)

## Summary

Use this package to apply one outbound HTTP policy to Harness requests that use Node's built-in `fetch`, including LLM, web-search, and HTTP MCP traffic: which proxy each request takes, and — under the `DSH_INTRANET_MODE` switch — which requests are refused before they leave the process. The launcher reads standard proxy environment variables once, and ordinary `fetch` callers require no extra imports or changes. Local loopback traffic stays direct, while unsupported proxy URLs are reported and skipped for the affected scheme. Public helpers let callers route transports with their own proxy settings, prepare child-process environments, or clear proxy variables for isolated replays.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Nothing to mount, and nothing to configure. The `dsh` launcher resolves and installs the policy for every profile before the first plugin loads, so a user who exports `HTTPS_PROXY` is proxied everywhere, and a deployment that exports `DSH_INTRANET_MODE` is refused this product's public services everywhere. This is a library rather than a plugin because transport policy has one answer per process: there is no second implementation to swap and no scope narrower than the process to give one.

### Writing a new outbound call

Plain `fetch()` is proxied, and so is any SDK that reaches `globalThis.fetch` — the MCP HTTP transport and the pi-ai provider stack both do. Verify each SDK's actual transport; exceptions belong under [Known Limitations and Deferred Work](#known-limitations-and-deferred-work).

| You are writing | Use |
|---|---|
| A plain request, or an SDK that reaches `globalThis.fetch` | nothing — the global dispatcher already routes it |
| A call that must branch on whether this request is proxied | `proxyRouteFor(url)` |
| A call that owns its own transport, so the installed dispatcher never sees it | `proxyRouteFor(url)`, and refuse the `blocked` arm |
| An SDK that takes a proxy URL of its own | `proxyRouteFor(url)`, and pass `route.proxy` |
| A spawn whose environment you build yourself | apply `proxyEnvironmentForChild()` to it (`undefined` means remove) |
| A harness that must reach its own fixture server | apply `clearedProxyEnv()` to the spawn |

`proxyRouteFor` answers with the transport that answer assumed, not just the answer: its proxied arm carries the dispatcher already routing by this policy. A caller that read the policy and then built its own transport could have an unmount land between the two and send the request somewhere its branch never cleared.

Constructing `new Agent(...)` and passing it as `dispatcher` overrides the global one and silently bypasses the proxy. `verify-no-bare-dispatcher` rejects that outside this package. One call site legitimately owns its transport — `web-fetch-http` pins a request to addresses it validated, which is per-request state a process-wide dispatcher cannot hold — and says so with a `proxy-exempt:` comment on the line.

That gate cannot see inside an SDK, so each outbound call site carries an `egress.spec.ts` that drives its actual transport through a fake proxy and checks the observed route. Every new outbound call site must include that transport test. Telemetry asserts its direct-route exception. These tests detect dependency changes that alter routing without changing the call site.

### What the policy reads

`http_proxy`, `https_proxy`, `no_proxy`, and `all_proxy`, lowercase first and uppercase as the fallback, with a blank value treated as unset. `ALL_PROXY` backs both schemes, and HTTPS falls back to the HTTP proxy last — neither Node nor undici derives the first of these on its own. Values come from the launcher's snapshot: an exported variable first, then `$DSH_HOME/.env`. A project's own `.env` cannot carry these names — that file arrives with a clone, and the launcher refuses to start rather than let a repository choose where the harness sends its traffic.

Loopback is always bypassed — `localhost`, the whole `127.0.0.0/8` range, `::1`, `0.0.0.0`, and the IPv4-mapped spellings of those. The harness's own Web UI, Connection transport, and every local test server would otherwise route through the proxy and loop. The published bypass list names only the four literal entries an environment reader can match; `proxyForUrl` recognises the range itself, because a list entry cannot express one.

<a id="intranet-mode"></a>
### Intranet mode

`DSH_INTRANET_MODE` refuses this product's own public services — `deepseek.com` and `deepseeksvc.com`, each together with every subdomain under it. A deployment whose model and search endpoints live inside its own network sets it once, and a route still carrying a shipped public default then fails in milliseconds instead of waiting out a connection timeout on a network where the vendor answers nothing. It is resolved from the same launch snapshot as the proxies, so `$DSH_HOME/.env` may carry it — the invoking directory's file may not, since that file arrives with a clone — and an exported variable wins over it. Any non-empty value enables it, `0` and `false` included: like `DSH_TELEMETRY_DISABLED`, presence is the switch.

Intranet mode also opts the telemetry exporter out, because that exporter posts through `node:http` and no installed dispatcher reaches it. Nothing else is disabled: an internal endpoint keeps working, including an account platform the deployment runs itself.

### Failures

A proxy value the package cannot use — a SOCKS or PAC URL, an unparseable string, an unsupported scheme — is reported and skipped, and that scheme connects directly. The variable may have been exported for other tools, so it must not stop the agent from starting.

An intranet refusal is the other way round: it is never skipped. A refused request fails with a transport error whose message names the refused host, the domain that owns it, and the setting a deployment was meant to point at an internal endpoint — the model route's `llm-deepseek.baseURL` or `DEEPSEEK_BASE_URL`, and web search's `web-search-deepseek.baseURL` or `DEEPSEEK_SEARCH_BASE_URL`. Nothing is sent, so the failure costs no more than the error itself.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

### Design philosophy

**One resolution, one matcher.** `proxyForUrl()` and the installed dispatcher must never disagree about a URL, or `dsh-web-fetch-http` would pin a connection the dispatcher meant to tunnel. The dispatcher is therefore an `Agent` whose per-origin `factory` calls `proxyForUrl()` itself, so there is no second parser to drift from the first. undici's `EnvHttpProxyAgent` cannot serve here: with no `HTTPS_PROXY` present it reuses the HTTP proxy for `https:`, which would tunnel a scheme this package keeps direct after refusing the URL the user named for it.

**A child inherits the user's own values, and the resolved policy for what they left unset.** A scheme the user named in either casing reaches a child exactly as they wrote it, so a SOCKS proxy `curl` uses is never replaced by an HTTP one named for another scheme. A scheme they named in neither casing carries the resolved value instead, because otherwise the child's routing diverges from its parent's: Node's `NODE_USE_ENV_PROXY` does not read `ALL_PROXY`. The bypass list is always the resolved one — it only ever adds the loopback entries, so nothing the user wrote is lost. The cost of one routing answer for parent and child alike is that `curl` also sees the `https:` proxy this package derives from the HTTP one. One exception protects the child itself: when a value it receives is one this package refused — a SOCKS URL kept for `curl` — the `NODE_USE_ENV_PROXY` flag is withheld, because Node parses `HTTP_PROXY` and `HTTPS_PROXY` under that flag before running the program and exits on such a value. A child Node then connects directly, as this process already reported for that scheme, instead of failing to start.

### Source map

| File | Holds |
|---|---|
| `src/policy.ts` | Resolution and bypass matching; a diagnostic names the variable, never its value. Imports no transport, so it stays loadable where undici is absent. |
| `src/intranet.ts` | The intranet switch, the refused domains, and the refusal message. Transport-free like `policy.ts`. |
| `src/install.ts` | The global dispatcher, the active proxy and intranet policies, the route, and the child environment. Imports undici dynamically. |
| `src/index.ts` | The package face: five functions, two constants, and the types they carry. |

### Bypass matching

An entry names a host and matches it together with every subdomain under it: `NO_PROXY=example.com` also bypasses `api.example.com`. A leading `.` or `*.` is accepted and means the same thing. An entry may carry a `:port`, and `*` bypasses everything. A bracketed or bare IPv6 literal matches either way — a bare `::1` is *not* read as host `:` port `1`, which is how undici's own matcher fails and why the resolved list carries both `::1` and `[::1]`. CIDR is not matched: an operating system's bypass list often carries `10.0.0.0/8`, which has to be rewritten as suffixes.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Network proxy guide](../../../docs/user/guide/network-proxy.md) — what to export, and why a browser is proxied when a terminal is not.
- [`dsh-web-fetch-http`](../../web/web-fetch-http/README.md) — the one consumer whose safety rules change under a proxy.

-----

<a id="model-experience"></a>
## Model Experience

None, as transport policy only: it changes how bytes reach the network and registers no prompt, schema, or result text.

#### KV Cache effect

No direct invalidation: the package contributes no request tokens and never mutates a request prefix, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the package is a poor fit. They are current package constraints.

- **No SOCKS, PAC, or operating-system proxy detection** — only `http(s)://` proxy URLs from the environment. A macOS or Windows system-proxy setting is not read, so a user who only toggled it in a proxy application must still export the variables; a SOCKS URL is reported and that scheme stays direct rather than borrowing another scheme's proxy.
- **No custom certificate authority** — a TLS-intercepting corporate proxy needs `NODE_EXTRA_CA_CERTS` set on the process before launch, which this package neither sets nor validates.
- **A spawned child honors the policy only on a new enough runtime, and only when every value it inherits is one Node accepts** — it reads the published environment through Node's `NODE_USE_ENV_PROXY` (22.21+, 24+), and the engines range admits 22.19 and 22.20, where such a child stays direct. A user whose environment also names a SOCKS or otherwise refused proxy leaves every child Node direct: the flag is withheld so the child can start at all. A child also matches bypass entries with Node's own `NO_PROXY` rules, which differ from this package's in their separators and IPv4-range support. Nothing in this process depends on a Node version: every in-process request reaches the global dispatcher.
- **Telemetry is direct by design** — the OTLP exporter posts through `node:http`, which no global dispatcher reaches. Routing it would need either an `http.Agent` whose `proxyEnv` option post-dates the lowest supported Node, or the SDK's `fetch` transport, which has no compression while the shipped profile enables gzip. Telemetry is the one channel whose loss costs the user nothing, so it stays where it was; `DSH_TELEMETRY_MODE=DISABLED` turns it off.
- **Model-authored programs receive no proxy settings** — the Node ptc-runtime process and workflow worker do not inherit a proxy URL that may contain `user:password`. Their direct requests need their own configuration and remain subject to the execution sandbox.
- **The intranet refusal covers this process's own requests, and reaches no other process** — a spawned child, a worker thread, and the Electron main process each own a transport, so each decides for itself. The launcher reaches the telemetry exporter by taking it out of the composition, and the Desktop shell by not polling the services the switch refuses.
- **The regression gate sees source, not dependencies** — `verify-no-bare-dispatcher` parses `packages/*/*/src` and `apps/*/src`; tests, scripts, and the internals of a third-party SDK are outside it. That is why every outbound call site also carries an `egress.spec.ts`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Reaching Node's built-in `fetch` from a userland undici relies on both writing the legacy `Symbol.for('undici.globalDispatcher.1')` slot. That is an implicit cross-version coupling, not a contract — see [corepack#834](https://github.com/nodejs/corepack/issues/834) for it breaking. `tests/install.spec.ts` asserts a real request reaches a loopback proxy, so a version bump that breaks the coupling fails there rather than in the field.

</details>

**Runtime invariant:** No companion is published. The one piece of mutable state here — the active policy — is asserted against the dispatcher it installs by unit tests that dispose the registration and observe a real loopback proxy.
