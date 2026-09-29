# electron-builder 26 packaging notes (T5-T16b, 2026-09-30)

Status: final artifacts were rebuilt in T16b from the post-T15 + status-message-polish source; `resources/host/supervisor.js` now matches `src/host/supervisor.js` byte-for-byte.
`npm run package:dir` and `npm run package:linux` build the unpacked dir,
AppImage and pacman package. Both packaged smokes (managed with a temp
`DSH_HOME`, attach with an external `dsh web` + `--attach-url-file`) pass on the
unpacked artifact, including the T15 runtime-resolver fallback. The pacman
dependency set is valid for the current Arch repositories (Option A, see §4).
Project metadata now points at the public GitHub repository and contact email (see §1).

## 1. Package metadata

`package.json` carries the public project metadata so that electron-builder's fpm
backend can produce the pacman package:

```jsonc
"homepage": "https://github.com/Moritz230127/dsh-electron",
"author": { "name": "Moritz001", "email": "moritz001@163.com" },
"desktopName": "dsh-electron",
"build": {
  "linux": { "maintainer": "Moritz001 <moritz001@163.com>" },
  "pacman": {
    "artifactName": "${name}-${version}-${arch}.pkg.tar.xz",
    "depends": [ /* §4 */ ]
  }
}
```

**Distribution caveat:** the package remains unsigned and uses the default
Electron application icon (tray icon is the official DSH icon). Review signing
and branding before distributing a binary release.

## 2. pacman metadata fix (T6)

Before the fix the target aborted with:

```
⨯ Please specify project homepage
Please specify author 'email' in the application package.json
It is required to set Linux .deb package maintainer. Or you can set maintainer in the custom linux options.
    at FpmTarget.computeFpmMetaInfoOptions (.../FpmTarget.ts:126:13)
```

Fix: the metadata block above (homepage + author email + `linux.maintainer`).
`build.pacman.artifactName` is set because electron-builder 26 otherwise emits
`*.pacman` even though the file is a normal xz-compressed pacman package.

## 3. Build-tool quirk: portable fpm needs `libcrypt.so.1`

On this Arch system `libxcrypt` provides only `libcrypt.so.2`, while
electron-builder's bundled portable Ruby links against `libcrypt.so.1`:

```
ruby: error while loading shared libraries: libcrypt.so.1: cannot open shared object file: No such file or directory
```

`libxcrypt-compat` (provider of `libcrypt.so.1`) is not installed. Two ways:

- Preferred long-term: `sudo pacman -S libxcrypt-compat` (system-wide fix).
- No system change (used for T6/T7): download and extract the package under
  /tmp and expose its lib dir only to the build process:

  ```bash
  pacman -Sp --print-format '%l' libxcrypt-compat
  mkdir -p /tmp/t6-libxcrypt && cd /tmp/t6-libxcrypt
  curl -fL -o libxcrypt-compat.pkg.tar.zst '<url>'
  bsdtar -xf libxcrypt-compat.pkg.tar.zst

  cd /home/Arch/工作区/dsh-electron
  LD_LIBRARY_PATH=/tmp/t6-libxcrypt/usr/lib npx electron-builder --linux pacman --publish never
  ```

The /tmp workaround is not persistent; rerun the download step after a reboot
or install `libxcrypt-compat`.

## 4. pacman dependency set (T7, Option A)

Decision: Option A — an explicit, verified list of real Arch package names.

Evidence:

- The stale electron-builder defaults included packages that do not exist in
  the current repos: `http-parser` (Chromium/Node bundle their own parser; not
  needed) and `libappindicator-gtk3` (replaced by
  `libayatana-appindicator`/`libappindicator` in modern Arch; Electron 44 does
  not require it). `libxss`, `re2`, `snappy`, `libnotify` were likewise not
  required by the bundled Electron 44 binary.
- Base list = the real package names from Arch's `electron44` package
  (extra, 44.4.5-1, the exact bundled major), i.e. `pacman -Si electron44`
  with the virtual `lib*.so=...` constraints dropped, plus `xdg-utils` for
  `shell.openExternal` (our app opens external links).
- All 21 names verified in the configured repos with `pacman -Si`
  (`LC_ALL=C pacman -Si <pkg>`): 21/21 found.
- `pacman -T <all 21>` on the live system -> exit 0, no unresolved entries.
- `objdump -p dist/linux-unpacked/dsh-electron` direct `NEEDED` sonames were
  mapped to owning packages (`ldd` + `pacman -Qoq`) and cross-checked against
  the sync-db dependency closure `pactree -s -u <list>` (193 unique packages).
  Every direct system library owner is in the closure: alsa-lib, at-spi2-core,
  cairo, glibc, libcups, dbus, expat, mesa, libgcc, glib2, gtk3, nspr, nss,
  pango, systemd-libs, libx11, libxcb, libxcomposite, libxdamage, libxext,
  libxfixes, libxkbcommon, libxrandr. `libffmpeg.so` is bundled in the app and
  intentionally not a system dependency.

The final list (also in `package.json > build.pacman.depends`):

```
c-ares libgcc glibc gtk3 libevent libffi libpulse nss zlib fontconfig brotli
libjpeg-turbo flac libdrm libxml2 minizip opus libxslt harfbuzz freetype2
xdg-utils
```

Virtual soname constraints (`libgtk-3.so=0-64`, ...) were intentionally left
out: `pacman -Si` cannot verify them as package names, while the provider
packages above already guarantee the libraries.

