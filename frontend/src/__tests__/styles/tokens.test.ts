import { readFileSync } from 'fs';
import { resolve } from 'path';
import { WORKSPACE_ACCENTS } from '../../utils/accent';
import { cssRule } from '../helpers/cssRule';

const css = readFileSync(resolve(__dirname, '../../styles/tokens.css'), 'utf8');
const terminalCss = readFileSync(
  resolve(__dirname, '../../components/Terminal/Terminal.module.css'),
  'utf8'
);
const treeRowCss = readFileSync(
  resolve(__dirname, '../../components/FileExplorer/TreeRow.module.css'),
  'utf8'
);
const fileExplorerCss = readFileSync(
  resolve(__dirname, '../../components/FileExplorer/FileExplorer.module.css'),
  'utf8'
);
const editorCss = readFileSync(
  resolve(__dirname, '../../components/Editor/Editor.module.css'),
  'utf8'
);
const mergeResolutionCss = readFileSync(
  resolve(__dirname, '../../components/Editor/MergeResolutionView.module.css'),
  'utf8'
);
const panelRailCss = readFileSync(
  resolve(__dirname, '../../components/layout/PanelRail.module.css'),
  'utf8'
);
const panelCommandBarCss = readFileSync(
  resolve(__dirname, '../../components/layout/PanelCommandBar.module.css'),
  'utf8'
);
const statusBarCss = readFileSync(
  resolve(__dirname, '../../components/StatusBar/StatusBar.module.css'),
  'utf8'
);

type RGB = [number, number, number];

// Git and status colours are fixed points: a workspace accent that lands on one
// makes workspace identity and file state indistinguishable in the same tree.
const SEMANTIC_TOKENS = [
  'git-added',
  'git-modified',
  'git-deleted',
  'git-conflicted',
  'git-untracked',
  'status-success',
  'status-warning',
  'status-error',
] as const;

it.each([
  ['side-cur', '#38bdf8'],
  ['side-inc', '#22c55e'],
  ['side-both', '#2dd4bf'],
  ['side-man', '#a855f7'],
])('defines the merge %s token', (name, value) => {
  expect(token(name)).toBe(value);
});

