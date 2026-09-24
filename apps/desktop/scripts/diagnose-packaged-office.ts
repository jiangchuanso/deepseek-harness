/** Diagnose how the packaged Office/LibreOfficeKit engine was assembled and resolved.
 *
 * This is a forensic step: it never fails the build (the smoke owns failure) and
 * prints enough to decide, in a single CI run, whether a conversion failure comes
 * from an incomplete ASAR unpack, a missing engine package, or a runtime native
 * error. It runs against the unsigned unpacked application produced by packaging. */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { selectOfficeEngine } from '../../../scripts/libreoffice-packages.mjs'

const target = resolveDesktopBuildTarget()
const paths = resolveDesktopTargetBuildPaths()
const windows = target === 'win-x64'
const linux = target.startsWith('linux-')
const artifacts = paths.unsignedArtifacts
// electron-builder names the unpacked directory after the platform and only adds the
// architecture when it is not the platform default, so linux-arm64 lands in linux-arm64-unpacked.
const application = windows ? join(artifacts, 'win-unpacked')
  : linux ? join(artifacts, `${target}-unpacked`)
  : join(artifacts, 'mac-unpacked')
const resources = join(application, windows || linux ? 'resources' : 'Resources')
const appAsar = join(resources, 'app.asar')
const appAsarUnpacked = join(resources, 'app.asar.unpacked')
const dshAsar = join(appAsar, 'dsh')
const dshUnpacked = join(appAsarUnpacked, 'dsh')
const dshPrepared = paths.dsh

const lines: string[] = []
const note = (text: string): void => { lines.push(text); process.stdout.write(`${text}\n`) }
const warn = (text: string): void => {
  lines.push(text)
  process.stdout.write(`::warning::${text}\n`)
}

function section(title: string): void {
  note('')
  note(`== ${title} ==`)
}

async function readAsarEntry(relPath: string): Promise<{ exists: boolean; unpacked: boolean }> {
  if (!existsSync(appAsar)) return { exists: false, unpacked: false }
  try {
    const { readAsar } = await import('app-builder-lib/out/asar/asar.js')
    const asar = await readAsar(appAsar)
    const file = (asar as unknown as {
      getFile: (path: string, followLinks: boolean) => { unpacked?: boolean }
    }).getFile(relPath.replace(/\\/gu, '/'), false)
    return { exists: true, unpacked: file.unpacked === true }
  } catch {
    return { exists: false, unpacked: false }
  }
}

function listUnpackedEngines(): string[] {
  const dir = join(dshUnpacked, 'node_modules', '@deepseek-ai')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => name.startsWith('libreoffice-kit-'))
}

function readKitManifest(): Record<string, unknown> | undefined {
  for (const root of [join(dshPrepared, 'node_modules', '@deepseek-ai', 'libreoffice-kit'),
    join(dshUnpacked, 'node_modules', '@deepseek-ai', 'libreoffice-kit')]) {
    const manifestPath = join(root, 'package.json')
    if (existsSync(manifestPath)) {
      try {
        return JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      } catch {
        // fall through to the next candidate
      }
    }
  }
  return undefined
}

