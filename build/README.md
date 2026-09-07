# Build Directory

Build configuration, platform metadata, and the Taskfiles that drive every Firn
build. Wails v3 orchestrates builds with [Task](https://taskfile.dev); the root
`Taskfile.yml` includes the per-platform Taskfiles below.

## Layout

| Path | Purpose |
| --- | --- |
| `config.yml` | Project identity and version. `info.version` is the single source of truth for the packaged product version. |
| `Taskfile.yml` | Shared tasks: frontend install/build, binding generation, icon generation, build-asset refresh. |
| `appicon.png` | The one tracked icon source (1024x1024). `darwin/icons.icns` and `windows/icon.ico` are generated from it. |
| `darwin/` | macOS Taskfile plus the generated `Info.plist`, `Info.dev.plist`, and `icons.icns`. |
| `linux/` | Linux Taskfile. |
| `windows/` | Windows Taskfile plus the generated `info.json`, `wails.exe.manifest`, and `icon.ico`. |
| `icons/` | Standalone PNG icons used outside the build (README, docs, packaging notes). |

Build output goes to the repository-root `bin/` directory (`bin/firn`,
`bin/Firn.app`), which is git-ignored.

## Commands

Run these from the repository root with the pinned `wails3` CLI on `PATH`:

```sh
wails3 task darwin:build      # macOS binary  -> bin/firn
wails3 task linux:build       # Linux binary  -> bin/firn
wails3 task windows:build     # Windows binary -> bin/firn.exe
wails3 task darwin:package    # macOS .app bundle -> bin/Firn.app
wails3 task dev               # Vite dev server + hot-reloading desktop window
```

`wails3 task build` and `wails3 task run` dispatch to the host platform, and
`wails3 task dev` runs `wails3 dev -config ./build/config.yml` on the Vite
port. That port is the root `Taskfile.yml`'s `VITE_PORT` var — the single
place it is defined, overridable per invocation with `WAILS_VITE_PORT`. Add
`ARCH=arm64` / `ARCH=amd64` to select the target architecture, and `DEV=true`
for a non-production build.

The binary is always named `firn` and the macOS bundle is always `Firn.app`:
release archives and `install.sh` depend on both names.

## Regenerating platform metadata

`darwin/Info.plist`, `darwin/Info.dev.plist`, `windows/info.json`, and
`windows/wails.exe.manifest` are generated from `config.yml`. After editing the
`info` block, refresh them with:

```sh
wails3 task common:update:build-assets
```

That command is coarse: it also writes assets for packaging targets this project
does not maintain (`ios/`, `linux/nfpm/`, `linux/desktop`, `windows/nsis/`).
Those paths are git-ignored on purpose - do not track them. It also re-emits a
3-part `assemblyIdentity` version in `windows/wails.exe.manifest`; restore the
4-part `<info.version>.0` form afterwards (the release-script test suite enforces it).

The task passes `-productdescription <info.productName>` on purpose: the
upstream template maps `windows/info.json`'s `FileDescription` to
`info.description`, but Windows renders that field as the executable's display
name. `info.description` keeps its real sentence for every other consumer.

Icons are regenerated from `appicon.png` alone:

```sh
wails3 generate icons -input build/appicon.png \
  -macfilename build/darwin/icons.icns \
  -windowsfilename build/windows/icon.ico
```

## Packaging scope

Issue #273 migrated the desktop build only. DMG, AppImage, deb/rpm/Arch, NSIS,
and MSIX targets are deliberately not maintained: neither the release workflow
nor any shipped artifact uses them. The macOS `.app` bundle is the only package
format produced by these Taskfiles.
