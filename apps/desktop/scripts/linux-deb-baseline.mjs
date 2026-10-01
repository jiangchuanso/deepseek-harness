/** Debian-family baseline the Linux arm64 package must satisfy.
 *
 * Kylin V10 SP1 Desktop is the supported target: an arm64 UKUI desktop on an Ubuntu 20.04 base.
 * Packaging declares these values and the artifact check enforces them, so a package can never
 * ship a dependency the check ignores.
 */

/** glibc release the Kylin V10 SP1 Desktop base (Ubuntu 20.04) provides. */
export const LINUX_DEB_BASELINE_GLIBC = '2.31'

/** Debian package names the Electron shell needs on a Debian-family desktop.
 *
 * electron-builder replaces its own defaults once a build declares `deb.depends`, so the list
 * repeats those defaults and adds the Chromium runtime libraries a minimal Kylin desktop install
 * can lack. Tray support stays an electron-builder `Recommends` default (libappindicator3-1):
 * a missing recommended package must never block installation, while a missing library here
 * leaves the shell unable to start.
 */
export const LINUX_DEB_DEPENDS = [
  // electron-builder's own deb defaults.
  'libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0', 'libuuid1', 'libsecret-1-0',
  // Chromium runtime libraries the Electron shell loads while starting up.
  'libasound2', 'libatk-bridge2.0-0', 'libatk1.0-0', 'libcairo2', 'libcups2', 'libdrm2', 'libgbm1',
  'libpango-1.0-0', 'libx11-xcb1', 'libxcomposite1', 'libxdamage1', 'libxext6', 'libxfixes3', 'libxkbcommon0', 'libxrandr2',
]

/** Smallest hicolor icon size a launcher still renders as an application icon. */
export const LINUX_DEB_MINIMUM_ICON_SIZE = 48
