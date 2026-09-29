/**
 * Outbound HTTP policy for DeepSeek Harness: which proxy each request takes, and — in intranet mode —
 * which requests are refused.
 *
 * Node's built-in `fetch` ignores `HTTP_PROXY` and friends, so every harness request would connect
 * directly no matter what the user exported. The launcher resolves one policy from the launch
 * environment and installs it as undici's global dispatcher, which is what `fetch` resolves — so
 * LLM adapters, web search, MCP over HTTP, and telemetry are covered without touching their code.
 * `DSH_INTRANET_MODE` rides the same install: a deployment whose endpoints are internal gets a
 * local, immediate refusal for this product's public services instead of a request that waits out
 * its timeout on a network where they answer nothing.
 *
 * This is a library, not a plugin: transport policy has one answer per process, so there is nothing
 * for a composition to mount, swap, or scope.
 *
 * Five functions, one per way a caller needs the policy — install it, ask how to send one request,
 * build a child's environment, strip the ambient one for a replay, and answer whether the intranet
 * switch is on.
 * @module @deepseek-ai/dsh-http-proxy
 */

export {
  clearedProxyEnv,
  installProxyFromEnvironment,
  proxyEnvironmentForChild,
  proxyRouteFor,
  type ProxyRoute,
} from './install.ts'
export {
  INTRANET_MODE_ENV,
  intranetModeEnabled,
  PUBLIC_SERVICE_DOMAINS,
  type IntranetPolicy,
} from './intranet.ts'
