/**
 * Intranet mode: the launch-environment switch under which this process refuses to reach DeepSeek's
 * own public services at all.
 *
 * A deployment whose model endpoint and search endpoint live inside its own network does not want a
 * stray request to a public vendor service: `api.deepseek.com` answers nothing on an isolated
 * network, so the request spends its full connection timeout before failing — five minutes of a
 * frozen conversation turn for the model route, and a minute for an auxiliary search. Refusing such a
 * request locally costs nothing, fails in milliseconds, and names the configuration that was meant to
 * point elsewhere.
 *
 * The switch is read from the launch environment, like the proxy policy it is installed with, so one
 * resolution covers the launcher and every consumer of the installed dispatcher. It never denies a
 * loopback or private address: intranet mode restricts *this* vendor's public services, not the
 * internal endpoints a deployment is expected to configure.
 *
 * Nothing here imports `undici`, so the module stays loadable wherever the pure policy half is.
 * @module @deepseek-ai/dsh-http-proxy/intranet
 */

import type { EnvLookup } from './policy.ts'

/**
 * Launch-environment name that turns intranet mode on. Any non-empty value enables it, including
 * `0` and `false` — like `DSH_TELEMETRY_DISABLED`, the switch is opt-in by its presence, so an
 * inherited empty string is the only off state and no deployment can enable it by accident.
 */
export const INTRANET_MODE_ENV = 'DSH_INTRANET_MODE'

/**
 * Public service domains the harness refuses to reach in intranet mode, each matching itself and
 * every subdomain under it. These are the vendor's own public services — the model and Files API,
 * the account platform, the desktop download feed, and the telemetry collectors — all of which a
 * deployment inside its own network reaches through an internal endpoint or not at all.
 */
export const PUBLIC_SERVICE_DOMAINS: readonly string[] = ['deepseek.com', 'deepseeksvc.com']

/**
 * One resolved intranet policy. Present only while the switch is on; the installed dispatcher holds
 * this rather than the raw environment, so an install and the route it reports agree.
 */
export interface IntranetPolicy {
  /** Domains every request is refused for, matched with every subdomain under them. */
  readonly domains: readonly string[]
}

/**
 * Resolve this process's intranet policy from `env`.
 *
 * @param env - the launch environment, whose own layering already prefers real variables over `.env` files.
 * @returns the policy to enforce, or `undefined` while the switch is off.
 */
export function resolveIntranetPolicy(env: EnvLookup): IntranetPolicy | undefined {
  const value = env.get(INTRANET_MODE_ENV)?.value.trim()
  if (value === undefined || value === '') return undefined
  return { domains: PUBLIC_SERVICE_DOMAINS }
}

/**
 * Whether intranet mode is on, without building the policy a caller does not enforce. The launcher
 * uses it for the decisions that follow from the same switch — the telemetry opt-out, for instance —
 * so one environment answers both.
 *
 * @param env - the launch environment.
 * @returns true when the switch is on.
 */
export function intranetModeEnabled(env: EnvLookup): boolean {
  return resolveIntranetPolicy(env) !== undefined
}

/**
 * Why this URL must not be requested under `policy`, or `undefined` when it may be.
 *
 * The message names the endpoint a deployment was meant to configure, because the request that
 * reaches here is almost always a route still carrying its shipped public default: nothing in a
 * composition points the model route or the search provider at an internal address on its own.
 *
 * @param policy - the active intranet policy, or `undefined` while the switch is off.
 * @param url - the request URL.
 * @returns the refusal message, or `undefined` when the request may proceed.
 */
export function intranetRefusal(policy: IntranetPolicy | undefined, url: URL): string | undefined {
  if (policy === undefined) return undefined
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (host === '') return undefined
  const domain = policy.domains.find(entry => host === entry || host.endsWith(`.${entry}`))
  if (domain === undefined) return undefined
  return `intranet mode (${INTRANET_MODE_ENV}) refused ${host}: ${domain} is a public service of this`
    + ' product\'s vendor. Point this client at an internal endpoint — the model route takes'
    + ' `llm-deepseek.baseURL` or DEEPSEEK_BASE_URL, web search takes `web-search-deepseek.baseURL`'
    + ` or DEEPSEEK_SEARCH_BASE_URL — or unset ${INTRANET_MODE_ENV}.`
}
