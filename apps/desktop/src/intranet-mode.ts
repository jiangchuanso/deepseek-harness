/**
 * Intranet mode as the Electron main process observes it.
 *
 * The Host process resolves the same switch from its own layered environment and enforces the
 * refusal for every request that goes through `fetch`. This process decides two things the Host
 * cannot decide for it, because both happen before or outside a Host request: whether the
 * mandatory-update policy is polled at all, and whether the embedded account documents may load an
 * origin on the public internet.
 *
 * The switch's name and the domains it refuses are owned by `@deepseek-ai/dsh-http-proxy`
 * (`packages/util/http-proxy/src/intranet.ts`). They are spelled again here rather than imported:
 * the Desktop main bundle inlines this application's workspace dependencies and may leave only its
 * own manifest dependencies external, while that package's install half imports `undici` — which
 * this bundle must not carry. `intranet-mode.spec.ts` pins both spellings to that package's exports,
 * so a rename there fails here instead of silently disabling the switch.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Launch-environment name that turns intranet mode on, as `@deepseek-ai/dsh-http-proxy` spells it. */
export const INTRANET_MODE_ENV = 'DSH_INTRANET_MODE'

/** Public service domains refused under the switch, as `@deepseek-ai/dsh-http-proxy` lists them. */
export const PUBLIC_SERVICE_DOMAINS: readonly string[] = ['deepseek.com', 'deepseeksvc.com']

/**
 * Whether this Desktop launch runs in intranet mode.
 *
 * An installed application is started by a desktop session rather than a shell, so the inherited
 * environment is usually empty and `$DSH_HOME/.env` — the one layer a user owns — is what carries
 * the switch. An exported variable still wins; a home file this process cannot read leaves the
 * switch off, and only a failure other than absence is reported, since most users have no file.
 *
 * @param environment - Electron's process environment.
 * @param home - Harness home shared with the npm-installed dsh.
 * @returns true when the switch is on.
 */
export function desktopIntranetMode(
  environment: NodeJS.ProcessEnv = process.env,
  home: string = resolveDshHome(),
): boolean {
  if (enabled(environment[INTRANET_MODE_ENV])) return true
  let values: Record<string, string>
  try {
    values = parseEnv(readFileSync(join(home, '.env'), 'utf8')) as Record<string, string>
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false
    // A layer this process cannot read is not a reason to fail a launch, but it must not pass as
    // "off" either: the Host reports the same file when it resolves the switch for its own half.
    console.warn(`dsh desktop: ${join(home, '.env')} could not be read for ${INTRANET_MODE_ENV}: ${String(error)}`)
    return false
  }
  return enabled(values[INTRANET_MODE_ENV])
}

/**
 * Whether one origin names a public service the switch refuses.
 *
 * @param origin - an absolute origin, or `undefined` when no account session carries one.
 * @returns true when the embedded account view must not load it.
 */
export function refusedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return false
  let host: string
  try {
    host = new URL(origin).hostname
  } catch (error: unknown) {
    // A session whose origin the Host produced as a URL but this process cannot parse is refused:
    // loading it would be an attempt against an address nothing validated.
    console.warn(`dsh desktop: account origin ${origin} is not a URL: ${String(error)}`)
    return true
  }
  return refusedHost(host)
}

/**
 * Whether one host is a refused domain or a subdomain of one, matching the switch's own rule so the
 * two processes refuse the same hosts.
 *
 * @param hostname - a URL hostname, with or without a trailing dot.
 * @returns true when the host is refused.
 */
function refusedHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  return PUBLIC_SERVICE_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`))
}

/** @param value - one environment value. @returns true when its presence enables the switch. */
function enabled(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== ''
}
