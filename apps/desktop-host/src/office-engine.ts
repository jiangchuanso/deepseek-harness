/** Resolve packaged Office engine manifests from their complete, unpacked resource directories. */
import { Module, registerHooks, type ModuleHooks } from 'node:module'
import { existsSync, realpathSync } from 'node:fs'
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Engine packages whose files must reach native child processes as physical paths. */
const ENGINE_SPECIFIER = /^@deepseek-ai\/libreoffice-kit-(?:darwin|win32|linux)-/u

/**
 * The CommonJS resolver that serves every `require` and `require.resolve` call.
 *
 * Node declares `Module._resolveFilename` privately, so this restates the one member the archive
 * rewrite wraps, and the rewrite leaves the resolver untouched when a runtime lacks it.
 */
interface CommonJsResolver {
  _resolveFilename?: (request: string, parent: unknown, isMain: boolean, options?: { paths?: string[] }) => string
}

/**
 * Locate the archive containing a packaged runtime.
 * @param runtimeDir - Prepared or ASAR-contained runtime directory.
 * @returns Parent archive path, or undefined for a prepared directory.
 */
export function runtimeArchivePath(runtimeDir: string): string | undefined {
  const parent = dirname(runtimeDir)
  return basename(parent) === 'app.asar' ? parent : undefined
}

/** How one packaged runtime's engine directory maps onto its unpacked counterpart. */
interface EngineDirectories {
  /** Archive directory the packaged runtime lives inside. */
  archive: string
  /** Archived engine directory prefix, ending before the platform suffix. */
  archived: string
  /** {@link archived}'s counterpart outside the archive. */
  unpacked: string
}

/**
 * @param runtimeDir - Prepared or ASAR-contained runtime directory.
 * @returns The engine directory pair, or undefined for a prepared directory.
 */
function engineDirectories(runtimeDir: string): EngineDirectories | undefined {
  const archive = runtimeArchivePath(runtimeDir)
  if (archive === undefined) return undefined
  const root = realpathSync(runtimeDir)
  const resolvedArchive = dirname(root)
  const packages = join('node_modules', '@deepseek-ai', 'libreoffice-kit-')
  return {
    archive: resolvedArchive,
    archived: join(root, packages),
    unpacked: join(`${resolvedArchive}.unpacked`, relative(resolvedArchive, root), packages),
  }
}

/**
 * Adapt the bundled LibreOfficeKit engine to this fork's packaging before it resolves a converter.
 *
 * The published `@deepseek-ai/libreoffice-kit` ships no Linux native build for this fork; the
 * supported Linux path is the WASM engine. The kit selects a native engine once it detects a glibc
 * runtime, then hard-fails instead of falling back to WASM, so on Linux we hide the glibc version
 * from its platform probe to let it pick WASM. On Windows the LibreOfficeKit helper loads
 * side-by-side native DLLs from its engine program directory; we mirror the kit's Linux
 * `LD_LIBRARY_PATH` handling by putting that directory on `PATH` so the native bridge resolves.
 */
export function installOfficeEngineRuntimeAdjustments(runtimeDir: string): void {
  if (process.platform === 'linux') {
    const report = process.report
    if (report !== undefined) {
      const original = report.getReport.bind(report)
      report.getReport = (() => {
        const result = original() as { header?: { glibcVersionRuntime?: string } }
        if (result?.header !== undefined) delete result.header.glibcVersionRuntime
        return result
      }) as unknown as typeof report.getReport
    }
    return
  }
  if (process.platform === 'win32' && existsSync(runtimeDir)) {
    const archive = runtimeArchivePath(runtimeDir)
    const root = realpathSync(runtimeDir)
    const base = archive === undefined ? root : join(`${archive}.unpacked`, relative(archive, root))
    const engineDir = join(base, 'node_modules', '@deepseek-ai', `libreoffice-kit-${process.platform}-${process.arch}`)
    if (existsSync(engineDir)) {
      const existing = process.env.PATH
      process.env.PATH = existing === undefined || existing === '' ? engineDir : `${engineDir}${delimiter}${existing}`
    }
  }
}

