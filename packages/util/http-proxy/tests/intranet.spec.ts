import { describe, expect, it } from 'vitest'
import { INTRANET_MODE_ENV, intranetModeEnabled, PUBLIC_SERVICE_DOMAINS } from '../src/index.ts'
import { intranetRefusal, resolveIntranetPolicy } from '../src/intranet.ts'

/** A launch environment built from the names a user would export. */
function env(values: Record<string, string>): { get(name: string): { value: string } | undefined } {
  return { get: name => (name in values ? { value: values[name] as string } : undefined) }
}

/** The refusal for one URL under the switch, or `undefined` when the URL may be requested. */
function refusalFor(url: string, value = '1'): string | undefined {
  return intranetRefusal(resolveIntranetPolicy(env({ [INTRANET_MODE_ENV]: value })), new URL(url))
}

describe('resolveIntranetPolicy', () => {
  it('is off while nothing supplies the switch', () => {
    expect(resolveIntranetPolicy(env({}))).toBeUndefined()
    expect(intranetModeEnabled(env({}))).toBe(false)
  })

  it('treats a blank value as unset, so an empty export is not a switch', () => {
    expect(resolveIntranetPolicy(env({ [INTRANET_MODE_ENV]: '   ' }))).toBeUndefined()
  })

  it.each(['1', '0', 'false', 'yes'])('is on for the non-empty value %s, because presence is the switch', (value) => {
    // `0` and `false` are deliberately enabling: the switch is a deployment declaration, not a
    // boolean a typo could silently turn off, which is why `DSH_TELEMETRY_DISABLED` reads the same.
    expect(resolveIntranetPolicy(env({ [INTRANET_MODE_ENV]: value }))).toMatchObject({ domains: PUBLIC_SERVICE_DOMAINS })
    expect(intranetModeEnabled(env({ [INTRANET_MODE_ENV]: value }))).toBe(true)
  })
})

describe('intranetRefusal', () => {
  it('refuses the public service a shipped default still points at', () => {
    for (const url of [
      'https://api.deepseek.com/anthropic/v1/messages',
      'https://api.deepseek.com/anthropic/v1',
      'https://platform.deepseek.com/usage',
      'https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml',
      'https://harness-telemetry.deepseeksvc.com/v1/logs',
      'https://dsh-otel-collector.deepseeksvc.com/v1/logs',
      'https://deepseek.com/',
      'https://consumer.DEEPSEEK.com./probe',
    ]) {
      const refusal = refusalFor(url)
      expect(refusal, url).toContain('intranet mode')
      expect(refusal, url).toContain(INTRANET_MODE_ENV)
    }
  })

  it('names the host and the configuration that was meant to point elsewhere', () => {
    const refusal = refusalFor('https://api.deepseek.com/anthropic/v1/messages')
    expect(refusal).toContain('api.deepseek.com')
    expect(refusal).toContain('llm-deepseek.baseURL')
    expect(refusal).toContain('DEEPSEEK_SEARCH_BASE_URL')
  })

  it('refuses nothing while the switch is off, whoever the host belongs to', () => {
    expect(intranetRefusal(undefined, new URL('https://api.deepseek.com/'))).toBeUndefined()
  })

  it('leaves a deployment its own network', () => {
    // An internal endpoint is the whole point of the switch, so no private or unrelated host is
    // refused — including one whose name merely contains the vendor's.
    for (const url of [
      'http://llm.internal.corp:8000/anthropic/v1/messages',
      'http://127.0.0.1:8080/probe',
      'http://localhost/probe',
      'https://notdeepseek.com/probe',
      'https://deepseek.com.evil.test/probe',
      'https://deepseek.company.example/probe',
      'https://mirror.deepseeksvc.internal/probe',
    ]) {
      expect(refusalFor(url), url).toBeUndefined()
    }
  })
})
