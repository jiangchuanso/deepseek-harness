/** Verify the packaged Debian artifact against the Kylin V10 SP1 Desktop baseline.
 *
 * The Debian package is the one Desktop artifact the smoke cannot judge: the smoke runs the unpacked
 * application directory, so a launcher entry with no installed icon, a missing runtime dependency,
 * or an ELF needing a newer glibc than Kylin ships all reach the user before any gate sees them.
 * This check unpacks the artifact and asserts what the target desktop actually consumes: the control
 * metadata, the launcher entry, the installed icon, and the glibc every shipped ELF requires.
 *
 * It runs on the Linux arm64 packaging host — dpkg-deb comes from dpkg and symbol versions from
 * binutils' objdump — and fails on any problem, so an incompatible package never becomes a release
 * asset. Metadata parsing lives in `linux-deb-inspection.mjs`.
 */
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { LINUX_DEB_BASELINE_GLIBC, LINUX_DEB_DEPENDS, LINUX_DEB_MINIMUM_ICON_SIZE } from './linux-deb-baseline.mjs'
import { compareVersions, execProgramPath, iconSizeFromHicolorPath, maxVersion, parseDebControl, parseDesktopEntry } from './linux-deb-inspection.mjs'

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46])
const GLIBC_SYMBOL = /GLIBC_(\d+(?:\.\d+)*)/gu
const REPORT_LIMIT = 20

/** @type {string[]} */
const problems = []

/** @param {string} text - Report line. */
function note(text) {
  process.stdout.write(`${text}\n`)
}

/** @param {string} text - Problem that makes the package unusable on the target desktop. */
function fail(text) {
  problems.push(text)
  process.stdout.write(`::error::${text}\n`)
}

/** @param {string} text - Finding that degrades the experience but still leaves the package usable. */
function warn(text) {
  process.stdout.write(`::warning::${text}\n`)
}

/** @param {string} title - Report section heading. */
function section(title) {
  note('')
  note(`== ${title} ==`)
}

/**
 * Whether one file is an ELF object.
 * @param {string} path - File to inspect.
 * @returns {boolean} True when the file starts with the ELF magic.
 */
function isElfFile(path) {
  let handle
  try {
    handle = openSync(path, 'r')
    const magic = Buffer.alloc(ELF_MAGIC.length)
    return readSync(handle, magic, 0, magic.length, 0) === magic.length && magic.equals(ELF_MAGIC)
  } catch {
    return false
  } finally {
    if (handle !== undefined) closeSync(handle)
  }
}

/**
 * List every ELF file under one directory.
 * @param {string} root - Directory to walk.
 * @returns {string[]} ELF file paths.
 */
function listElfFiles(root) {
  /** @type {string[]} */
  const found = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && isElfFile(path)) found.push(path)
    }
  }
  walk(root)
  return found
}

/**
 * Read the glibc symbol versions one ELF file imports.
 * @param {string} path - ELF file.
 * @returns {string[]} Required glibc versions; empty for a static or non-dynamic object.
 */
function glibcRequirements(path) {
  let output
  try {
    output = execFileSync('objdump', ['-T', path],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    // objdump exits non-zero for a static or non-dynamic object, which imports no symbols.
    return []
  }
  return [...output.matchAll(GLIBC_SYMBOL)].map(match => match[1])
}

/**
 * Find the packaged Debian artifact.
 * @param {string | undefined} requested - Explicit path from the command line.
 * @returns {string | undefined} Artifact path.
 */
function findDeb(requested) {
  if (requested !== undefined) return existsSync(requested) ? requested : undefined
  const artifacts = resolveDesktopTargetBuildPaths().unsignedArtifacts
  if (!existsSync(artifacts)) return undefined
  const packages = readdirSync(artifacts).filter(name => name.endsWith('.deb'))
  return packages.length === 1 ? join(artifacts, packages[0]) : undefined
}

/**
 * Collect the hicolor sizes one icon name ships.
 * @param {string} iconsRoot - Unpacked `/usr/share/icons/hicolor` directory.
 * @param {string} iconName - `Icon` value from the launcher entry.
 * @returns {{ sizes: number[], scalable: boolean }} Shipped sizes.
 */
function collectIconSizes(iconsRoot, iconName) {
  /** @type {number[]} */
  const sizes = []
  let scalable = false
  if (!existsSync(iconsRoot)) return { sizes, scalable }
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (entry.name !== `${iconName}.png` && entry.name !== `${iconName}.svg`) continue
      if (entry.name.endsWith('.svg')) scalable = true
      const size = iconSizeFromHicolorPath(path)
      if (size !== undefined) sizes.push(size)
    }
  }
  walk(iconsRoot)
  return { sizes, scalable }
}

