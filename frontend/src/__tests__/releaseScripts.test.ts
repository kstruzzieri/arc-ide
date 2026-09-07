import { createHash } from 'crypto';
import { spawnSync, execFileSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { parse } from 'yaml';

const rootDir = resolve(__dirname, '../../..');
const releaseScriptsDir = resolve(rootDir, '.github/scripts');

function withTempDir(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'firn-release-test-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeExecutable(path: string, content: string) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

// The release version is read from frontend/package.json, the same file the
// extraction script gates on, so cutting a release does not require editing
// these expectations. Cases that must pin a specific version use fixtures.
const releaseVersion = JSON.parse(readFileSync(resolve(rootDir, 'frontend/package.json'), 'utf8'))
  .version as string;

function writeVersionFixtures(dir: string, version: string) {
  const packageJson = join(dir, 'package.json');
  const configYml = join(dir, 'config.yml');
  writeFileSync(packageJson, `{"version":"${version}"}\n`);
  writeFileSync(configYml, `version: '3'\ninfo:\n  version: '${version}'\n`);
  return { packageJson, configYml };
}

describe('release changelog extraction', () => {
  const script = resolve(releaseScriptsDir, 'extract-changelog.sh');
  const changelog = resolve(rootDir, 'CHANGELOG.md');
  const packageJson = resolve(rootDir, 'frontend/package.json');
  const configYml = resolve(rootDir, 'build/config.yml');

  it('extracts the live section for the current version without bleeding into the prior release', () => {
    withTempDir((dir) => {
      const output = join(dir, 'notes.md');

      // The rc form skips the Pending check, so this passes on a release
      // branch whose entry is not dated yet and still exercises the live
      // CHANGELOG, package.json, and config.yml against each other.
      execFileSync('sh', [
        script,
        `v${releaseVersion}-rc.1`,
        changelog,
        output,
        packageJson,
        configYml,
      ]);

      const notes = readFileSync(output, 'utf8');
      expect(notes.trim()).not.toBe('');
      // Every curated section in this file groups its entries under `###`
      // headings; asserting one proves the body was extracted, not just
      // the lead paragraph.
      expect(notes).toMatch(/^### /m);
      expect(notes).not.toMatch(/^## \[/m);
      // Text that only ever appeared in earlier sections of the same file.
      expect(notes).not.toContain('Stabilization release');
      expect(notes).not.toContain('Milestone 7: Git integration');
    });
  });

  it('rejects a final tag while its changelog date is Pending', () => {
    withTempDir((dir) => {
      // Fixtures rather than the live files, so this stays valid both before
      // and after a release dates its own entry.
      const pendingChangelog = join(dir, 'CHANGELOG.md');
      writeFileSync(
        pendingChangelog,
        '# Changelog\n\n## [9.9.9] - Pending\n\nFixture entry.\n\n## [9.9.8] - 2026-01-01\n\nPrior.\n'
      );
      const fixtures = writeVersionFixtures(dir, '9.9.9');
      const result = spawnSync(
        'sh',
        [
          script,
          'v9.9.9',
          pendingChangelog,
          join(dir, 'notes.md'),
          fixtures.packageJson,
          fixtures.configYml,
        ],
        { encoding: 'utf8' }
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('replace Pending with the release date');
    });
  });

  it('accepts a final tag once the changelog entry is dated', () => {
    withTempDir((dir) => {
      const datedChangelog = join(dir, 'CHANGELOG.md');
      writeFileSync(
        datedChangelog,
        '# Changelog\n\n## [9.9.9] - 2026-01-02\n\nFixture entry.\n\n## [9.9.8] - 2026-01-01\n\nPrior.\n'
      );
      const fixtures = writeVersionFixtures(dir, '9.9.9');
      const output = join(dir, 'notes.md');

      execFileSync('sh', [
        script,
        'v9.9.9',
        datedChangelog,
        output,
        fixtures.packageJson,
        fixtures.configYml,
      ]);

      const notes = readFileSync(output, 'utf8');
      expect(notes.trim()).not.toBe('');
      expect(notes).toContain('Fixture entry.');
      expect(notes).not.toContain('Prior.');
    });
  });

  it('rejects release metadata that does not match the tag version', () => {
    withTempDir((dir) => {
      const stalePackage = join(dir, 'package.json');
      writeFileSync(stalePackage, '{"version":"0.0.1"}\n');
      const result = spawnSync(
        'sh',
        [
          script,
          `v${releaseVersion}-rc.1`,
          changelog,
          join(dir, 'notes.md'),
          stalePackage,
          configYml,
        ],
        { encoding: 'utf8' }
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        `package version 0.0.1 does not match tag v${releaseVersion}-rc.1`
      );
    });
  });

  it('rejects a Wails product version that does not match the tag', () => {
    withTempDir((dir) => {
      const staleConfig = join(dir, 'config.yml');
      writeFileSync(staleConfig, "version: '3'\ninfo:\n  version: '1.0.0'\n");
      const result = spawnSync(
        'sh',
        [
          script,
          `v${releaseVersion}-rc.1`,
          changelog,
          join(dir, 'notes.md'),
          packageJson,
          staleConfig,
        ],
        { encoding: 'utf8' }
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        `config.yml info.version 1.0.0 does not match tag v${releaseVersion}-rc.1`
      );
    });
  });
});

describe('release version consistency', () => {
  it('keeps the Wails product version in lockstep with the frontend package version', () => {
    const packageVersion = JSON.parse(
      readFileSync(resolve(rootDir, 'frontend/package.json'), 'utf8')
    ).version;
    const config = parse(readFileSync(resolve(rootDir, 'build/config.yml'), 'utf8'));

    expect(config.info?.version).toBe(packageVersion);
  });

  it('keeps a four-part Windows assembly version derived from the config version', () => {
    const config = parse(readFileSync(resolve(rootDir, 'build/config.yml'), 'utf8'));
    const manifest = readFileSync(resolve(rootDir, 'build/windows/wails.exe.manifest'), 'utf8');
    // `wails3 update build-assets` re-emits a 3-part version here; Win32
    // assemblyIdentity is major.minor.build.revision and the manifest is
    // embedded into firn.exe by windows:generate:syso.
    const version = manifest.match(
      new RegExp(
        `<assemblyIdentity[^>]*name="${config.info.productIdentifier}"[^>]*version="([^"]+)"`
      )
    )?.[1];

    expect(version).toBe(`${config.info.version}.0`);
    expect(version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  // build/config.yml info.version is baked verbatim into these platform asset
  // files by `wails3 task common:update:build-assets`; nothing re-derives
  // them at build time, so a version bump that skips regeneration ships a
  // mismatched packaged version with no other gate to catch it.
  function plistValue(plist: string, key: string): string | undefined {
    return plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1];
  }

  it('keeps the macOS Info.plist bundle version in lockstep with the config version', () => {
    const config = parse(readFileSync(resolve(rootDir, 'build/config.yml'), 'utf8'));
    const plist = readFileSync(resolve(rootDir, 'build/darwin/Info.plist'), 'utf8');

    expect(plistValue(plist, 'CFBundleShortVersionString')).toBe(config.info.version);
    expect(plistValue(plist, 'CFBundleVersion')).toBe(config.info.version);
  });

  it('keeps the macOS dev Info.plist bundle version in lockstep with the config version', () => {
    const config = parse(readFileSync(resolve(rootDir, 'build/config.yml'), 'utf8'));
    const plist = readFileSync(resolve(rootDir, 'build/darwin/Info.dev.plist'), 'utf8');

    expect(plistValue(plist, 'CFBundleShortVersionString')).toBe(config.info.version);
    expect(plistValue(plist, 'CFBundleVersion')).toBe(config.info.version);
  });

  it('keeps the Windows info.json version in lockstep with the config version', () => {
    const config = parse(readFileSync(resolve(rootDir, 'build/config.yml'), 'utf8'));
    const info = JSON.parse(readFileSync(resolve(rootDir, 'build/windows/info.json'), 'utf8'));

    expect(info.fixed.file_version).toBe(config.info.version);
    expect(info.info['0000'].ProductVersion).toBe(config.info.version);
  });

  // Identity, not just version, is duplicated into the generated assets and
  // never re-derived at build time. The mapping below is the one the pinned
  // beta.16 templates implement ($GOMODCACHE/github.com/wailsapp/wails/
  // v3@v3.0.0-beta.16/internal/commands/updatable_build_assets/):
  //   darwin/Info.plist.tmpl, darwin/Info.dev.plist.tmpl
  //     CFBundleName             <- info.productName
  //     CFBundleIdentifier       <- info.productIdentifier
  //     CFBundleGetInfoString    <- info.comments
  //     NSHumanReadableCopyright <- info.copyright
  //     CFBundleExecutable       <- the -binaryname flag, not config
  //     LSMinimumSystemVersion   <- a literal in the template, not config
  //   windows/info.json.tmpl
  //     ProductName     <- info.productName
  //     CompanyName     <- info.companyName
  //     LegalCopyright  <- info.copyright
  //     Comments        <- info.comments
  //     FileDescription <- info.description, which build/Taskfile.yml
  //                        overrides with -productdescription <productName>
  //   windows/wails.exe.manifest.tmpl
  //     assemblyIdentity name <- info.productIdentifier
  // Only what the templates actually map is asserted here.
  it.each(['Info.plist', 'Info.dev.plist'])(
    'keeps the macOS %s identity in lockstep with the config info block',
    (file) => {
      const config = parse(readFileSync(resolve(rootDir, 'build/config.yml'), 'utf8'));
      const plist = readFileSync(resolve(rootDir, 'build/darwin', file), 'utf8');

      expect({
        bundleName: plistValue(plist, 'CFBundleName'),
        bundleIdentifier: plistValue(plist, 'CFBundleIdentifier'),
        getInfoString: plistValue(plist, 'CFBundleGetInfoString'),
        copyright: plistValue(plist, 'NSHumanReadableCopyright'),
      }).toEqual({
        bundleName: config.info.productName,
        bundleIdentifier: config.info.productIdentifier,
        getInfoString: config.info.comments,
        copyright: config.info.copyright,
      });
    }
  );

  it('keeps the Windows info.json identity in lockstep with the config info block', () => {
    const config = parse(readFileSync(resolve(rootDir, 'build/config.yml'), 'utf8'));
    const info = JSON.parse(readFileSync(resolve(rootDir, 'build/windows/info.json'), 'utf8'));

    expect({
      productName: info.info['0000'].ProductName,
      companyName: info.info['0000'].CompanyName,
      copyright: info.info['0000'].LegalCopyright,
      comments: info.info['0000'].Comments,
      // Windows renders FileDescription as the executable's display name
      // (Task Manager, the .exe properties sheet), where v2 shipped the
      // product name rather than the description sentence. Regeneration keeps
      // producing it because build/Taskfile.yml passes -productdescription.
      fileDescription: info.info['0000'].FileDescription,
    }).toEqual({
      productName: config.info.productName,
      companyName: config.info.companyName,
      copyright: config.info.copyright,
      comments: config.info.comments,
      fileDescription: config.info.productName,
    });
  });

  it('keeps the Windows manifest assembly name in lockstep with the config product identifier', () => {
    const config = parse(readFileSync(resolve(rootDir, 'build/config.yml'), 'utf8'));
    const manifest = readFileSync(resolve(rootDir, 'build/windows/wails.exe.manifest'), 'utf8');
    // The first assemblyIdentity is the application's own; the second is the
    // Microsoft.Windows.Common-Controls dependency.
    const name = manifest.match(/<assemblyIdentity[^>]*\bname="([^"]+)"/)?.[1];

    expect(name).toBe(config.info.productIdentifier);
  });

  it('keeps the macOS deployment target in lockstep with the plist minimum system version', () => {
    const darwinTasks = parse(
      readFileSync(resolve(rootDir, 'build/darwin/Taskfile.yml'), 'utf8')
    ) as { tasks: Record<string, { env?: Record<string, string> }> };
    const target = darwinTasks.tasks['build:native'].env?.MACOSX_DEPLOYMENT_TARGET;
    // The Taskfile carries the compiler's two-part form (12.0); the plists
    // carry Apple's three-part form (12.0.0). Pad both to major.minor.patch
    // so the comparison is on the version, not its spelling.
    const normalise = (value: string) => `${value}.0.0`.split('.').slice(0, 3).join('.');

    expect(target).toBeDefined();
    for (const file of ['Info.plist', 'Info.dev.plist']) {
      const plist = readFileSync(resolve(rootDir, 'build/darwin', file), 'utf8');

      expect({
        file,
        minimumSystemVersion: normalise(plistValue(plist, 'LSMinimumSystemVersion') ?? ''),
      }).toEqual({ file, minimumSystemVersion: normalise(String(target)) });
    }
  });
});

describe('release checksums', () => {
  it('generates one deterministic SHA-256 entry per release archive', () => {
    withTempDir((dir) => {
      const artifacts = join(dir, 'artifacts');
      mkdirSync(join(artifacts, 'macos'), { recursive: true });
      mkdirSync(join(artifacts, 'linux'), { recursive: true });
      const files = [
        ['macos/Firn-macos-arm64.zip', 'mac'],
        ['linux/Firn-linux-amd64.tar.gz', 'linux'],
      ] as const;
      for (const [name, content] of files) writeFileSync(join(artifacts, name), content);
      const output = join(dir, 'SHA256SUMS');

      execFileSync('sh', [resolve(releaseScriptsDir, 'generate-checksums.sh'), artifacts, output]);

      const lines = readFileSync(output, 'utf8').trim().split('\n');
      expect(lines).toEqual(
        [...files]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, content]) => {
            const digest = createHash('sha256').update(content).digest('hex');
            return `${digest}  ${name.split('/').at(-1)}`;
          })
      );
    });
  });
});

describe('archive root verification', () => {
  const script = resolve(releaseScriptsDir, 'verify-archive-roots.sh');

  // Builds all four frozen release archives (two macOS zips rooted at
  // Firn.app, a Linux tarball rooted at firn, a Windows zip rooted at
  // firn.exe) under artifacts/<name>/<file>, matching what
  // actions/download-artifact lays out from the upload names in release.yml.
  // These shell out to `zip` and `tar` on purpose: the script under test
  // reads real archives, so a hand-rolled fixture would test the fixture.
  // Both tools are preinstalled on the ubuntu-22.04 image that runs the
  // frontend suite (test.yml) and on macOS, so the dependency costs nothing.
  function buildValidArtifacts(dir: string): string {
    const artifacts = join(dir, 'artifacts');

    for (const arch of ['arm64', 'amd64']) {
      const targetDir = join(artifacts, `Firn-macos-${arch}`);
      const appDir = join(targetDir, 'Firn.app', 'Contents');
      mkdirSync(appDir, { recursive: true });
      writeFileSync(join(appDir, 'Info.plist'), 'fixture');
      execFileSync('zip', ['-r', `Firn-macos-${arch}.zip`, 'Firn.app'], { cwd: targetDir });
      rmSync(join(targetDir, 'Firn.app'), { recursive: true, force: true });
    }

    const linuxDir = join(artifacts, 'Firn-linux-amd64');
    mkdirSync(linuxDir, { recursive: true });
    writeFileSync(join(linuxDir, 'firn'), 'fixture');
    execFileSync('tar', ['-czf', 'Firn-linux-amd64.tar.gz', 'firn'], { cwd: linuxDir });
    rmSync(join(linuxDir, 'firn'));

    const windowsDir = join(artifacts, 'Firn-windows-amd64');
    mkdirSync(windowsDir, { recursive: true });
    writeFileSync(join(windowsDir, 'firn.exe'), 'fixture');
    execFileSync('zip', ['Firn-windows-amd64.zip', 'firn.exe'], { cwd: windowsDir });
    rmSync(join(windowsDir, 'firn.exe'));

    return artifacts;
  }

  it('accepts the frozen archive-root contract for all four release targets', () => {
    withTempDir((dir) => {
      const artifacts = buildValidArtifacts(dir);

      const result = spawnSync('sh', [script, artifacts], { encoding: 'utf8' });

      expect(result.status).toBe(0);
    });
  });

  it('rejects an archive that carries an unexpected second top-level entry', () => {
    withTempDir((dir) => {
      const artifacts = buildValidArtifacts(dir);
      const linuxDir = join(artifacts, 'Firn-linux-amd64');
      writeFileSync(join(linuxDir, 'firn'), 'fixture');
      writeFileSync(join(linuxDir, 'stray-file'), 'unexpected');
      execFileSync('tar', ['-czf', 'Firn-linux-amd64.tar.gz', 'firn', 'stray-file'], {
        cwd: linuxDir,
      });

      const result = spawnSync('sh', [script, artifacts], { encoding: 'utf8' });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('unexpected archive roots');
    });
  });
});

describe('installer integrity verification', () => {
  const ASSET_NAME = 'Firn-linux-amd64.tar.gz';

  // Stub uname (report Linux/amd64), curl (serve the fixture asset + manifest),
  // and tar (record that extraction was reached). tar exits non-zero on purpose
  // so the run stops at extraction regardless of the host's install target.
  function writeLinuxInstallerStubs(bin: string) {
    writeExecutable(
      join(bin, 'uname'),
      '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Linux; else echo x86_64; fi\n'
    );
    writeExecutable(
      join(bin, 'curl'),
      `#!/bin/sh
out=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
case "$url" in
  *SHA256SUMS) cp "$FIXTURE_MANIFEST" "$out" ;;
  *) cp "$FIXTURE_ASSET" "$out" ;;
esac
`
    );
    writeExecutable(join(bin, 'tar'), '#!/bin/sh\ntouch "$TAR_SENTINEL"\nexit 1\n');
  }

  function runInstaller(dir: string, assetContent: string, manifestBody: string) {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const asset = join(dir, 'asset.tar.gz');
    const manifest = join(dir, 'SHA256SUMS');
    const tarSentinel = join(dir, 'tar-called');
    writeFileSync(asset, assetContent);
    writeFileSync(manifest, manifestBody);
    writeLinuxInstallerStubs(bin);

    const result = spawnSync('sh', [resolve(rootDir, 'install.sh')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FIRN_VERSION: 'v0.11.0',
        FIXTURE_ASSET: asset,
        FIXTURE_MANIFEST: manifest,
        TAR_SENTINEL: tarSentinel,
      },
    });

    return { result, tarReached: existsSync(tarSentinel) };
  }

  function sha256(content: string) {
    return createHash('sha256').update(content).digest('hex');
  }

  it('rejects a checksum mismatch before extracting the downloaded asset', () => {
    withTempDir((dir) => {
      const { result, tarReached } = runInstaller(
        dir,
        'tampered archive',
        `${'0'.repeat(64)}  ${ASSET_NAME}\n`
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('checksum mismatch');
      expect(tarReached).toBe(false);
    });
  });

  it('rejects a manifest with no entry for the requested asset', () => {
    withTempDir((dir) => {
      const asset = 'valid archive';
      const { result, tarReached } = runInstaller(
        dir,
        asset,
        `${sha256(asset)}  Firn-macos-arm64.zip\n`
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('checksum entry missing or duplicated');
      expect(tarReached).toBe(false);
    });
  });

  it('proceeds to extraction once the checksum matches', () => {
    withTempDir((dir) => {
      const asset = 'valid archive';
      const { result, tarReached } = runInstaller(dir, asset, `${sha256(asset)}  ${ASSET_NAME}\n`);

      expect(tarReached).toBe(true);
      expect(result.stderr).not.toContain('checksum mismatch');
      expect(result.stderr).toContain('extract failed');
    });
  });
});