/**
 * Test whether one path begins with another, tolerating the separator and case differences between
 * a resolver's spelling and the path Electron's realpath answers with on Windows.
 *
 * No separator boundary is implied: the engine directory prefixes end inside the package name, so
 * that they cover every platform suffix, and callers that need a boundary append it themselves.
 * @param path - Candidate path.
 * @param prefix - Prefix it may start with.
 * @returns Whether {@link path} starts with {@link prefix}.
 */
function startsWithPath(path: string, prefix: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
  return normalize(path).startsWith(normalize(prefix))
}

/**
 * Translate one resolver result into the physical path a native child process must open.
 *
 * Electron answers `require` and `require.resolve` with archive-relative paths, while its
 * `realpathSync` reports an unpacked entry through the `app.asar.unpacked` sibling. The kit hands
 * whichever form it receives to the LibreOfficeKit helper as its program directory, so both forms
 * must converge on the physical file: an already-unpacked path is answered canonically, and an
 * archived path is rewritten onto its unpacked counterpart.
 * @param resolved - Path reported by a resolver.
 * @param directories - Archived and unpacked engine directory pair.
 * @returns Physical unpacked path.
 * @throws When an in-archive engine sits outside this runtime's package directory.
 */
function unpackedEnginePath(resolved: string, directories: EngineDirectories): string {
  let canonical: string
  try {
    canonical = realpathSync(resolved)
  } catch {
    // An archive entry the platform cannot resolve stays as reported and is matched below.
    canonical = resolved
  }
  if (startsWithPath(canonical, directories.unpacked)) return canonical
  if (startsWithPath(canonical, directories.archived)) {
    return directories.unpacked + canonical.slice(directories.archived.length)
  }
  // The archive needs a boundary: app.asar.unpacked starts with app.asar but lies outside it.
  if (startsWithPath(canonical, directories.archive + sep)) {
    throw new Error(`desktop Office engine resolved outside the runtime package directory: ${resolved}`)
  }
  return resolved
}

/**
 * Rewrite engine specifiers that only the CommonJS resolver reaches.
 *
 * `registerHooks` serves `require` and `import` but not `require.resolve`, and `require.resolve`
 * is the sole lookup `@deepseek-ai/libreoffice-kit` performs to find its engine package. Without
 * this wrapper the kit reads the archived manifest under `app.asar` and hands the native helper a
 * program directory no real process can open, so conversion fails with the kit's generic
 * LibreOfficeKit exception.
 * @param directories - Archived and unpacked engine directory pair.
 * @returns Restores the previous resolver when called.
 */
function installEngineCommonJsResolution(directories: EngineDirectories): () => void {
  const resolver = Module as CommonJsResolver
  const original = resolver._resolveFilename
  if (original === undefined) return () => {}
  resolver._resolveFilename = function (this: unknown, request, parent, isMain, options) {
    const resolved = original.call(this, request, parent, isMain, options)
    if (!ENGINE_SPECIFIER.test(request)) return resolved
    return unpackedEnginePath(resolved, directories)
  }
  return () => { resolver._resolveFilename = original }
}

/**
 * Keep engine executable and resource paths usable by native child processes outside Electron.
 * Hooks apply only to this thread; worker threads must install their own resolver.
 * @param runtimeDir - Prepared or ASAR-contained dsh runtime directory.
 * @returns Installed resolver for the Host lifetime, or undefined for a non-ASAR runtime.
 */
export function installOfficeEngineResolution(runtimeDir: string): ModuleHooks | undefined {
  installOfficeEngineRuntimeAdjustments(runtimeDir)
  const directories = engineDirectories(runtimeDir)
  if (directories === undefined) return undefined
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context)
      if (!ENGINE_SPECIFIER.test(specifier)) return resolved
      const resolvedPath = fileURLToPath(resolved.url)
      const physical = unpackedEnginePath(resolvedPath, directories)
      return physical === resolvedPath ? resolved : { ...resolved, url: pathToFileURL(physical).href }
    },
  })
  const restore = installEngineCommonJsResolution(directories)
  return { deregister() { restore(); hooks.deregister() } }
}