## 5. Verified artifacts (v0.2, T16b final rebuild)

Built from the final source on 2026-09-30 (T18 includes official tray icon, close-to-tray policy and clipboard-permission fix):

| Artifact | Size (bytes) | SHA-256 |
|---|---|---|
| `dist/linux-unpacked/dsh-electron` | 228,605,256 | `ee9faf5bb9fe78a750cc5099863c85c4459e7f04c387fd1f111c83e4e8c57c97` |
| `dist/linux-unpacked/resources/app.asar` | 100,003 | `f3369571ed4fdbbef0fe3f8c352226e30e27f379cc60e3c972d33d8e13fd1357` |
| `dist/dsh-electron-0.1.0-x86_64.AppImage` | 125,097,710 | `2e012af522005dfa222d4f2aa34c42f7446f9e25f4a5558021e4a9d7f37df7ad` |
| `dist/dsh-electron-0.1.0-x64.pkg.tar.xz` | 91,401,932 | `5f936c2e7cc88aa69345da7b506e862e10a1d4f8cd68c9650931e37ac2c3bade` |

`dist/linux-unpacked` totals 296,374,669 bytes.

### T15 runtime-resolver fallback (packaged layout)

electron-builder omits `src/main/runtime/**` from `app.asar` because the same
files are also shipped via `extraResources`, so the packaged app MUST fall back
to `<resources>/main/runtime`:

- `resources/main/runtime/{harness-runtime,health,ready-url}.js` exist in
  `dist/linux-unpacked`, in the AppImage and in the pacman package.
- `@electron/asar list` shows no `src/main/runtime` entries in `app.asar`.
- `src/main/main.js > runtimeModuleCandidates()` returns
  `[<app.asar>/src/main/runtime/<name>, <resources>/main/runtime/<name>]` and
  `loadRuntimeModule()` only falls through on `MODULE_NOT_FOUND`.
- Proof: a plain-Node load against the extracted asar with
  `resourcesPath=<unpacked>/resources` resolved `harness-runtime` (constructor),
  `health` (`waitForHealth`) and `ready-url` (`parseReadyUrl`) from the
  resources fallback; the managed packaged smoke below then starts the real app
  even though its asar has no runtime files.

T16 packaged smokes (unpacked, niri/Wayland, temp homes):

- managed: `DSH_HOME=<tmp> dist/linux-unpacked/dsh-electron` -> exit 0,
  snapshot `{"ok":true,"title":"DeepSeek Harness","readyState":"complete","bodyTextLength":365,"appRootFound":true}`,
  runtime stopped code=0, no orphans.
- attach: external temp `dsh web` + `--attach-url-file=<tmp>/current-url` ->
  exit 0, snapshot URL matched the external ephemeral port, the log shows
  `runtime mode: attach-url-file` and no DSH spawn; external server stopped
  afterwards and no packaged app process remained.

### v0.2 host packaging layout (extraResources)

The systemd unit runs the supervisor as a plain file outside `app.asar`, so
`package.json > build.extraResources` maps:

| from | to (inside `resources/`) | why |
|---|---|---|
| `src/host` | `host` | `supervisor.js` + `config.js` |
| `src/main/runtime` | `main/runtime` | supervisor's `require('../main/runtime/…')` |
| `scripts/run-dsh-host.js` | `scripts/run-dsh-host.js` | safe dev/packaged launcher |
| `packaging/dsh-host.service` | `dsh-host.service` | unit template |

`src/main/config.js` is intentionally **not** packaged: T11's supervisor is
self-contained and only requires `../main/runtime/harness-runtime`,
`../main/runtime/health` and `./config` (verified with grep).

Resolution check against the real unpacked layout:

```
$ node -e "require('./dist/linux-unpacked/resources/host/supervisor.js')"
supervisor loaded OK
exports: HostSupervisor, decideRuntimeChoice, discoverDisplayEnvironment, ...
```

- pacman: `bsdtar -tf dist/dsh-electron-0.1.0-x64.pkg.tar.xz` shows
  `opt/DSH Electron/resources/host/supervisor.js`, `…/host/config.js`,
  `…/main/runtime/{harness-runtime,health,ready-url}.js`,
  `…/scripts/run-dsh-host.js`, `…/dsh-host.service`; `pacman -Qip` still reports
  0.1.0-1 and the 21 verified depends.
- AppImage: `--appimage-extract` verified the same files under
  `squashfs-root/resources/…`.
- Packaged unit template contains
  `ExecStart=/usr/bin/node "/opt/DSH Electron/resources/host/supervisor.js"`.

These artifacts also contain the T8 bounded-reload and strict-audio fixes and
the T13 host supervisor/service/launcher packaging.

## 6. Remaining warnings / follow-ups

- Default Electron icon is used (no brand icon defined yet).
- The package is unsigned. A local `pacman -U` does not verify signatures, but
  do not distribute the artifact as-is.
- Packages remain unsigned; add a signature if you distribute binaries.
- AppImage execution needs FUSE 2 (`fuse2`, present here); otherwise use
  `--appimage-extract-and-run`.
- `.INSTALL` contains fpm's generated after-install/after-remove scripts.
- `docs/BUILD.md` was corrected to the real filename
  `dist/dsh-electron-0.1.0-x64.pkg.tar.xz` after T7.
