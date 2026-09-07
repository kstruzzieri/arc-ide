/**
 * Test: CI/CD Configuration
 *
 * These tests verify GitHub Actions workflows are properly configured.
 * TDD: Written first to define expected behavior.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'yaml';

const rootDir = resolve(__dirname, '../../..');
const workflowsDir = resolve(rootDir, '.github/workflows');

function workflowSteps(content: string): string[][] {
  const lines = content.split(/\r?\n/);
  const steps: string[][] = [];

  for (let start = 0; start < lines.length; start += 1) {
    const stepStart = lines[start].match(/^(\s*)-\s+(?:name|uses|run):/);
    if (!stepStart) continue;

    const indent = stepStart[1].length;
    let end = start + 1;
    while (end < lines.length) {
      const nextStep = lines[end].match(/^(\s*)-\s+/);
      const nextContent = lines[end].match(/^(\s*)\S/);
      if (nextStep?.[1].length === indent || (nextContent && nextContent[1].length < indent)) break;
      end += 1;
    }

    steps.push(lines.slice(start, end));
    start = end - 1;
  }

  return steps;
}

type WorkflowEvent = Record<string, unknown> | null;

function workflowEvents(content: string): Record<string, WorkflowEvent> {
  return (parse(content) as { on?: Record<string, WorkflowEvent> }).on ?? {};
}

function workflowBranchFilters(content: string, event: string): string[] {
  const config = workflowEvents(content)[event];
  return config
    ? ['branches', 'branches-ignore'].filter((filter) => Object.hasOwn(config, filter))
    : [];
}

describe('CI Workflow', () => {
  it('should have test.yml workflow', () => {
    expect(existsSync(resolve(workflowsDir, 'test.yml'))).toBe(true);
  });

  it('should have lint.yml workflow', () => {
    expect(existsSync(resolve(workflowsDir, 'lint.yml'))).toBe(true);
  });

  it('should have build.yml workflow', () => {
    expect(existsSync(resolve(workflowsDir, 'build.yml'))).toBe(true);
  });

  // The setup-go count below would also break if this job were deleted, but it
  // would break citing step counts. Assert the thing we actually care about so
  // the failure names it: the path-portability suites must run on Windows.
  it('should run the path-sensitive Go suites on Windows', () => {
    const testYml = readFileSync(resolve(workflowsDir, 'test.yml'), 'utf-8');

    expect(testYml).toMatch(/runs-on:\s*windows-latest/);
    for (const pkg of ['./internal/filesystem', './internal/runhistory', './internal/workspace']) {
      expect(testYml).toContain(pkg);
    }
  });

  // `pull_request.branches` matches the PR's BASE branch, so a [main, develop]
  // filter silently gives stacked PRs zero checks -- no red X, just a mergeable
  // "no checks reported". Nothing else fails when this regresses, so assert it
  // for every workflow file, current or future. The three CI workflows also
  // may not path-filter: branch protection requires their checks, and a
  // filtered-out PR never reports them -- it would sit "Expected" forever and
  // be unmergeable.
  it('should run the CI workflows on pull requests regardless of base branch', () => {
    for (const file of ['test.yml', 'build.yml', 'lint.yml']) {
      const content = readFileSync(resolve(workflowsDir, file), 'utf-8');
      const events = workflowEvents(content);
      const pullRequest = events.pull_request;

      expect({ file, hasPullRequestTrigger: Object.hasOwn(events, 'pull_request') }).toEqual({
        file,
        hasPullRequestTrigger: true,
      });
      expect({
        file,
        pathFilters: pullRequest
          ? ['paths', 'paths-ignore'].filter((filter) => Object.hasOwn(pullRequest, filter))
          : [],
      }).toEqual({ file, pathFilters: [] });
    }

    for (const file of readdirSync(workflowsDir).filter((entry) => /\.ya?ml$/.test(entry))) {
      const content = readFileSync(resolve(workflowsDir, file), 'utf-8');

      expect({
        file,
        baseBranchFilters: workflowBranchFilters(content, 'pull_request').length,
      }).toEqual({ file, baseBranchFilters: 0 });
    }
  });

  it.each([
    {
      format: 'a quoted filter key',
      content: "name: fixture\non:\n  pull_request:\n    'branches': [main, develop]\n",
      filter: 'branches',
    },
    {
      format: 'CRLF line endings',
      content: ['name: fixture', 'on:', '  pull_request:', '    branches-ignore: [main]'].join(
        '\r\n'
      ),
      filter: 'branches-ignore',
    },
  ])('should detect pull-request branch filters with $format', ({ content, filter }) => {
    expect(workflowBranchFilters(content, 'pull_request')).toEqual([filter]);
  });

  // Counterpart to the filter above: `push` must stay scoped to the long-lived
  // branches. Widening it would run every feature-branch push twice -- once for
  // the push, once for the PR's synchronize event.
  it('should keep the push trigger scoped to the long-lived branches', () => {
    for (const file of ['test.yml', 'build.yml', 'lint.yml']) {
      const content = readFileSync(resolve(workflowsDir, file), 'utf-8');
      const push = workflowEvents(content).push;

      expect({ file, branches: push?.branches }).toEqual({
        file,
        branches: ['main', 'develop'],
      });
    }
  });

  it('should resolve every setup-go step from the Go version required by go.mod', () => {
    const goMod = readFileSync(resolve(rootDir, 'go.mod'), 'utf-8');
    const goVersion = goMod.match(/^go\s+(\d+\.\d+)/m)?.[1];
    const workflowFiles = readdirSync(workflowsDir).filter((file) => /\.ya?ml$/.test(file));
    const expectedSetupGoSteps: Record<string, number> = {
      'build.yml': 1,
      'lint.yml': 1,
      'release.yml': 3,
      'test.yml': 2,
    };

    expect(goVersion).toBeDefined();

    for (const file of workflowFiles) {
      const content = readFileSync(resolve(workflowsDir, file), 'utf-8');
      const setupGoSteps = workflowSteps(content).filter((step) =>
        step.some((line) =>
          /^\s*(?:-\s*)?uses:\s*['"]?actions\/setup-go@[^'"\s]+['"]?\s*$/.test(line)
        )
      );
      const expectedCount = expectedSetupGoSteps[file] ?? 0;

      expect({ file, setupGoSteps: setupGoSteps.length }).toEqual({
        file,
        setupGoSteps: expectedCount,
      });

      for (const step of setupGoSteps) {
        const withIndex = step.findIndex((line) => /^\s*with:\s*$/.test(line));
        const withIndent = withIndex >= 0 ? step[withIndex].match(/^(\s*)/)?.[1].length : undefined;
        const afterWith = withIndex >= 0 ? step.slice(withIndex + 1) : [];
        const inputEnd =
          withIndent === undefined
            ? 0
            : afterWith.findIndex((line) => {
                if (!line.trim() || line.trimStart().startsWith('#')) return false;
                return (line.match(/^(\s*)/)?.[1].length ?? 0) <= withIndent;
              });
        const inputs = afterWith.slice(0, inputEnd < 0 ? undefined : inputEnd);

        expect({
          file,
          versionFiles: inputs.filter((line) =>
            /^\s*go-version-file:\s*['"]?go\.mod['"]?\s*$/.test(line)
          ).length,
          literalVersions: inputs.filter((line) => /^\s*go-version:\s*/.test(line)).length,
        }).toEqual({
          file,
          versionFiles: 1,
          literalVersions: 0,
        });
      }
    }
  });

  it('should pin workflow wails3 installs to the module version', () => {
    const goMod = readFileSync(resolve(rootDir, 'go.mod'), 'utf-8');
    const wailsVersion = goMod.match(/^\s*github\.com\/wailsapp\/wails\/v3\s+(v\S+)/m)?.[1];
    expect(wailsVersion).toBeDefined();

    const workflowFiles = readdirSync(workflowsDir).filter((file) => /\.ya?ml$/.test(file));
    const installVersions = workflowFiles.flatMap((file) => {
      const content = readFileSync(resolve(workflowsDir, file), 'utf-8');
      return [...content.matchAll(/github\.com\/wailsapp\/wails\/v3\/cmd\/wails3@(\S+)/g)].map(
        (m) => m[1]
      );
    });
    expect(installVersions.length).toBeGreaterThan(0);
    expect(new Set(installVersions)).toEqual(new Set([wailsVersion]));
  });

  it('should pin @wailsio/runtime to the wails module version exactly', () => {
    const goMod = readFileSync(resolve(rootDir, 'go.mod'), 'utf-8');
    const wailsVersion = goMod.match(/^\s*github\.com\/wailsapp\/wails\/v3\s+(v\S+)/m)?.[1];
    const npmVersion = wailsVersion?.replace(/^v/, '');

    const pkg = JSON.parse(readFileSync(resolve(rootDir, 'frontend/package.json'), 'utf-8'));
    expect(pkg.dependencies['@wailsio/runtime']).toBe(npmVersion);

    const lock = JSON.parse(readFileSync(resolve(rootDir, 'frontend/package-lock.json'), 'utf-8'));
    expect(lock.packages['node_modules/@wailsio/runtime'].version).toBe(npmVersion);
  });

  // #273 (v2 -> v3 migration): package main now imports wailsapp/wails/v3, so
  // a stray v2 reference anywhere in the workflows would mean a job is
  // building or asserting against the wrong SDK line.
  it('should not reference the Wails v2 SDK in any workflow', () => {
    const workflowFiles = readdirSync(workflowsDir).filter((file) => /\.ya?ml$/.test(file));

    let scannedFiles = 0;
    for (const file of workflowFiles) {
      const content = readFileSync(resolve(workflowsDir, file), 'utf-8');
      expect({ file, hasV2Reference: /wailsapp\/wails\/v2|wails@v2/.test(content) }).toEqual({
        file,
        hasV2Reference: false,
      });
      scannedFiles += 1;
    }

    // A loop that only asserts inside its body passes vacuously if the
    // workflows directory is ever empty or unreadable -- assert it actually
    // scanned something.
    expect(scannedFiles).toBeGreaterThan(0);
  });

  // The v3 Linux ABI is CGO build-tag gated: without -tags gtk3, package main
  // compiles against the GTK4 path Firn does not ship (see build/linux and
  // .golangci.yml), so any job that compiles Go on a ubuntu runner must
  // either pass the tag directly, inherit it from .golangci.yml, or delegate
  // to the linux:build Task (which supplies it by default). The wails3 CLI
  // itself is also gtk3-gated on Linux (it links WebKit directly), so a
  // `go install ... cmd/wails3` step counts too.
  //
  // The runner pin is the other half of the same contract: the ubuntu-22.04
  // image IS the WebKit2GTK 4.1 compatibility floor those tags target, so no
  // job anywhere may ride the moving `ubuntu-latest` label, and every job
  // that installs the GTK dev packages or produces the Linux binary must name
  // 22.04 explicitly.
  it('should pin the Linux runners and pass the gtk3 build tag wherever a Linux job compiles Go', () => {
    const golangciConfig = readFileSync(resolve(rootDir, '.golangci.yml'), 'utf-8');
    const golangciBuildTags =
      (parse(golangciConfig) as { run?: { 'build-tags'?: string[] } }).run?.['build-tags'] ?? [];
    const golangciHasGtk3Tag = golangciBuildTags.includes('gtk3');

    const goCompileMarkers = [
      'go test',
      'go build',
      'go vet',
      'golangci-lint',
      'wails3 task linux:build',
    ];
    const workflowFiles = readdirSync(workflowsDir).filter((file) => /\.ya?ml$/.test(file));
    let matchedSteps = 0;
    let gtkFloorJobs = 0;

    for (const file of workflowFiles) {
      const content = readFileSync(resolve(workflowsDir, file), 'utf-8');
      const workflow = parse(content) as {
        jobs?: Record<
          string,
          { 'runs-on'?: unknown; steps?: Array<{ run?: string; uses?: string }> }
        >;
      };

      for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        const runsOn = job['runs-on'];
        const steps = job.steps ?? [];
        const stepTexts = steps.map((step) =>
          [step.run, step.uses].filter((value): value is string => Boolean(value)).join('\n')
        );

        // `runs-on` must be a plain string literal: an expression
        // (`${{ matrix.os }}`), an array, or an object form could carry
        // 'ubuntu-latest' while dodging a strict `=== 'ubuntu-latest'` check.
        const runsOnIsLiteralString = typeof runsOn === 'string' && !runsOn.includes('${{');
        expect({ file, job: jobName, runsOnIsLiteralString }).toEqual({
          file,
          job: jobName,
          runsOnIsLiteralString: true,
        });

        expect({
          file,
          job: jobName,
          ridesUbuntuLatest: JSON.stringify(runsOn).includes('ubuntu-latest'),
        }).toEqual({
          file,
          job: jobName,
          ridesUbuntuLatest: false,
        });

        if (typeof runsOn !== 'string' || !runsOn.startsWith('ubuntu')) continue;

        const needsGtkFloor = stepTexts.some(
          (text) =>
            text.includes('libwebkit2gtk-4.1-dev') || text.includes('wails3 task linux:build')
        );
        if (needsGtkFloor) {
          gtkFloorJobs += 1;
          expect({ file, job: jobName, runsOn }).toEqual({
            file,
            job: jobName,
            runsOn: 'ubuntu-22.04',
          });
        }

        for (const step of steps) {
          const stepText = [step.run, step.uses]
            .filter((value): value is string => Boolean(value))
            .join('\n');
          const isWailsCliInstall =
            stepText.includes('go install') && stepText.includes('cmd/wails3');
          const compilesGo =
            goCompileMarkers.some((marker) => stepText.includes(marker)) || isWailsCliInstall;
          if (!compilesGo) continue;
          matchedSteps += 1;

          const isLinuxTaskBuild = stepText.includes('wails3 task linux:build');
          const isGolangci = stepText.includes('golangci-lint');
          const hasTagArg = /-tags[= ]\S*gtk3\b/.test(stepText);
          const tagged = isLinuxTaskBuild || (isGolangci ? golangciHasGtk3Tag : hasTagArg);

          expect({ file, job: jobName, step: step.run ?? step.uses, tagged }).toEqual({
            file,
            job: jobName,
            step: step.run ?? step.uses,
            tagged: true,
          });
        }
      }
    }

    // A loop that only asserts inside its body passes vacuously if nothing
    // ever matches, so both counts are exact censuses rather than floors.
    //
    // Seven Go-compiling Linux steps: test.yml backend-tests (two `go test`
    // steps), lint.yml golangci-lint, the `go install ... cmd/wails3` and
    // `wails3 task linux:build` steps in build.yml, and the same two in
    // release.yml's build-linux job.
    expect(matchedSteps).toBe(7);
    // Four jobs sit on the WebKit2GTK floor: build.yml build, test.yml
    // backend-tests, lint.yml golangci-lint, release.yml build-linux.
    expect(gtkFloorJobs).toBe(4);
  });

  // generate:bindings runs with -clean=true, so a Go-facing API or exported
  // model shape that changed without regenerating frontend/bindings would
  // otherwise ship silently -- nothing else in CI would catch it.
  it('should verify committed bindings are current after build.yml builds Linux', () => {
    const content = readFileSync(resolve(workflowsDir, 'build.yml'), 'utf-8');
    const workflow = parse(content) as {
      jobs?: Record<string, { steps?: Array<{ run?: string }> }>;
    };
    const steps = workflow.jobs?.build?.steps ?? [];
    const buildStepIndex = steps.findIndex((step) => step.run?.includes('wails3 task linux:build'));

    expect(buildStepIndex).toBeGreaterThanOrEqual(0);

    const driftCheck = steps.slice(buildStepIndex + 1).find((step) => {
      const run = step.run;
      return (
        typeof run === 'string' &&
        run.includes('git status --porcelain -- frontend/bindings') &&
        run.includes('test -z')
      );
    });

    expect(driftCheck).toBeDefined();
  });
});

