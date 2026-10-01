/** Parsers for the Debian and freedesktop metadata the Linux package check inspects.
 *
 * The check itself runs only on a Linux packaging host (it shells out to dpkg-deb and objdump), so
 * the parts that read package metadata live here, where a test can import them without unpacking
 * an artifact.
 */

/**
 * Read the package names one Debian dependency field names.
 * @param {string} value - Raw `Depends` value, including version constraints and alternatives.
 * @returns {string[]} Declared package names.
 */
export function parseDebianDependencies(value) {
  return value.split(',')
    .flatMap(entry => entry.split('|'))
    .map(entry => entry.replace(/\(.*\)/u, '').trim())
    .filter(entry => entry !== '')
}

/**
 * Parse a Debian binary control file.
 * @param {string} text - Contents of a `DEBIAN/control` file.
 * @returns {{ fields: Record<string, string>, dependencies: string[] }} Fields plus parsed dependencies.
 */
export function parseDebControl(text) {
  /** @type {Record<string, string>} */
  const fields = {}
  let key
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '') continue
    if (/^\s/u.test(line)) {
      if (key !== undefined) fields[key] = `${fields[key]}\n${line.trim()}`
      continue
    }
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    key = line.slice(0, separator).trim()
    fields[key] = line.slice(separator + 1).trim()
  }
  return { fields, dependencies: parseDebianDependencies(fields.Depends ?? '') }
}

/**
 * Parse the `[Desktop Entry]` group of a freedesktop desktop file.
 * @param {string} text - Desktop file contents.
 * @returns {Record<string, string>} Entry keys, including localized ones such as `Name[zh_CN]`.
 */
export function parseDesktopEntry(text) {
  /** @type {Record<string, string>} */
  const entry = {}
  let inEntryGroup = false
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) {
      inEntryGroup = trimmed === '[Desktop Entry]'
      continue
    }
    if (!inEntryGroup || trimmed === '' || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    entry[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim()
  }
  return entry
}

/**
 * Compare two dot-separated release numbers.
 * @param {string} left - First version.
 * @param {string} right - Second version.
 * @returns {number} Negative when left is older, positive when newer, zero when equal.
 */
export function compareVersions(left, right) {
  const parse = value => value.split('.').map(part => {
    const parsed = Number.parseInt(part, 10)
    return Number.isFinite(parsed) ? parsed : 0
  })
  const leftParts = parse(left)
  const rightParts = parse(right)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  return 0
}

/**
 * Return the newest version in a set.
 * @param {string[]} versions - Candidate versions.
 * @returns {string | undefined} Newest version, or undefined when the set is empty.
 */
export function maxVersion(versions) {
  /** @type {string | undefined} */
  let highest
  for (const version of versions) {
    if (highest === undefined || compareVersions(version, highest) > 0) highest = version
  }
  return highest
}

/**
 * Read the program a desktop-file `Exec` value launches.
 * @param {string} exec - Raw `Exec` value, optionally quoted and carrying field codes.
 * @returns {string} Program path.
 */
export function execProgramPath(exec) {
  const trimmed = exec.trim()
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1)
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end)
  }
  return trimmed.split(/\s+/u)[0] ?? ''
}

/**
 * Read the pixel size a hicolor icon directory declares.
 * @param {string} path - Path inside `/usr/share/icons/hicolor`.
 * @returns {number | undefined} Pixel size, or undefined for scalable icons and foreign paths.
 */
export function iconSizeFromHicolorPath(path) {
  const match = /hicolor[\\/](\d+)x\d+[\\/]/u.exec(path)
  return match === null ? undefined : Number.parseInt(match[1], 10)
}