it.each(WORKSPACE_ACCENTS)(
  'gives the %s accent a [data-accent] block so the derived vars switch with it',
  (accent) => {
    // --accent-dark/dim/glow only track the active workspace through these
    // blocks. A token without one still colours dots but leaves the derived
    // values stuck on whatever the previous workspace set.
    const body = cssRule(css, `[data-accent='${accent}']`);
    // Asserting the mapped token, not merely that some --accent is declared:
    // a block pointing at the wrong accent would paint the whole IDE in
    // another workspace's colour and still satisfy a presence-only check.
    expect(body).toMatch(new RegExp(`--accent:\\s*var\\(--accent-${accent}\\)`));
    expect(body).toMatch(/--accent-dark:\s*#[0-9a-f]{6}/);
    expect(body).toMatch(/--accent-dim:\s*rgba\(/);
    expect(body).toMatch(/--accent-glow:\s*rgba\(/);
  }
);

/** Every workspace-accent pair, measured through `transform` at the given alpha. */
function accentPairs(transform: (rgb: RGB) => RGB) {
  return WORKSPACE_ACCENTS.flatMap((a, i) =>
    WORKSPACE_ACCENTS.slice(i + 1).map((b) => ({
      pair: `${a} vs ${b}`,
      distance: deltaE2000(
        transform(parseHex(token(`accent-${a}`))),
        transform(parseHex(token(`accent-${b}`)))
      ),
    }))
  );
}

it('keeps every pair of workspace accents perceptually distinct at full strength', () => {
  // The semantic guard below compares an accent to git/status colours. This one
  // compares accents to each other, which is what two rows of the selector menu
  // are. The rendered rail form is asserted separately below.
  const tooClose = accentPairs((rgb) => rgb)
    .filter((p) => p.distance < 10)
    .map((p) => `${p.pair} (${p.distance.toFixed(1)})`);
  expect(tooClose).toEqual([]);
});

it('keeps every renderable ownership rail distinct in its actual painted form', () => {
  // Modelling the real row, not a simplification. A Workspace-View row paints
  // two layers, and both matter:
  //
  //   background  .row.tinted.ownershipRail  -> region accent at 16% over the panel
  //   rail        .row.ownershipRail::before -> ownership accent at 50% over THAT
  //
  // The two accents are not always the same. flattenTree resolves the rail as
  // `fileAccent ?? getOwnershipAccent(entry)`, and getInfraFileAccent overrides
  // fileAccent to docker/terraform for Dockerfiles and .tf files. So a Docker
  // rail can sit on a Frontend row while a Terraform rail sits on a Go row —
  // and those two rails are what a user compares. Compositing over the bare
  // panel understates how close they get.
  const railAlpha = opacity(treeRowCss, '.row.ownershipRail::before');
  const washMix = Number(
    cssRule(treeRowCss, '.row.tinted.ownershipRail').match(
      /var\(--region-accent\)\s*([\d.]+)%,\s*transparent/
    )?.[1]
  );
  if (!Number.isFinite(washMix)) throw new Error('Missing ownership-row wash percentage');
  const panel = parseHex(token('surface-panel'));

  // `project` is excluded because it cannot reach either layer: orderedWorkspaces
  // filters out the synthetic project entry, so it never resolves as a region or
  // ownership accent.
  const RENDERABLE = WORKSPACE_ACCENTS.filter((a) => a !== 'project');
  // getInfraFileAccent can only ever override the rail to these two.
  const INFRA_RAILS = ['docker', 'terraform'] as const;

  const combos = RENDERABLE.flatMap((wash) =>
    [...new Set<string>([wash, ...INFRA_RAILS])].map((rail) => ({
      rail,
      label: `${rail} rail on ${wash} row`,
      rgb: composite(
        parseHex(token(`accent-${rail}`)),
        composite(parseHex(token(`accent-${wash}`)), panel, washMix / 100),
        railAlpha
      ),
    }))
  );

  const tooClose = combos
    .flatMap((a, i) =>
      combos.slice(i + 1).map((b) => ({ a, b, distance: deltaE2000(a.rgb, b.rgb) }))
    )
    // Same rail accent means the same ownership: those rails are supposed to
    // match, and only the row wash beneath them differs.
    .filter((p) => p.a.rail !== p.b.rail && p.distance < 10)
    .map((p) => `${p.a.label} vs ${p.b.label} (${p.distance.toFixed(1)})`);

  expect(tooClose).toEqual([]);
});

it.each(WORKSPACE_ACCENTS)(
  'keeps the %s workspace accent perceptually clear of every git and status colour',
  (accent) => {
    const accentRgb = parseHex(token(`accent-${accent}`));
    const nearest = SEMANTIC_TOKENS.map((name) => ({
      name,
      distance: deltaE2000(accentRgb, parseHex(token(name))),
    })).sort((a, b) => a.distance - b.distance)[0];

    // 10 is the floor the palette was designed to, and it is not slack: Node
    // sits at 10.2 against --git-added. Moving an accent closer needs a new
    // measurement, not a threshold change. Asserting on the pair rather than the
    // bare number so a failure names the colliding token.
    expect({ nearest: nearest.name, clear: nearest.distance >= 10 }).toEqual({
      nearest: nearest.name,
      clear: true,
    });
  }
);

it('targets the manual merge action semantically instead of by child order', () => {
  expect(mergeResolutionCss).toContain(".cm-mergeResolution-action[data-decision='M']");
  expect(mergeResolutionCss).not.toContain('.cm-mergeResolution-action:last-child');
});

it('keeps --files-key perceptually clear of every git and status colour', () => {
  // The FILES bar key duplicates --accent-go's literal on purpose (it must not
  // move with a repointed workspace accent), so it needs its own seat in the
  // semantic guard rather than riding the accent loop above.
  const key = parseHex(token('files-key'));
  const nearest = SEMANTIC_TOKENS.map((name) => ({
    name,
    distance: deltaE2000(key, parseHex(token(name))),
  })).sort((a, b) => a.distance - b.distance)[0];
  expect({ nearest: nearest.name, clear: nearest.distance >= 10 }).toEqual({
    nearest: nearest.name,
    clear: true,
  });
});

it('holds AA contrast for bar names on the tinted command-bar gradient', () => {
  // The bar paints its key at 12% over --surface-elevated and sets the name in
  // the key colour on top of that (PanelCommandBar.module.css). Both keys.
  const elevated = parseHex(token('surface-elevated'));
  for (const name of ['files-key', 'accent-project'] as const) {
    const key = parseHex(token(name));
    expect(contrast(key, composite(key, elevated, 0.12))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(key, elevated)).toBeGreaterThanOrEqual(4.5);
  }
});

it('defines the #271 layout tokens', () => {
  expect(css).toMatch(/--panel-golem-width:\s*420px/);
  expect(css).toMatch(/--panel-rail-width:\s*40px/);
  expect(css).toMatch(/--panel-bar-height:\s*38px/);
});

it('pins the golem rail and bar to the project accent instead of the live workspace accent', () => {
  // The collapsed golem rail (rendered by IDEShell as a sibling of the panel
  // island) and the golem command bar both live under the `.ide` root's
  // DYNAMIC data-accent={accent} — never inside GolemPanel's own
  // data-accent="project" pin. A `var(--accent-dim)` / `var(--accent-glow)`
  // reference there would repaint GOLEM in the rust/node/... workspace hue
  // instead of the pinned project accent, contradicting "GOLEM keys the
  // pinned project accent" (#271 review). Both files pin by mixing the alpha
  // out of --accent-project itself, so a retuned project accent carries the
  // glow and the dim with it instead of leaving copied bytes behind.
  const mix = (name: string, alpha: number) =>
    new RegExp(
      `${name}:\\s*color-mix\\(in srgb, var\\(--accent-project\\) ${alpha}%, transparent\\)`
    );
  for (const [source, label, selector, pinned] of [
    [
      panelRailCss,
      'PanelRail.module.css',
      ".rail[data-panel='golem']",
      [mix('--rail-key-glow', 25)],
    ],
    [
      panelCommandBarCss,
      'PanelCommandBar.module.css',
      ".bar[data-panel='golem']",
      [mix('--bar-key-dim', 12), mix('--bar-key-glow', 25)],
    ],
  ] as const) {
    const body = cssRule(source, selector);
    // Assert the pinned literals are actually present FIRST. `cssRule()`
    // strips comments, so a stray `}` in one no longer truncates the body (the
    // #271 review-round-2 regression), but the body still ends at the first
    // `}` — one inside a string or url() would cut it off before these
    // declarations and let the negative check below pass for the wrong reason.
    for (const pattern of pinned) {
      expect({ file: label, body }).toEqual({
        file: label,
        body: expect.stringMatching(pattern),
      });
    }
    expect({ file: label, body }).toEqual({
      file: label,
      body: expect.not.stringMatching(/var\(--accent(-dim|-glow)?\)/),
    });
  }
});

function token(name: string): string {
  const value = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})\\b`, 'i'))?.[1];
  if (!value) throw new Error(`Missing hex token --${name}`);
  return value;
}

function parseHex(hex: string): RGB {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;
}

function composite(foreground: RGB, background: RGB, alpha: number): RGB {
  return foreground.map(
    (channel, index) => channel * alpha + background[index] * (1 - alpha)
  ) as RGB;
}

function luminance(rgb: RGB): number {
  const linear = rgb
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a: RGB, b: RGB): number {
  const aLuminance = luminance(a);
  const bLuminance = luminance(b);
  return (Math.max(aLuminance, bLuminance) + 0.05) / (Math.min(aLuminance, bLuminance) + 0.05);
}

function lab(rgb: RGB): [number, number, number] {
  const [r, g, b] = rgb
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * CIEDE2000 colour difference. Contrast ratio answers "is this legible"; it says
 * nothing about "are these two the same colour" — two accents can share a hex and
 * still pass every contrast check in this file. This is the metric that catches that.
 */
function deltaE2000(a: RGB, b: RGB): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;

  const chroma1 = Math.hypot(a1, b1);
  const chroma2 = Math.hypot(a2, b2);
  const chromaMean = (chroma1 + chroma2) / 2;
  const g = 0.5 * (1 - Math.sqrt(chromaMean ** 7 / (chromaMean ** 7 + 25 ** 7)));
  const aPrime1 = (1 + g) * a1;
  const aPrime2 = (1 + g) * a2;
  const cPrime1 = Math.hypot(aPrime1, b1);
  const cPrime2 = Math.hypot(aPrime2, b2);

  const hue = (channelB: number, aPrime: number) => {
    if (channelB === 0 && aPrime === 0) return 0;
    const angle = Math.atan2(channelB, aPrime) * toDeg;
    return angle < 0 ? angle + 360 : angle;
  };
  const hPrime1 = hue(b1, aPrime1);
  const hPrime2 = hue(b2, aPrime2);

  const deltaL = l2 - l1;
  const deltaC = cPrime2 - cPrime1;
  let deltah = 0;
  if (cPrime1 * cPrime2 !== 0) {
    deltah = hPrime2 - hPrime1;
    if (deltah > 180) deltah -= 360;
    else if (deltah < -180) deltah += 360;
  }
  const deltaH = 2 * Math.sqrt(cPrime1 * cPrime2) * Math.sin((deltah * toRad) / 2);

  const lMean = (l1 + l2) / 2;
  const cMean = (cPrime1 + cPrime2) / 2;
  let hMean: number;
  if (cPrime1 * cPrime2 === 0) {
    hMean = hPrime1 + hPrime2;
  } else {
    hMean = (hPrime1 + hPrime2) / 2;
    if (Math.abs(hPrime1 - hPrime2) > 180) hMean += hPrime1 + hPrime2 < 360 ? 180 : -180;
  }

  const t =
    1 -
    0.17 * Math.cos((hMean - 30) * toRad) +
    0.24 * Math.cos(2 * hMean * toRad) +
    0.32 * Math.cos((3 * hMean + 6) * toRad) -
    0.2 * Math.cos((4 * hMean - 63) * toRad);
  const sl = 1 + (0.015 * (lMean - 50) ** 2) / Math.sqrt(20 + (lMean - 50) ** 2);
  const sc = 1 + 0.045 * cMean;
  const sh = 1 + 0.015 * cMean * t;
  const rt =
    -Math.sin(2 * (30 * Math.exp(-(((hMean - 275) / 25) ** 2))) * toRad) *
    (2 * Math.sqrt(cMean ** 7 / (cMean ** 7 + 25 ** 7)));

  return Math.sqrt(
    (deltaL / sl) ** 2 +
      (deltaC / sc) ** 2 +
      (deltaH / sh) ** 2 +
      rt * (deltaC / sc) * (deltaH / sh)
  );
}

function opacity(source: string, selector: string): number {
  return Number(cssRule(source, selector).match(/opacity:\s*([\d.]+)/)?.[1] ?? 1);
}

function focusColor(selector: string, accent: (typeof WORKSPACE_ACCENTS)[number]): string {
  const focusVariable = cssRule(editorCss, selector).match(
    /outline(?:-color)?:[^;]*var\(--([\w-]+)\)/
  )?.[1];
  if (!focusVariable) throw new Error(`Missing focus color for ${selector}`);
  return focusVariable === 'tab-accent' || focusVariable === 'accent'
    ? token(`accent-${accent}`)
    : token(focusVariable);
}

it('uses one full-strength outer rail and one adjacent 50% ownership rail without shadows', () => {
  const outerRail = cssRule(fileExplorerCss, '.workspaceTree');
  const ownershipRail = cssRule(treeRowCss, '.row.ownershipRail::before');

  expect(outerRail).toMatch(/border-left:\s*3px solid var\(--tree-accent\)/);
  expect(ownershipRail).toMatch(/background:\s*var\(--ownership-accent\)/);
  expect(ownershipRail).toMatch(/opacity:\s*0\.5/);
  expect(`${outerRail}\n${ownershipRail}`).not.toMatch(/(?:box-shadow|filter):/);
  expect(treeRowCss).not.toMatch(/\.row\.ownershipRail::after/);
});

it('raises the Workspace row wash without changing the Project row wash', () => {
  expect(cssRule(treeRowCss, '.row.tinted')).toMatch(/var\(--region-accent\) 6%/);
  expect(cssRule(treeRowCss, '.row.tinted:hover')).toMatch(/var\(--region-accent\) 12%/);
  expect(cssRule(treeRowCss, ".row.tinted[aria-selected='true']")).toMatch(
    /var\(--region-accent\) 20%/
  );
  expect(cssRule(treeRowCss, '.row.tinted.ownershipRail')).toMatch(/var\(--region-accent\) 16%/);
  expect(
    cssRule(treeRowCss, ".row.tinted.ownershipRail:not([aria-selected='true']):hover")
  ).toMatch(/var\(--region-accent\) 20%/);
});

it.each([
  'surface-base',
  'surface-frame',
  'surface-panel',
  'surface-elevated',
  'surface-hover',
  'surface-active',
])('keeps muted text at 4.5:1 or better on --%s', (surface) => {
  expect(contrast(parseHex(token('text-muted')), parseHex(token(surface)))).toBeGreaterThanOrEqual(
    4.5
  );
});

it.each([
  ['Terminal problem source', terminalCss, '.problemsSource', 'surface-panel'],
  ['hidden folder name', treeRowCss, '.row[data-hidden] .name', 'surface-panel'],
  ['hidden folder name on hover', treeRowCss, '.row[data-hidden] .name', 'surface-hover'],
] as const)('keeps the real %s consumer at 4.5:1 or better', (_name, source, selector, surface) => {
  const background = parseHex(token(surface));
  const foreground = composite(
    parseHex(token('text-muted')),
    background,
    opacity(source, selector)
  );
  expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
});

it.each(WORKSPACE_ACCENTS)(
  'keeps a hidden folder name at 4.5:1 or better on the selected %s tint',
  (accent) => {
    const selectedRule = cssRule(treeRowCss, ".row.tinted[aria-selected='true']");
    const tint = Number(
      selectedRule.match(/var\(--region-accent\)\s*([\d.]+)%,\s*transparent/)?.[1]
    );
    if (!Number.isFinite(tint)) throw new Error('Missing selected tree-row tint');

    const panel = parseHex(token('surface-panel'));
    const background = composite(parseHex(token(`accent-${accent}`)), panel, tint / 100);
    const foreground = composite(
      parseHex(token('text-muted')),
      background,
      opacity(treeRowCss, '.row[data-hidden] .name')
    );
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  }
);

it.each(['surface-panel', 'surface-hover', 'surface-active'])(
  'keeps the unreadable marker at 3:1 or better on --%s',
  (surface) => {
    expect(cssRule(treeRowCss, '.unreadable')).toMatch(/color:\s*var\(--status-warning\)/);
    expect(
      contrast(parseHex(token('status-warning')), parseHex(token(surface)))
    ).toBeGreaterThanOrEqual(3);
  }
);

it.each(WORKSPACE_ACCENTS)(
  'keeps the unreadable marker at 3:1 or better on the selected %s tint',
  (accent) => {
    const selectedRule = cssRule(treeRowCss, ".row.tinted[aria-selected='true']");
    const tint = Number(
      selectedRule.match(/var\(--region-accent\)\s*([\d.]+)%,\s*transparent/)?.[1]
    );
    if (!Number.isFinite(tint)) throw new Error('Missing selected tree-row tint');

    const background = composite(
      parseHex(token(`accent-${accent}`)),
      parseHex(token('surface-panel')),
      tint / 100
    );
    expect(contrast(parseHex(token('status-warning')), background)).toBeGreaterThanOrEqual(3);
  }
);

it.each(WORKSPACE_ACCENTS)(
  'keeps the %s active editor-tab focus indicator at 3:1 or better',
  (accent) => {
    expect(
      contrast(
        parseHex(focusColor('.tabTarget:focus-visible', accent)),
        parseHex(token('surface-active'))
      )
    ).toBeGreaterThanOrEqual(3);
  }
);

it.each(WORKSPACE_ACCENTS)(
  'keeps the %s editor close-button focus indicator at 3:1 or better',
  (accent) => {
    expect(
      contrast(
        parseHex(focusColor('.tabClose:focus-visible', accent)),
        parseHex(token('surface-active'))
      )
    ).toBeGreaterThanOrEqual(3);
  }
);

it.each(['.tabTarget:focus-visible', '.tabClose:focus-visible'])(
  'uses the shared focus-ring token for %s',
  (selector) => {
    expect(cssRule(editorCss, selector)).toMatch(/outline:\s*2px solid var\(--focus-ring\)/);
  }
);

it.each(WORKSPACE_ACCENTS)(
  'keeps the active Golem status segment at 4.5:1 or better under the %s accent',
  (accent) => {
    // Real text at 11px on the status bar's own chrome, so the 4.5:1 text floor
    // applies, not the 3:1 marker floor. Resolving `--accent` per workspace is
    // the point: colouring this label with the accent puts `general` (3.89:1)
    // and `docker` (3.98:1) below the floor, and `general` is the accent every
    // workspace without a recognized ecosystem gets.
    const declared = cssRule(statusBarCss, ".segmentBtn[data-golem-state='active']").match(
      /color:\s*var\(--([\w-]+)\)/
    )?.[1];
    if (!declared) throw new Error('Missing colour for the active Golem status segment');
    const color = declared === 'accent' ? token(`accent-${accent}`) : token(declared);

    expect(contrast(parseHex(color), parseHex(token('surface-frame')))).toBeGreaterThanOrEqual(4.5);
  }
);