describe('Release Workflow', () => {
  it('should have release.yml workflow', () => {
    expect(existsSync(resolve(workflowsDir, 'release.yml'))).toBe(true);
  });

  it('should trigger on version tags', () => {
    const releaseYml = readFileSync(resolve(workflowsDir, 'release.yml'), 'utf-8');
    expect(releaseYml).toMatch(/tags:\s*\n\s*-\s*['"]?v/);
  });

  it('should build for macOS', () => {
    const releaseYml = readFileSync(resolve(workflowsDir, 'release.yml'), 'utf-8');
    expect(releaseYml).toMatch(/macos|darwin/i);
  });

  it('should build for Linux', () => {
    const releaseYml = readFileSync(resolve(workflowsDir, 'release.yml'), 'utf-8');
    expect(releaseYml).toMatch(/linux|ubuntu/i);
  });

  it('should use the tested release-note and checksum scripts', () => {
    const releaseYml = readFileSync(resolve(workflowsDir, 'release.yml'), 'utf-8');

    expect(releaseYml).toContain('.github/scripts/extract-changelog.sh');
    expect(releaseYml).toContain('.github/scripts/generate-checksums.sh');
    expect(releaseYml).toContain('SHA256SUMS');
  });

  it('should feed build/config.yml to the changelog script', () => {
    const releaseYml = readFileSync(resolve(workflowsDir, 'release.yml'), 'utf-8');
    expect(releaseYml).toContain('build/config.yml');
    expect(releaseYml).not.toContain('wails.json');
  });

  it('should keep dispatch read-only and publish only from tag pushes', () => {
    const releaseYml = readFileSync(resolve(workflowsDir, 'release.yml'), 'utf-8');
    const workflow = parse(releaseYml) as {
      on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
      permissions?: Record<string, string>;
      jobs?: Record<string, { if?: string; permissions?: Record<string, string> }>;
    };

    expect(workflow.on?.workflow_dispatch?.inputs).toHaveProperty('release_tag');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs?.release?.if).toBe("github.event_name == 'push'");
    expect(workflow.jobs?.release?.permissions).toEqual({ contents: 'write' });
  });

  it('should verify archive root entries', () => {
    const releaseYml = readFileSync(resolve(workflowsDir, 'release.yml'), 'utf-8');
    expect(releaseYml).toContain('.github/scripts/verify-archive-roots.sh');
  });
});

describe('Lint Workflow', () => {
  it('should run ESLint', () => {
    const lintYml = readFileSync(resolve(workflowsDir, 'lint.yml'), 'utf-8');
    expect(lintYml).toMatch(/eslint|npm run lint/i);
  });

  it('should run golangci-lint', () => {
    const lintYml = readFileSync(resolve(workflowsDir, 'lint.yml'), 'utf-8');
    expect(lintYml).toMatch(/golangci-lint/i);
  });
});

describe('Changelog', () => {
  it('should have CHANGELOG.md', () => {
    expect(existsSync(resolve(rootDir, 'CHANGELOG.md'))).toBe(true);
  });
});
