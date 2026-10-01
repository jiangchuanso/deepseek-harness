/** Fields of a Debian binary control file plus its parsed dependencies. */
export interface ParsedDebControl {
  readonly fields: Record<string, string>
  readonly dependencies: string[]
}

/**
 * Read the package names one Debian dependency field names.
 * @param value - Raw `Depends` value, including version constraints and alternatives.
 * @returns Declared package names.
 */
export function parseDebianDependencies(value: string): string[]

/**
 * Parse a Debian binary control file.
 * @param text - Contents of a `DEBIAN/control` file.
 * @returns Fields plus parsed dependencies.
 */
export function parseDebControl(text: string): ParsedDebControl

/**
 * Parse the `[Desktop Entry]` group of a freedesktop desktop file.
 * @param text - Desktop file contents.
 * @returns Entry keys, including localized ones such as `Name[zh_CN]`.
 */
export function parseDesktopEntry(text: string): Record<string, string>

/**
 * Compare two dot-separated release numbers.
 * @param left - First version.
 * @param right - Second version.
 * @returns Negative when left is older, positive when newer, zero when equal.
 */
export function compareVersions(left: string, right: string): number

/**
 * Return the newest version in a set.
 * @param versions - Candidate versions.
 * @returns Newest version, or undefined when the set is empty.
 */
export function maxVersion(versions: readonly string[]): string | undefined

/**
 * Read the program a desktop-file `Exec` value launches.
 * @param exec - Raw `Exec` value, optionally quoted and carrying field codes.
 * @returns Program path.
 */
export function execProgramPath(exec: string): string

/**
 * Read the pixel size a hicolor icon directory declares.
 * @param path - Path inside `/usr/share/icons/hicolor`.
 * @returns Pixel size, or undefined for scalable icons and foreign paths.
 */
export function iconSizeFromHicolorPath(path: string): number | undefined