async function main() {
  const { values } = parseArgs({
    options: { deb: { type: 'string' }, 'target-glibc': { type: 'string' } },
    allowPositionals: false,
  })
  const target = resolveDesktopBuildTarget()
  if (!target.startsWith('linux-')) throw new Error(`linux deb verification: ${target} produces no Debian package`)
  const targetGlibc = values['target-glibc']?.trim() || LINUX_DEB_BASELINE_GLIBC
  const deb = findDeb(values.deb?.trim())
  if (deb === undefined) {
    fail(values.deb === undefined
      ? `no single Debian package in ${resolveDesktopTargetBuildPaths().unsignedArtifacts}`
      : `Debian package ${values.deb} does not exist`)
    process.exitCode = 1
    return
  }

  section('Debian package')
  note(`artifact: ${basename(deb)}`)
  const root = join(tmpdir(), `dsh-linux-deb-${process.pid}-${Date.now()}`)
  try {
    mkdirSync(root, { recursive: true })
    try {
      execFileSync('dpkg-deb', ['-R', deb, root], { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      fail(`dpkg-deb could not unpack ${basename(deb)}: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
      return
    }

    const controlPath = join(root, 'DEBIAN', 'control')
    if (!existsSync(controlPath)) {
      fail(`${basename(deb)} ships no DEBIAN/control`)
      process.exitCode = 1
      return
    }
    const { fields, dependencies } = parseDebControl(readFileSync(controlPath, 'utf8'))
    note(`control: ${fields.Package ?? '(missing)'} ${fields.Version ?? '(missing)'} ${fields.Architecture ?? '(missing)'}`)
    if ((fields.Package ?? '') === '') fail('control declares no Package name')
    if ((fields.Version ?? '') === '') fail('control declares no Version')
    if ((fields.Architecture ?? '') === '') fail('control declares no Architecture')
    else if (fields.Architecture !== 'arm64') fail(`control Architecture is ${fields.Architecture}, not arm64`)
    if ((fields.Maintainer ?? '') === '') fail('control declares no Maintainer')
    note(`depends: ${dependencies.length} declared, ${LINUX_DEB_DEPENDS.length} required`)
    for (const name of LINUX_DEB_DEPENDS.filter(name => !dependencies.includes(name))) {
      fail(`Depends omits ${name}, which the Electron shell needs to start on Kylin`)
    }

    section('Launcher entry')
    const applications = join(root, 'usr', 'share', 'applications')
    const desktopNames = existsSync(applications)
      ? readdirSync(applications).filter(name => name.endsWith('.desktop'))
      : []
    if (desktopNames.length === 0) {
      fail(`${basename(deb)} installs no launcher entry under /usr/share/applications`)
      process.exitCode = 1
      return
    }
    if (desktopNames.length > 1) warn(`more than one launcher entry ships: ${desktopNames.join(', ')}`)
    const desktopName = desktopNames[0]
    note(`entry: /usr/share/applications/${desktopName}`)
    const entry = parseDesktopEntry(readFileSync(join(applications, desktopName), 'utf8'))
    if ((entry.Type ?? '') !== 'Application') fail(`launcher entry Type is ${entry.Type || '(unset)'}, not Application`)
    if ((entry.Terminal ?? '') !== 'false') fail(`launcher entry Terminal is ${entry.Terminal || '(unset)'}, not false`)
    if ((entry.Name ?? '') === '') fail('launcher entry declares no Name')
    if ((entry.Categories ?? '') === '') fail('launcher entry declares no Categories, so UKUI files it outside the menus it owns')
    if ((entry.StartupWMClass ?? '') === '') {
      fail('launcher entry declares no StartupWMClass, so the UKUI panel cannot pair the window with this entry')
    }
    note(`name: ${entry.Name ?? '(unset)'}`)
    note(`startup wm class: ${entry.StartupWMClass ?? '(unset)'}`)

    const execPath = execProgramPath(entry.Exec ?? '')
    if (execPath === '') fail('launcher entry declares no Exec')
    else {
      const installed = join(root, execPath.replace(/^\//u, '').split('/').join(sep))
      if (!existsSync(installed)) fail(`Exec points at ${execPath}, which the package does not install`)
      else if (!isElfFile(installed)) fail(`Exec target ${execPath} is not an ELF executable`)
      else note(`exec: ${execPath} (present)`)
      const sandboxPath = join(dirname(installed), 'chrome-sandbox')
      if (existsSync(sandboxPath)) {
        const setuid = (statSync(sandboxPath).mode & 0o4000) !== 0
        note(`chrome-sandbox: ${setuid ? 'setuid' : 'not setuid'}`)
        if (!setuid) {
          warn('chrome-sandbox ships without the setuid bit, so startup needs a kernel that allows unprivileged user namespaces')
        }
      }
    }

    section('Application icon')
    const iconName = entry.Icon ?? ''
    if (iconName === '') {
      fail('launcher entry declares no Icon, so the UKUI launcher shows a placeholder')
    } else {
      const { sizes, scalable } = collectIconSizes(join(root, 'usr', 'share', 'icons', 'hicolor'), iconName)
      const largest = sizes.length === 0 ? undefined : Math.max(...sizes)
      note(`icon: ${iconName} with ${sizes.length} hicolor size(s), largest ${largest ?? '(none)'}`)
      if (scalable) note('icon: scalable SVG present')
      if (sizes.length === 0 && !scalable) {
        fail(`no hicolor icon named ${iconName} ships, so the launcher entry has no icon`)
      } else if (!scalable && sizes.every(size => size < LINUX_DEB_MINIMUM_ICON_SIZE)) {
        fail(`largest hicolor icon is ${largest}px, below the ${LINUX_DEB_MINIMUM_ICON_SIZE}px a launcher renders`)
      }
      // An icon value containing a path bypasses the icon theme, which then ignores hicolor sizes.
      if (iconName.includes('/')) warn(`Icon ${iconName} is a path, not a theme icon name`)
    }

    section('glibc baseline')
    const elfFiles = listElfFiles(root)
    /** @type {{ path: string, version: string }[]} */
    const offenders = []
    let highest
    for (const file of elfFiles) {
      const required = maxVersion(glibcRequirements(file))
      if (required === undefined) continue
      if (highest === undefined || compareVersions(required, highest) > 0) highest = required
      if (compareVersions(required, targetGlibc) > 0) offenders.push({ path: relative(root, file), version: required })
    }
    note(`scanned ${elfFiles.length} ELF file(s); target glibc ${targetGlibc}; highest requirement ${highest ?? '(none)'}`)
    if (offenders.length > 0) {
      fail(`${offenders.length} file(s) require glibc ${maxVersion(offenders.map(offender => offender.version))}, above the ${targetGlibc} Kylin V10 SP1 Desktop provides`)
      for (const offender of offenders.slice(0, REPORT_LIMIT)) note(`  ${offender.version} ${offender.path}`)
      if (offenders.length > REPORT_LIMIT) note(`  ... ${offenders.length - REPORT_LIMIT} more`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  if (problems.length > 0) {
    note('')
    fail(`Kylin V10 SP1 Desktop baseline check failed with ${problems.length} problem(s)`)
    process.exitCode = 1
  } else {
    note('')
    note(`Kylin V10 SP1 Desktop baseline check passed (glibc ${targetGlibc}).`)
  }
}

await main()