async function main(): Promise<void> {
  section('Packaged Office engine layout')
  note(`target=${target} platform=${windows ? 'win32' : linux ? 'linux' : 'darwin'} arch=${windows || linux ? (target.endsWith('arm64') ? 'arm64' : 'x64') : '?'}`)
  note(`appAsar=${appAsar} exists=${existsSync(appAsar)}`)
  note(`appAsarUnpacked=${appAsarUnpacked} exists=${existsSync(appAsarUnpacked)}`)
  note(`dshPrepared=${dshPrepared} exists=${existsSync(dshPrepared)}`)

  const manifest = readKitManifest()
  if (manifest === undefined) {
    warn('Could not read the libreoffice-kit manifest from the prepared or unpacked tree')
  }
  const optional = Object.keys((manifest?.optionalDependencies ?? {}) as Record<string, string>)
    .filter(name => name.startsWith('@deepseek-ai/libreoffice-kit-'))
  note(`kit optionalDependencies engines: ${optional.join(', ') || '(none)'}`) // eslint-disable-line @typescript-eslint/no-unnecessary-condition

  const { platform, arch } = {
    platform: windows ? 'win32' : linux ? 'linux' : 'darwin',
    arch: (windows || linux) && target.endsWith('arm64') ? 'arm64' : 'x64',
  }
  const expectedEngine = manifest === undefined ? undefined : selectOfficeEngine(
    manifest as { optionalDependencies?: Record<string, string> }, { platform, arch })
  note(`selectOfficeEngine(${platform}/${arch}) => ${expectedEngine ?? '(unknown)'}`) // eslint-disable-line @typescript-eslint/no-unnecessary-condition

  // Candidate engine packages the runtime may require: the packaging pick, the native
  // platform-arch name, libc-specific variants, and the wasm fallback.
  const candidates = new Set<string>(optional)
  if (expectedEngine !== undefined) candidates.add(`@deepseek-ai/libreoffice-kit-${expectedEngine}`)
  candidates.add(`@deepseek-ai/libreoffice-kit-${platform}-${arch}`)
  candidates.add(`@deepseek-ai/libreoffice-kit-${platform}-${arch}-glibc`)
  candidates.add(`@deepseek-ai/libreoffice-kit-${platform}-${arch}-musl`)
  candidates.add('@deepseek-ai/libreoffice-kit-wasm')

  section('Engine package presence (ASAR vs unpacked disk)')
  const unpackedEngines = new Set(listUnpackedEngines())
  note(`unpacked @deepseek-ai engines on disk: ${[...unpackedEngines].join(', ') || '(none)'}`)
  for (const name of [...candidates].sort()) {
    const short = name.replace('@deepseek-ai/libreoffice-kit-', '')
    // Candidates carry their @deepseek-ai scope, so both locations join the full package name;
    // joining the stripped suffix here reported every engine as absent even when it was unpacked.
    const onDisk = existsSync(join(dshUnpacked, 'node_modules', name))
    const asar = await readAsarEntry(`dsh/node_modules/${name}/package.json`)
    const flag = asar.exists ? (asar.unpacked ? 'asar(unpacked)' : 'asar(inline)') : 'absent'
    note(`- ${short.padEnd(18)} unpackedOnDisk=${onDisk} asar=${flag}`)
  }

  // Reconcile: is the engine the runtime actually needs present and physically unpacked?
  section('Reconciliation')
  const nativePresent = existsSync(join(dshUnpacked, 'node_modules', '@deepseek-ai', `libreoffice-kit-${platform}-${arch}`))
    || existsSync(join(dshUnpacked, 'node_modules', '@deepseek-ai', `libreoffice-kit-${platform}-${arch}-glibc`))
    || unpackedEngines.has(`libreoffice-kit-${platform}-${arch}`)
    || unpackedEngines.has(`libreoffice-kit-${platform}-${arch}-glibc`)
  if (!nativePresent && !unpackedEngines.has('libreoffice-kit-wasm')) {
    warn(`No native ${platform}-${arch} engine and no wasm fallback are unpacked; the kit will fail to resolve a converter.`)
  } else if (!nativePresent) {
    warn(`Native ${platform}-${arch} engine is not unpacked; only the wasm fallback is present. The kit must select wasm at runtime.`)
  } else {
    note(`Native ${platform}-${arch} engine is unpacked.`)
  }

  // Runtime resolve probe: load the engine package the way the Host does (Electron asar-aware
  // require) and report the resolved location verbatim. A failure here reproduces the
  // "Installed LibreOfficeKit package is incomplete / Cannot find module" path.
  section('Runtime resolve probe')
  const electron = windows ? join(application, 'DeepSeek Harness.exe')
    : linux ? join(application, 'deepseek-harness')
    : join(application, 'DeepSeek Harness')
  if (!existsSync(electron)) {
    warn(`Electron executable not found at ${electron}; skipping runtime resolve probe`)
  } else {
    const home = join(tmpdir(), `dsh-office-diag-${process.pid}`)
    mkdirSync(home, { recursive: true })
    try {
      const probe = join(home, 'probe.mjs')
      writeFileSync(probe, `
import { createRequire } from 'node:module'
const dsh = process.argv[2]
const names = JSON.parse(process.argv[3])
const require = createRequire(dsh + '/package.json')
for (const name of names) {
  try {
    const pkg = require.resolve(name + '/package.json')
    let index = null
    try { index = require.resolve(name + '/lib/index.js') } catch { index = null }
    console.log('RESOLVE_OK ' + name + ' ' + pkg + (index ? ' index=' + index : ''))
  } catch (error) {
    console.log('RESOLVE_FAIL ' + name + ' ' + (error && error.message ? error.message.split('\\n')[0] : String(error)))
  }
}
`)
      const names = [...candidates]
      const systemBin = windows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : '/usr/bin:/bin'
      const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: systemBin, HOME: home,
        USERPROFILE: home, TMP: home, TEMP: home, TMPDIR: home }
      const { stdout } = await promisify(execFile)(electron,
        ['--expose-internals', probe, dshAsar, JSON.stringify(names)], {
        timeout: 90_000, windowsHide: true, env: environment,
      })
      for (const line of stdout.split('\n')) if (line.trim()) note(line)
      if (!stdout.includes('RESOLVE_OK @deepseek-ai/libreoffice-kit-wasm')
        && !stdout.includes(`RESOLVE_OK @deepseek-ai/libreoffice-kit-${platform}-${arch}`)
        && !stdout.includes(`RESOLVE_OK @deepseek-ai/libreoffice-kit-${platform}-${arch}-glibc`)) {
        warn('Runtime resolve probe found no usable engine package; the Host conversion will fail.')
      }
    } catch (error) {
      warn(`Runtime resolve probe failed to run: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  // Native helper direct probe: the kit's runNative spawns the engine helper as a real
  // process with --program-directory. If the kit hands it the ASAR virtual path, the helper
  // cannot read its own program directory (a real process cannot open inside app.asar) and
  // dies with the generic "Unknown LibreOfficeKit exception". Running the helper directly
  // with the physical unpacked path on a minimal document decides between that path bug and
  // a genuinely broken engine runtime, and captures the stderr the kit otherwise discards.
  section('Native helper direct probe')
  const engineShort = `libreoffice-kit-${platform}-${arch}`
  if (!nativePresent || !existsSync(electron)) {
    note(`skipped (native engine unpacked=${nativePresent}, electron=${existsSync(electron)})`)
  } else {
    const home = join(tmpdir(), `dsh-office-helper-${process.pid}`)
    mkdirSync(home, { recursive: true })
    try {
      const probe = join(home, 'helper-probe.mjs')
      writeFileSync(probe, `
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, mkdtempSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const say = (tag, value) => console.log(tag + ' ' + value)
const dsh = process.argv[2]
const engineShort = process.argv[3]
const windows = process.argv[4] === 'win32'
try {
  const require = createRequire(dsh + '/package.json')
  const name = '@deepseek-ai/' + engineShort
  let manifestPath
  try { manifestPath = require.resolve(name + '/package.json') } catch (e) {
    say('HELPER_SKIP', 'engine not resolvable: ' + (e && e.message ? e.message.split('\\n')[0] : String(e)))
    process.exit(0)
  }
  const physical = manifestPath.replace(/app\\.asar([\\\\/])/, 'app.asar.unpacked$1')
  const usePhysical = existsSync(physical)
  say('HELPER_MANIFEST_ASAR', manifestPath)
  say('HELPER_MANIFEST_PHYSICAL', physical + ' exists=' + usePhysical)
  const root = dirname(usePhysical ? physical : manifestPath)
  const prebuilds = join(root, 'prebuilds.json')
  if (!existsSync(prebuilds)) { say('HELPER_SKIP', 'no prebuilds.json beside the installed engine manifest'); process.exit(0) }
  const engine = JSON.parse(readFileSync(prebuilds, 'utf8')).engine
  if (!engine || engine.kind !== 'native') { say('HELPER_SKIP', 'no native engine entry in prebuilds.json'); process.exit(0) }
  const programDirectory = join(root, String(engine.programDirectory))
  const executable = join(root, String(engine.executable))
  say('HELPER_PROGRAM_DIR', programDirectory + ' exists=' + existsSync(programDirectory))
  say('HELPER_EXECUTABLE', executable + ' exists=' + existsSync(executable))
  if (!existsSync(executable)) { say('HELPER_SKIP', 'executable missing on disk'); process.exit(0) }

  const { zipSync, strToU8 } = createRequire(usePhysical ? physical : manifestPath)('fflate')
  const home = mkdtempSync(join(tmpdir(), 'dsh-lok-helper-'))
  const docx = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + '</Relationships>'),
    'word/document.xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + '<w:body><w:p><w:r><w:t>packaged helper probe</w:t></w:r></w:p></w:body></w:document>'),
  })
  const inputPath = join(home, 'probe.docx')
  writeFileSync(inputPath, Buffer.from(docx))
  const profile = join(home, 'profile')
  mkdirSync(profile)
  const outputPath = join(home, 'probe.pdf')
  // spawn already passes the executable as argv[0]; repeating it here makes the helper treat its
  // own binary path as the first worker argument and answer "Unknown worker argument" instead of
  // converting, which silently turns this probe into a fake negative.
  const args = ['--program-directory', programDirectory,
    '--input-path', inputPath,
    '--output-path', outputPath,
    '--profile-directory', profile,
    '--max-output-bytes', String(20 * 1024 * 1024),
    '--max-image-resolution', '300',
    '--format', 'pdf',
    '--recalculate', 'false']
  const env = {}
  for (const key of ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'Path']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  if (windows) env.PATH = programDirectory + delimiter + (env.PATH ?? env.Path ?? '')
  if (process.platform === 'linux') env.LD_LIBRARY_PATH = programDirectory
  Object.assign(env, { HOME: profile, USERPROFILE: profile, TMP: profile, TEMP: profile, TMPDIR: profile })
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
  const code = await new Promise(resolveExit => {
    child.once('error', e => { say('HELPER_SPAWN_ERROR', e.message) })
    child.once('close', resolveExit)
  })
  clearTimeout(timer)
  say('HELPER_EXIT', String(code))
  say('HELPER_STDOUT', stdout.trim().slice(-4000) || '(empty)')
  say('HELPER_STDERR', stderr.trim() || '(empty)')
  say('HELPER_OUTPUT_PDF', existsSync(outputPath) ? statSync(outputPath).size + ' bytes' : 'missing')
} catch (error) {
  say('HELPER_ERROR', error && error.message ? error.message : String(error))
}
`)
      const systemBin = windows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : '/usr/bin:/bin'
      const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: systemBin, HOME: home,
        USERPROFILE: home, TMP: home, TEMP: home, TMPDIR: home }
      const { stdout } = await promisify(execFile)(electron,
        ['--expose-internals', probe, dshAsar, engineShort, windows ? 'win32' : 'linux'], {
        timeout: 180_000, windowsHide: true, env: environment,
      })
      for (const line of stdout.split('\n')) if (line.trim().startsWith('HELPER_')) note(line.trim())
      if (stdout.includes('HELPER_EXIT 0') && !stdout.includes('HELPER_OUTPUT_PDF missing')) {
        note('The helper converts fine when given the physical unpacked path; a packaged-run failure therefore points at the kit handing native child processes an ASAR virtual path.')
      } else if (stdout.includes('HELPER_EXIT 0')) {
        warn('Helper exited 0 but produced no PDF; inspect HELPER_STDOUT above.')
      } else if (stdout.includes('HELPER_STDERR (empty)') && stdout.includes('Unknown LibreOfficeKit exception')) {
        warn('The helper fails identically with the physical path; this is an engine runtime defect (missing DLL/resource), not an ASAR path issue.')
      }
    } catch (error) {
      warn(`Native helper probe failed to run: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  // prebuilds.json lists every asset the engine ships, so comparing it against each tree names the
  // exact files an incomplete copy, an ASAR unpack gap, or a Windows path-length limit dropped.
  // Executables survive all three because extension globs unpack them, which is why a helper can
  // look present and still fail on the registry data it bootstraps from.
  section('Engine manifest coverage (prebuilds.json)')
  const dataRelative = join('program', 'share', 'registry', 'graphicfilter.xcd')
  for (const [label, base] of [['prepared', dshPrepared], ['unpacked', dshUnpacked]] as const) {
    const engineRoot = join(base, 'node_modules', '@deepseek-ai', engineShort)
    const manifestPath = join(engineRoot, 'prebuilds.json')
    if (!existsSync(manifestPath)) {
      warn(`${label}: no prebuilds.json under ${engineRoot}`)
      continue
    }
    let files: Record<string, string> = {}
    try {
      files = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { files?: Record<string, string> }).files ?? {}
    } catch {
      // An unparseable manifest still leaves the presence checks below meaningful.
    }
    const names = Object.keys(files)
    const missing = names.filter(name => !existsSync(join(engineRoot, name)))
    const longest = names.reduce((max, name) => Math.max(max, join(engineRoot, name).length), 0)
    note(`${label}: engine=${existsSync(engineRoot)} manifest=${names.length} missing=${missing.length} longestPath=${longest} graphicfilter=${existsSync(join(engineRoot, dataRelative))}`)
    if (missing.length > 0) note(`${label}: first missing: ${missing.slice(0, 5).join(', ')}`)
  }
  const archivedData = await readAsarEntry(`dsh/node_modules/@deepseek-ai/${engineShort}/program/share/registry/graphicfilter.xcd`)
  note(`asar: graphicfilter present=${archivedData.exists} unpacked=${archivedData.unpacked}`)
  const longPathRoot = join(resources, 'long-path-probe')
  const longProbe = join(longPathRoot, 'x'.repeat(230), 'probe.txt')
  let longPaths = false
  try {
    mkdirSync(dirname(longProbe), { recursive: true })
    writeFileSync(longProbe, 'probe')
    longPaths = existsSync(longProbe)
  } catch {
    // A throw is the measurement: this host refuses the probe path.
  } finally {
    rmSync(longPathRoot, { recursive: true, force: true })
  }
  note(`long paths beyond MAX_PATH: supported=${longPaths} (probe length ${longProbe.length})`)

  section('Verdict')
  if (!existsSync(appAsarUnpacked)) {
    warn('app.asar.unpacked is missing entirely; every native asset is trapped inside ASAR and native loads will fail.')
  } else if (unpackedEngines.size === 0) {
    warn('No libreoffice-kit engine is unpacked; conversion cannot load native assets from outside ASAR.')
  } else {
    note('Engine assets are present outside ASAR; a remaining conversion failure is a runtime native issue, not an unpack defect.')
  }
}

// The diagnostic never fails the build; the smoke owns failure. Surface any unexpected error
// instead of letting the step turn the job red.
await main().catch((error: unknown) => {
  note(`diagnose-packaged-office unexpected error: ${error instanceof Error ? error.message : String(error)}`)
})
process.exitCode = 0
