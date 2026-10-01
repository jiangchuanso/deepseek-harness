import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  execProgramPath,
  iconSizeFromHicolorPath,
  maxVersion,
  parseDebControl,
  parseDesktopEntry,
} from '../scripts/linux-deb-inspection.mjs'
import { LINUX_DEB_BASELINE_GLIBC, LINUX_DEB_DEPENDS } from '../scripts/linux-deb-baseline.mjs'

describe('Debian control parsing', () => {
  it('reads fields and folds a continuation line into its field', () => {
    const { fields } = parseDebControl([
      'Package: deepseek-harness',
      'Version: 0.2.0~rc.2',
      'Architecture: arm64',
      'Description: DeepSeek Harness Desktop',
      ' Electron desktop shell',
      ' for a bundled dsh runtime',
      '',
    ].join('\n'))
    expect(fields.Package).toBe('deepseek-harness')
    expect(fields.Version).toBe('0.2.0~rc.2')
    expect(fields.Architecture).toBe('arm64')
    expect(fields.Description).toBe('DeepSeek Harness Desktop\nElectron desktop shell\nfor a bundled dsh runtime')
  })

  it('strips version constraints and alternatives from dependencies', () => {
    const { dependencies } = parseDebControl('Depends: libgtk-3-0, libgbm1 (>= 2.31), libnotify4 | libnotify1\n')
    expect(dependencies).toEqual(['libgtk-3-0', 'libgbm1', 'libnotify4', 'libnotify1'])
  })

  it('declares every runtime library the Electron shell needs', () => {
    expect(new Set(LINUX_DEB_DEPENDS).size).toBe(LINUX_DEB_DEPENDS.length)
    for (const name of ['libgtk-3-0', 'libnss3', 'libasound2', 'libgbm1', 'libxkbcommon0']) {
      expect(LINUX_DEB_DEPENDS).toContain(name)
    }
  })
})

describe('launcher entry parsing', () => {
  it('reads only the desktop entry group', () => {
    const entry = parseDesktopEntry([
      '[Desktop Entry]',
      'Name=DeepSeek Harness',
      'Name[zh_CN]=深度求索',
      '# a comment',
      'Exec="/opt/DeepSeek Harness/deepseek-harness" %U',
      'Icon=deepseek-harness',
      'StartupWMClass=deepseek-harness',
      'Categories=Development;',
      '',
      '[Desktop Action NewWindow]',
      'Name=New Window',
    ].join('\n'))
    expect(entry.Name).toBe('DeepSeek Harness')
    expect(entry['Name[zh_CN]']).toBe('深度求索')
    expect(entry.Icon).toBe('deepseek-harness')
    expect(entry.StartupWMClass).toBe('deepseek-harness')
    expect(entry.Name).not.toBe('New Window')
  })

  it('reads the program an exec value launches', () => {
    expect(execProgramPath('"/opt/DeepSeek Harness/deepseek-harness" %U')).toBe('/opt/DeepSeek Harness/deepseek-harness')
    expect(execProgramPath('deepseek-harness --flag')).toBe('deepseek-harness')
    expect(execProgramPath('')).toBe('')
  })
})

describe('glibc version ordering', () => {
  it('orders dot-separated numbers numerically', () => {
    expect(compareVersions('2.9', '2.31')).toBeLessThan(0)
    expect(compareVersions('2.31', '2.31')).toBe(0)
    expect(compareVersions('2.35', '2.31')).toBeGreaterThan(0)
    expect(compareVersions('2.31', '2.31.1')).toBeLessThan(0)
  })

  it('names the newest requirement', () => {
    expect(maxVersion(['2.31', '2.17', '2.35'])).toBe('2.35')
    expect(maxVersion([])).toBeUndefined()
  })

  it('treats the Kylin baseline as an ordering boundary', () => {
    expect(compareVersions('2.31', LINUX_DEB_BASELINE_GLIBC)).toBe(0)
    expect(compareVersions('2.39', LINUX_DEB_BASELINE_GLIBC)).toBeGreaterThan(0)
  })
})

describe('hicolor icon sizes', () => {
  it('reads the pixel size from a hicolor directory', () => {
    const icon = '/usr/share/icons/hicolor/512x512/apps/deepseek-harness.png'
    expect(iconSizeFromHicolorPath(icon)).toBe(512)
    expect(iconSizeFromHicolorPath(icon.replace('/', '\\'))).toBe(512)
    expect(iconSizeFromHicolorPath('/usr/share/icons/hicolor/scalable/apps/deepseek-harness.svg')).toBeUndefined()
  })
})
