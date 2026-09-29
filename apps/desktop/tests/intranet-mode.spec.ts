/** Intranet mode in the Electron main process: where the switch comes from, and what it refuses. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { INTRANET_MODE_ENV as HOST_SWITCH, PUBLIC_SERVICE_DOMAINS as HOST_DOMAINS } from '@deepseek-ai/dsh-http-proxy'
import { desktopIntranetMode, INTRANET_MODE_ENV, PUBLIC_SERVICE_DOMAINS, refusedOrigin } from '../src/intranet-mode.ts'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** A Harness home holding one `.env` file, removed when the case ends. */
async function homeWithEnv(contents: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-desktop-intranet-'))
  roots.push(home)
  await writeFile(join(home, '.env'), contents)
  return home
}

describe('the switch this process reads', () => {
  it('names the switch and the domains the Host half enforces', () => {
    // This module spells both again so the main bundle never carries that package's `undici` import.
    // Pinning them here is what makes the duplication safe: a rename there fails this case instead of
    // silently leaving the switch off in the one process that decides whether to poll for updates.
    expect(INTRANET_MODE_ENV).toBe(HOST_SWITCH)
    expect(PUBLIC_SERVICE_DOMAINS).toEqual(HOST_DOMAINS)
  })
})

describe('desktopIntranetMode', () => {
  it('is off when neither layer supplies the switch', async () => {
    expect(desktopIntranetMode({}, await homeWithEnv(''))).toBe(false)
    expect(desktopIntranetMode({}, join(tmpdir(), 'dsh-desktop-absent-home'))).toBe(false)
  })

  it.each(['1', '0', 'false'])('is on for the exported value %s, because presence is the switch', (value) => {
    // A Desktop application started by a desktop session has no shell environment, so the exported
    // form is the exception rather than the rule — but an exported value still wins where it exists.
    expect(desktopIntranetMode({ [INTRANET_MODE_ENV]: value }, join(tmpdir(), 'dsh-desktop-absent-home'))).toBe(true)
  })

  it('reads the Harness home, which is the layer an installed application actually has', async () => {
    const home = await homeWithEnv(`${INTRANET_MODE_ENV}=1\nDEEPSEEK_BASE_URL=http://llm.internal.corp\n`)
    expect(desktopIntranetMode({}, home)).toBe(true)
  })

  it('treats a blank home value as off, so an empty line is not a switch', async () => {
    const home = await homeWithEnv(`${INTRANET_MODE_ENV}=\n`)
    expect(desktopIntranetMode({}, home)).toBe(false)
  })

  it('reports a home layer it cannot read, instead of passing it off as off', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const home = await mkdtemp(join(tmpdir(), 'dsh-desktop-intranet-unreadable-'))
    roots.push(home)
    // A directory where the file belongs is the readable case's failure: the switch stays off, and
    // the reason reaches the launch log the Host writes to as well.
    await mkdir(join(home, '.env'))
    expect(desktopIntranetMode({}, home)).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]?.[0])).toContain(INTRANET_MODE_ENV)
  })

  it('ignores home content the parser skips, as the Host layer does', async () => {
    // `node:util.parseEnv` drops a malformed line rather than failing the launch; the Host reads the
    // same file with it, so both processes agree on what a malformed line means.
    const home = await homeWithEnv('not an env file\n')
    expect(desktopIntranetMode({}, home)).toBe(false)
  })
})

describe('refusedOrigin', () => {
  it.each([
    'https://platform.deepseek.com',
    'https://api.deepseek.com/anthropic',
    'https://harness-telemetry.deepseeksvc.com',
    'https://deepseek.com',
  ])('refuses the account origin %s', (origin) => {
    expect(refusedOrigin(origin)).toBe(true)
  })

  it.each([
    'https://account.internal.corp',
    'http://127.0.0.1:8080',
    'https://notdeepseek.com',
    'https://deepseek.com.evil.test',
  ])('keeps the account origin %s, which no public service owns', (origin) => {
    expect(refusedOrigin(origin)).toBe(false)
  })

  it('has nothing to refuse when no session carries an origin', () => {
    expect(refusedOrigin(undefined)).toBe(false)
  })

  it('refuses an origin it cannot parse, rather than loading an unvalidated address', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(refusedOrigin('not a url')).toBe(true)
    expect(warn).toHaveBeenCalledOnce()
  })
})
