# Firn IDE — Design Specification v2

This document consolidates all UI/UX decisions for Firn IDE, serving as the blueprint for hi-fi mockup creation and implementation.

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [Visual Identity & Theme](#2-visual-identity--theme)
3. [File & Language Icons](#3-file--language-icons)
4. [Workspace Model & Switching](#4-workspace-model--switching)
5. [Run Profiles UI](#5-run-profiles-ui)
6. [Search Everywhere](#6-search-everywhere)
7. [Context Menus](#7-context-menus)
8. [Keyboard Shortcuts](#8-keyboard-shortcuts)
9. [Component Specifications](#9-component-specifications)
10. [AI Chat Panel](#10-ai-chat-panel)
11. [Keyboard Shortcuts (Extended)](#11-keyboard-shortcuts-extended)

---

## 1. Design Philosophy

### Core Principles

1. **Editor-Centric Focus** — The editor is the primary workspace; surrounding UI recedes
2. **Workspace as Personality** — Each workspace type feels distinct, like switching JetBrains apps
3. **Lightweight Feel** — Instant interactions, no unnecessary animations
4. **Keyboard-First** — Every action accessible via keyboard
5. **JetBrains-Inspired UX** — Familiar patterns for productivity users

### Performance Targets

- Cold start: < 2-4 seconds
- Idle CPU: Near 0% (no polling)
- Core RAM: ~200-450MB (without language servers)
- Workspace switch: Instant (0ms transition)

---

## 2. Visual Identity & Theme

### Base Theme

**Inspiration:** Firn Glacier Theme + JetBrains Island Dark

**Key Characteristic:** Layered depth with clear editor/chrome contrast

### Surface Hierarchy

Surfaces progress from darkest (recedes) to lightest (focus):

| Surface | Role | Hex | Notes |
|---------|------|-----|-------|
| Frame/Title bar | Window chrome | `#0A0E14` | Darkest, disappears |
| Sidebar backgrounds | Project, Git panels | `#0D1117` | Secondary panels |
| Tool panel backgrounds | Terminal, Problems | `#161B22` | Bottom/auxiliary |
| Tab bar | File navigation | `#1C2128` | Between chrome and editor |
| Editor background | Primary focus | `#1E2228` | Clearly lighter than surrounds |
| Borders/dividers | Subtle separation | `#30363D` | 1px, low contrast |
| Hover states | Interactive feedback | `#21262D` | Subtle lift |

### Text Colors

| Role | Hex | Usage |
|------|-----|-------|
| Primary text | `#E6EDF3` | File names, code, labels |
| Secondary text | `#8B949E` | Paths, descriptions |
| Muted text | `#6E7681` | Shortcuts, timestamps |
| Disabled text | `#484F58` | Inactive items |

### Accent Colors (Workspace Personalities)

Each workspace type has a distinct accent color that appears in:
- Active tab indicator (left border or underline)
- Workspace badge in header
- Selected item highlights
- Status bar workspace label
- Run profile indicators when running

Accents are named for the workspace type, not the color, because the mapping is
1:1 — renaming a hue must never silently repoint a workspace.

| Workspace Type | Token | Hex | Rationale |
|----------------|-------|-----|-----------|
| Frontend | `--accent-frontend` | `#F0389D` | Magenta; keeps clear of Terraform purple |
| Node | `--accent-node` | `#8FC606` | nodejs green, deepened to clear `--git-added` |
| Python | `--accent-python` | `#BFAD00` | Python yellow, deepened for the selected-row tint |
| Go | `--accent-go` | `#12B5CD` | Gopher cyan |
| Rust | `--accent-rust` | `#E2703A` | Rust oxide orange |
| Docker | `--accent-docker` | `#0573D7` | Docker blue |
| Terraform | `--accent-terraform` | `#A855F7` | Terraform purple |
| General / Untyped | `--accent-general` | `#6B7280` | No specific personality |

Two constraints bind this palette, both enforced by `__tests__/styles/tokens.test.ts`:

- **CIEDE2000 ΔE >= 10 from every `--git-*` and `--status-*` color.** The previous
  palette failed this twice — `--accent-green` was byte-identical to `--git-added`
  and `--accent-amber` to `--status-warning`.
- **`--text-muted` stays at 4.5:1 over the selected-row tint** (20% accent over
  `--surface-panel`). This is what caps accent brightness, and why Node and Python
  are deeper than their brand colors.

The uneven lightness across accents is deliberate; normalizing it measurably
worsens the weakest pair.

A separate `--palette-*` ramp (`blue`, `green`, `cyan`, `orange`, `purple`, `amber`)
exists for UI needing several distinguishable colors with no workspace meaning —
Structure view symbol kinds, the LSP setup card. Do not use it for workspace identity.

### Workspace Accent System (Implemented)

The entire IDE accent cascades from a single CSS custom property, making workspace switching visually instant. When a workspace is activated, these elements update:

**Affected Elements:**
- Header gradient tint (subtle accent wash)
- Header border glow
- Workspace selector button (background, border, dot, name color)
- Active tab indicator (top border)
- File tree selection highlight
- Activity bar active indicator
- Scrollbar thumbs
- Editor current line highlight
- Terminal prompt color (note: the bottom tool panel currently uses a fixed glacier accent via scoped `data-accent="project"`, independent of workspace accent)
- Status bar workspace label

**CSS Implementation:**
```css
/* Accent variants — applied via [data-accent] on the .ide element */
[data-accent='frontend'] {
  --accent: var(--accent-frontend);
  --accent-dark: #ad2871;
  --accent-dim: rgba(240, 56, 157, 0.12);
  --accent-glow: rgba(240, 56, 157, 0.25);
}

[data-accent='rust'] {
  --accent: var(--accent-rust);
  --accent-dark: #a3512a;
  --accent-dim: rgba(226, 112, 58, 0.12);
  --accent-glow: rgba(226, 112, 58, 0.25);
}

/* etc. for node, python, go, docker, terraform, general, project */
```

**Available Accents:** `frontend`, `node`, `python`, `go`, `rust`, `docker`, `terraform`, `general`, `project`

**Note:** The Firn logo maintains consistent branding (blue→purple gradient) regardless of workspace accent.

---

## 3. File & Language Icons

### Icon Design Principles

1. **Distinct at small sizes** — Icons must be recognizable at 16x16px
2. **Consistent style** — Flat design, consistent stroke weight, rounded corners
3. **Color-coded by category** — Languages, configs, data, media, etc.
4. **Monochrome option** — Support user preference for reduced color

### Icon Categories & Colors

| Category | Color Family | Hex Range |
|----------|--------------|-----------|
| JavaScript / TypeScript | Yellow / Blue | `#F7DF1E` / `#3178C6` |
| Python | Blue / Yellow | `#3776AB` / `#FFD43B` |
| Go | Cyan | `#00ADD8` |
| Rust | Orange | `#DEA584` |
| HTML / Markup | Orange | `#E34F26` |
| CSS / Styling | Blue / Purple | `#1572B6` / `#CC6699` |
| Config files | Gray / Muted | `#6B7280` |
| Data (JSON, YAML) | Yellow / Amber | `#F59E0B` |
| Images | Purple | `#8B5CF6` |
| Documentation | Blue | `#2563EB` |
| Git | Orange-Red | `#F05032` |
| Docker | Blue | `#2496ED` |
| Folders | Muted blue | `#64748B` |

### File Type Icon Mappings

#### Languages & Frameworks

| Extension(s) | Icon Name | Color | Notes |
|--------------|-----------|-------|-------|
| `.js` | javascript | `#F7DF1E` | JS logo style |
| `.mjs`, `.cjs` | javascript-module | `#F7DF1E` | With module indicator |
| `.jsx` | react | `#61DAFB` | React logo |
| `.ts` | typescript | `#3178C6` | TS logo style |
| `.tsx` | react-typescript | `#3178C6` | React + TS combined |
| `.py` | python | `#3776AB` | Python logo style |
| `.pyi` | python-stub | `#3776AB` | Lighter/outlined |
| `.go` | go | `#00ADD8` | Gopher-inspired |
| `.rs` | rust | `#DEA584` | Rust gear logo |
| `.rb` | ruby | `#CC342D` | Ruby gem |
| `.php` | php | `#777BB4` | PHP logo |
| `.java` | java | `#ED8B00` | Coffee cup style |
| `.kt`, `.kts` | kotlin | `#7F52FF` | Kotlin logo |
| `.swift` | swift | `#F05138` | Swift bird |
| `.c` | c | `#A8B9CC` | C logo |
| `.cpp`, `.cc`, `.cxx` | cpp | `#00599C` | C++ logo |
| `.h`, `.hpp` | header | `#9B4F96` | Header file |
| `.cs` | csharp | `#512BD4` | C# logo |
| `.fs`, `.fsx` | fsharp | `#378BBA` | F# logo |
| `.lua` | lua | `#000080` | Lua moon |
| `.r`, `.R` | r-lang | `#276DC3` | R logo |
| `.scala` | scala | `#DC322F` | Scala logo |
| `.ex`, `.exs` | elixir | `#6E4A7E` | Elixir drop |
| `.erl`, `.hrl` | erlang | `#A90533` | Erlang logo |
| `.hs`, `.lhs` | haskell | `#5D4F85` | Haskell logo |
| `.clj`, `.cljs` | clojure | `#5881D8` | Clojure logo |
| `.vue` | vue | `#4FC08D` | Vue logo |
| `.svelte` | svelte | `#FF3E00` | Svelte logo |
| `.astro` | astro | `#FF5D01` | Astro logo |
| `.sol` | solidity | `#363636` | Ethereum style |

#### Web & Markup

| Extension(s) | Icon Name | Color | Notes |
|--------------|-----------|-------|-------|
| `.html`, `.htm` | html | `#E34F26` | HTML5 logo |
| `.css` | css | `#1572B6` | CSS3 logo |
| `.scss`, `.sass` | sass | `#CC6699` | Sass logo |
| `.less` | less | `#1D365D` | Less logo |
| `.styl` | stylus | `#FF6347` | Stylus logo |
| `.svg` | svg | `#FFB13B` | SVG logo |
| `.xml` | xml | `#F26822` | XML tag style |
| `.xsl`, `.xslt` | xslt | `#F26822` | Transform indicator |

#### Data & Config

| Extension(s) | Icon Name | Color | Notes |
|--------------|-----------|-------|-------|
| `.json` | json | `#F59E0B` | Braces icon |
| `.yaml`, `.yml` | yaml | `#CB171E` | YAML style |
| `.toml` | toml | `#9C4121` | TOML logo |
| `.ini`, `.cfg` | config | `#6B7280` | Gear icon |
| `.env`, `.env.*` | env | `#ECD53F` | Key icon, warning color |
| `.csv` | csv | `#22C55E` | Table grid |
| `.xml` | xml | `#F26822` | Angle brackets |
| `.graphql`, `.gql` | graphql | `#E10098` | GraphQL logo |
| `.prisma` | prisma | `#2D3748` | Prisma logo |

#### Documentation

| Extension(s) | Icon Name | Color | Notes |
|--------------|-----------|-------|-------|
| `.md`, `.mdx` | markdown | `#083FA1` | Markdown logo |
| `.rst` | rst | `#141414` | reStructuredText |
| `.txt` | text | `#6B7280` | Plain text icon |
| `.pdf` | pdf | `#FF0000` | PDF logo |
| `.doc`, `.docx` | word | `#2B579A` | Word icon |

#### DevOps & Infrastructure

| Extension(s) | Icon Name | Color | Notes |
|--------------|-----------|-------|-------|
| `Dockerfile`, `.dockerfile` | docker | `#2496ED` | Docker whale |
| `docker-compose.yml` | docker-compose | `#2496ED` | Compose variant |
| `.tf`, `.tfvars` | terraform | `#7B42BC` | Terraform logo |
| `.hcl` | hcl | `#7B42BC` | HashiCorp style |
| `Makefile`, `makefile` | makefile | `#6B7280` | Build icon |
| `.sh`, `.bash`, `.zsh` | shell | `#4EAA25` | Terminal icon |
| `.ps1` | powershell | `#5391FE` | PowerShell logo |
| `.bat`, `.cmd` | batch | `#C1F12E` | Windows cmd |
| `Jenkinsfile` | jenkins | `#D24939` | Jenkins logo |
| `.github/*` | github | `#181717` | GitHub logo |
| `.gitlab-ci.yml` | gitlab | `#FC6D26` | GitLab logo |

#### Package & Lock Files

| Filename | Icon Name | Color | Notes |
|----------|-----------|-------|-------|
| `package.json` | npm | `#CB3837` | npm logo |
| `package-lock.json` | npm-lock | `#CB3837` | Lock indicator |
| `yarn.lock` | yarn | `#2C8EBB` | Yarn logo |
| `pnpm-lock.yaml` | pnpm | `#F69220` | pnpm logo |
| `Cargo.toml` | cargo | `#DEA584` | Rust cargo |
| `Cargo.lock` | cargo-lock | `#DEA584` | Lock indicator |
| `go.mod` | go-mod | `#00ADD8` | Go module |
| `go.sum` | go-sum | `#00ADD8` | Checksum variant |
| `pyproject.toml` | pyproject | `#3776AB` | Python project |
| `requirements.txt` | pip | `#3776AB` | pip style |
| `Pipfile`, `Pipfile.lock` | pipenv | `#3776AB` | Pipenv |
| `Gemfile`, `Gemfile.lock` | bundler | `#CC342D` | Ruby bundler |
| `composer.json` | composer | `#885630` | Composer logo |

#### Config Files (Specific)

| Filename Pattern | Icon Name | Color | Notes |
|------------------|-----------|-------|-------|
| `tsconfig.json`, `jsconfig.json` | tsconfig | `#3178C6` | TS gear |
| `.eslintrc.*`, `eslint.config.*` | eslint | `#4B32C3` | ESLint logo |
| `.prettierrc.*`, `prettier.config.*` | prettier | `#F7B93E` | Prettier logo |
| `vite.config.*` | vite | `#646CFF` | Vite logo |
| `webpack.config.*` | webpack | `#8DD6F9` | Webpack logo |
| `rollup.config.*` | rollup | `#FF3333` | Rollup logo |
| `tailwind.config.*` | tailwind | `#06B6D4` | Tailwind logo |
| `next.config.*` | nextjs | `#000000` | Next.js logo |
| `nuxt.config.*` | nuxt | `#00DC82` | Nuxt logo |
| `.gitignore` | gitignore | `#F05032` | Git logo muted |
| `.gitattributes` | git | `#F05032` | Git logo |
| `.editorconfig` | editorconfig | `#FEFEFE` | EditorConfig logo |
| `.nvmrc`, `.node-version` | nodejs | `#339933` | Node.js logo |
| `.python-version` | python | `#3776AB` | Python version |

#### Images & Media

| Extension(s) | Icon Name | Color | Notes |
|--------------|-----------|-------|-------|
| `.png` | image-png | `#8B5CF6` | PNG indicator |
| `.jpg`, `.jpeg` | image-jpg | `#8B5CF6` | JPG indicator |
| `.gif` | image-gif | `#8B5CF6` | GIF indicator |
| `.webp` | image-webp | `#8B5CF6` | WebP indicator |
| `.ico` | image-ico | `#8B5CF6` | Favicon style |
| `.mp3`, `.wav`, `.ogg` | audio | `#EF4444` | Audio waveform |
| `.mp4`, `.webm`, `.mov` | video | `#EF4444` | Video play icon |
| `.ttf`, `.otf`, `.woff`, `.woff2` | font | `#6B7280` | Font glyph |

#### Folders (Special)

| Folder Name | Icon Name | Color | Notes |
|-------------|-----------|-------|-------|
| `src`, `source` | folder-src | `#3B82F6` | Code folder |
| `lib`, `libs` | folder-lib | `#8B5CF6` | Library folder |
| `test`, `tests`, `__tests__` | folder-test | `#22C55E` | Test folder |
| `docs`, `documentation` | folder-docs | `#2563EB` | Docs folder |
| `public`, `static`, `assets` | folder-public | `#F59E0B` | Public assets |
| `dist`, `build`, `out` | folder-dist | `#6B7280` | Build output |
| `node_modules` | folder-node | `#339933` | Node modules (muted) |
| `.git` | folder-git | `#F05032` | Git folder |
| `.github` | folder-github | `#181717` | GitHub folder |
| `.vscode` | folder-vscode | `#007ACC` | VS Code folder |
| `components` | folder-components | `#61DAFB` | Components |
| `hooks` | folder-hooks | `#61DAFB` | React hooks |
| `pages`, `routes` | folder-pages | `#3B82F6` | Pages/routes |
| `api` | folder-api | `#22C55E` | API folder |
| `utils`, `helpers` | folder-utils | `#6B7280` | Utilities |
| `config`, `configs` | folder-config | `#F59E0B` | Config folder |
| `scripts` | folder-scripts | `#4EAA25` | Scripts folder |
| `styles`, `css` | folder-styles | `#1572B6` | Styles folder |
| `images`, `img` | folder-images | `#8B5CF6` | Images folder |
| `types`, `@types` | folder-types | `#3178C6` | TypeScript types |

### Icon Recommendations

**Option A: Use Existing Icon Set**
- [Material Icon Theme](https://github.com/PKief/vscode-material-icon-theme) — MIT licensed, comprehensive
- [VSCode Icons](https://github.com/vscode-icons/vscode-icons) — MIT licensed
- [Catppuccin Icons](https://github.com/catppuccin/vscode-icons) — MIT licensed

**Option B: Custom Icon Set**
- Design custom icons following the color mappings above
- Ensure SVG format for scalability
- Provide 16px, 24px, and 32px optimized versions

---

## 4. Workspace Model & Multi-Workspace Editing

### Workspace Definition

A workspace is a focused context within a repository:
- **Root directory** — Scoped file tree (e.g., `./frontend`)
- **Type** — Frontend, Python, Go, Infrastructure, General
- **Layout state** — Persisted pane positions, open tabs, splits
- **Run Profiles** — Workspace-scoped profiles
- **Language services** — LSP servers started on-demand, paused when files close

### File Tree Views

The file tree panel has two views, toggled via dropdown at the top:

#### Project View (Unified)

Shows the entire repository with **color-coded workspace regions**. Each workspace folder has a subtle background tint (~4% opacity of its accent color).

```
┌─ PROJECT ▾ ─────────────────────────────────────────────────────────┐
│ README.md            ← no tint (root level, no workspace)           │
│ .gitignore           ← no tint                                      │
│ docker-compose.yml   ← docker tint (Infrastructure by file type)    │
│ ▼ frontend/          ┐                                              │
│   ▼ src/             │ frontend tint (#F0389D at 6% opacity)        │
│     Button.tsx       │                                              │
│     App.tsx          ┘                                              │
│ ▼ backend/           ← no tint (parent folder, not a workspace)     │
│   ▼ go/              ┐                                              │
│     handler.go       │ go tint (#12B5CD at 6% opacity)              │
│     main.go          ┘                                              │
│   ▼ python/          ┐                                              │
│     train.py         │ python tint (#BFAD00 at 6% opacity)          │
│     model.py         ┘                                              │
│ ▼ infra/             ┐                                              │
│   Dockerfile         │ docker tint (#0573D7 at 6% opacity)          │
│   terraform/         ┘ terraform tint (#A855F7)                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Project View Behavior:**
- All files accessible without committing to a workspace
- LSP starts/pauses based on **open file types** (not workspace selection)
- Run Profiles panel shows **all profiles from all workspaces**, grouped by workspace
- Use case: Quick cross-cutting edits, full-stack changes, exploratory work

**File Type Association:** Files like `docker-compose.yml`, `Dockerfile`, `.tf` get their workspace tint even at repo root (logically belong to Infrastructure).

#### Workspace View (Focused)

Shows a single workspace with its root as the tree root. Workspace tabs allow switching.

```
┌─ WORKSPACE ▾ ────────────────────────────────────────────────────────┐
│ [Frontend] [Go] [Python] [Infra]   ← workspace tabs                  │
│ ─────────────────────────────────────────────────────────────────────│
│ ▼ src/               ← frontend/ becomes root                        │
│   ▼ components/                                                      │
│     Button.tsx                                                       │
│   App.tsx                                                            │
│   main.tsx                                                           │
│ package.json                                                         │
│ tsconfig.json                                                        │
└──────────────────────────────────────────────────────────────────────┘
```

**Workspace View Behavior:**
- File tree scoped to workspace root directory
- Clicking a workspace tab switches which workspace is shown (becomes root)
- Run Profiles panel shows **only that workspace's profiles**
- Header shows workspace name + accent color
- Use case: Focused deep work in one area

### View Comparison

| Aspect | Project View | Workspace View |
|--------|--------------|----------------|
| File tree | Full repo, color-coded regions | Scoped to workspace root |
| Run Profiles | All profiles, grouped by workspace | Filtered to active workspace |
| Header | Neutral / "Project" label | Workspace name + accent |
| LSP | On-demand by file type | On-demand by file type |
| Use case | Quick edits, full-stack work | Focused deep work |

### LSP Behavior (Both Views)

- **On-demand start** — LSP starts when you open a file needing that language server
- **Pause on close** — When all files of that language are closed, LSP pauses/stops
- **Resume on reopen** — If you reopen a file, LSP resumes quickly
- **Memory efficient** — Only active language servers consume resources

### Workspace Switcher (Workspace View)

**Primary: Workspace Tabs**

In Workspace View, tabs at the top of the file tree switch between workspaces.

**Secondary: Header Dropdown**

Location: Top-left, after app logo (only in Workspace View)

```
┌─────────────────────────────────────────────────────────────────┐
│ [◇ Firn] [● Frontend ▾]  [▶ Profile ▾] [env ▾]   [Search]       │
└─────────────────────────────────────────────────────────────────┘
```

Dropdown contents:
```
┌──────────────────────────────────┐
│ WORKSPACES                       │
│ ────────────────────────────────│
│ ● Frontend        ./frontend     │  ← accent dot shows type color
│ ○ Python          ./backend/py   │
│ ○ Go              ./backend/go   │
│ ○ Infrastructure  ./infra        │
│ ────────────────────────────────│
│ + New Workspace...               │
│ ⚙ Manage Workspaces...          │
└──────────────────────────────────┘
```

**Keyboard:** `⌘⇧W` opens quick-switch palette

### Transition Behavior (Workspace View)

- **Instant snap** — No animation, immediate context switch
- File tree root, profiles, and accent color change immediately
- Open editor tabs persist across workspace switches

---

## 5. Run Profiles UI

### Concepts

- **Profile:** Single runnable command
- **Compound Profile:** Ordered sequence of profiles
- **Environment Variant:** Toggle for env files (dev/staging/prod) on same profile

### Top Toolbar

```
┌─────────────────────────────────────────────────────────────────┐
│ [Logo] [Workspace ▾]  [▶ Frontend Dev ▾] [env: dev ▾]  [⚙]     │
└─────────────────────────────────────────────────────────────────┘
```

- Profile selector with play icon
- Environment variant toggle (only when configured)
- Run/Stop/Restart controls

### Profile Selector Dropdown

**Workspace View** — Shows only the active workspace's profiles:

```
┌──────────────────────────────────────┐
│ FRONTEND                             │
│ ─────────────────────────────────── │
│ ▶  Dev Server               ⌘R       │
│ ▶  Build                             │
│ ▶  Lint                              │
│ ▶  Test                              │
│ ─────────────────────────────────── │
│ COMPOUNDS                            │
│ ▶▶ Full Stack Dev           ⌘⇧R      │
│ ─────────────────────────────────── │
│ + New Profile...                     │
│ ⚙ Edit Profiles...                   │
└──────────────────────────────────────┘
```

**Project View** — Shows all profiles grouped by workspace:

```
┌──────────────────────────────────────┐
│ FRONTEND                             │
│ ▶  Dev Server               ⌘R       │
│ ▶  Build                             │
│ ▶  Lint                              │
│ ─────────────────────────────────── │
│ GO                                   │
│ ▶  Run API                           │
│ ▶  Test                              │
│ ▶  Build                             │
│ ─────────────────────────────────── │
│ PYTHON                               │
│ ▶  Train Model                       │
│ ▶  Backtest                          │
│ ─────────────────────────────────── │
│ INFRASTRUCTURE                       │
│ ▶  Docker Up                         │
│ ▶  Docker Down                       │
│ ─────────────────────────────────── │
│ COMPOUNDS                            │
│ ▶▶ Full Stack Dev           ⌘⇧R      │
│ ─────────────────────────────────── │
│ + New Profile...                     │
│ ⚙ Edit Profiles...                   │
└──────────────────────────────────────┘
```

Visual indicators:
- `▶` Single profile
- `▶▶` Compound profile
- Green dot: Running
- Red dot: Failed

### Run Output Panel

```
┌─ RUN ──────────────────────────────────────────────────────────────┐
│ [Frontend Dev ▾] [env: dev]  [↻] [■] [🗑] [⚙]                     │
├────────────────────────────────────────────────────────────────────┤
│ $ npm run dev                                                      │
│                                                                    │
│ > frontend@1.0.0 dev                                               │
│ > vite                                                             │
│                                                                    │
│   VITE v5.0.0  ready in 342 ms                                     │
│   ➜  Local:   http://localhost:5173/                               │
│                                                                    │
│ src/components/Button.tsx:42:5         ← clickable file:line       │
│   Type error: Property 'onClick' is missing                        │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

Features:
- Tabs for multiple running profiles
- Clickable `file:line:col` links
- Auto-scroll with pin toggle
- Search within output (`⌘F`)
- Persist logs option

### Nice to Have: Jump to Error

When a profile fails, parse traceback/stack trace and provide:
- Clickable link to the error source
- Notification with "Jump to error" action
- Works for Python, Node/TS, Go stack traces

### Compound Execution View

```
┌─ RUN: Full Stack Dev ──────────────────────────────────────────────┐
│ [■ Stop All]                                                       │
├────────────────────────────────────────────────────────────────────┤
│ STAGES                          │ OUTPUT                           │
│ ────────────────────────────── │ ─────────────────────────────────│
│ ✓ Docker Up          00:03     │ [selected stage output]          │
│ ● Backend API        running   │                                  │
│ ○ Frontend Dev       pending   │                                  │
└────────────────────────────────────────────────────────────────────┘
```

Stage indicators: `○` pending, `●` running, `✓` completed, `✗` failed

### Status Bar

```
┌────────────────────────────────────────────────────────────────────┐
│ [Python 3.11] [main ↑2] │ ● Frontend Dev (dev) │ ● Backend API    │
└────────────────────────────────────────────────────────────────────┘
```

Click running profile → opens its output panel

---

## 6. Search Everywhere

### Trigger

- `⌘⇧P` — Opens Search Everywhere
- Double-tap `Shift` — Alternative (JetBrains style)

### Layout

```
┌─ Search Everywhere ────────────────────────────────────────────────┐
│                                                                    │
│ [All] [Files] [Symbols] [Actions] [Profiles]   [Scope: Workspace ▾]│
│                                                                    │
│ [🔍] [search query...                         ]                    │
│                                                                    │
│ FILES                                                              │
│ ─────────────────────────────────────────────────────────────────  │
│ [ts] Button.tsx              src/components/                       │
│ [ts] ButtonGroup.tsx         src/components/                       │
│                                                                    │
│ SYMBOLS                                                            │
│ ─────────────────────────────────────────────────────────────────  │
│ ƒ  handleButtonClick         Button.tsx:24                         │
│                                                                    │
│ ACTIONS                                                            │
│ ─────────────────────────────────────────────────────────────────  │
│ ⚡ Toggle Terminal            ⌘`                                   │
│                                                                    │
│ RUN PROFILES                                                       │
│ ─────────────────────────────────────────────────────────────────  │
│ ▶  Frontend Dev                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### Scope Dropdown

```
┌─────────────────────────────────┐
│ ● Current Workspace (Frontend)  │  ← default
│ ○ Entire Project                │
│ ─────────────────────────────── │
│ ○ Frontend                      │
│ ○ Python                        │
│ ○ Go                            │
└─────────────────────────────────┘
```

Default: Current workspace if active, else entire project

Toggle scope: `⌘/` while search is open

### Direct Access Shortcuts

| Shortcut | Opens |
|----------|-------|
| `⌘P` | Files only |
| `⌘⇧O` | Symbols only |
| `⌘⇧A` | Actions only |

### Empty State

Shows Recent + Frequent items when query is empty

### Result Item Format

```
[Icon] [Primary Label]                    [Secondary / Path]
       [Match highlighting]               [Shortcut if action]
```

Icons use file type icons from Section 3.

---

## 7. Context Menus

### Design Style

- Background: `#161B22` (sidebar color)
- Text: `#E6EDF3` (primary)
- Shortcuts: `#6E7681` (muted)
- Hover: `#21262D` with subtle accent tint
- Border-radius: 4px
- Shadow: Subtle drop shadow
- Icons: File type icons (colored) for New submenu; monochrome elsewhere

### File Context Menu Structure

```
── New                        ›  [submenu]
─────────────────────────────────
✂  Cut                       ⌘X
📋 Copy                      ⌘C
   Copy Path/Reference...
📄 Paste                     ⌘V
─────────────────────────────────
🔍 Find Usages              ⌥F7
   Rename...                 F6
─────────────────────────────────
   Open in Split              ›
   Open In                    ›
─────────────────────────────────
   Local History              ›
   Reload from Disk
─────────────────────────────────
   Compare With...           ⌘D
─────────────────────────────────
🗑  Delete...                 ⌫
```

### "New" Submenu

Grouped by relevance, shows file type icons:

```
┌────────────────────────────────────┐
│ [go] Go File                       │
│ [file] File                        │
│ [scratch] Scratch File        ⌥⌘N │
│ [folder] Directory                 │
│ ────────────────────────────────── │
│ [js] JavaScript File               │
│ [ts] TypeScript File               │
│ [json] tsconfig.json File          │
│ [html] HTML File                   │
│ [css] Stylesheet                   │
│ ────────────────────────────────── │
│ [docker] Dockerfile                │
│ [terraform] Terraform File         │
│ [yaml] Kubernetes Resource         │
│ ────────────────────────────────── │
│ [md] Markdown File                 │
│ [json] package.json                │
└────────────────────────────────────┘
```

Contents adapt to workspace type (Python workspace shows Python files first, etc.)

---

## 8. Keyboard Shortcuts

### Global

| Action | Shortcut |
|--------|----------|
| Search Everywhere | `⌘⇧P` or `Shift Shift` |
| Go to File | `⌘P` |
| Go to Symbol | `⌘⇧O` |
| Go to Action | `⌘⇧A` |
| Switch Workspace | `⌘⇧W` |
| Toggle Terminal | `` ⌘` `` |
| Toggle Sidebar | `⌘B` |
| Settings | `⌘,` |

### Run Profiles

| Action | Shortcut |
|--------|----------|
| Run selected profile | `⌘R` |
| Run last compound | `⌘⇧R` |
| Stop current | `⌘.` |
| Switch env variant | `⌘E` |

### Editor

| Action | Shortcut |
|--------|----------|
| Save (auto-save, but manual trigger) | `⌘S` |
| Find in file | `⌘F` |
| Find and replace | `⌘⇧F` (project) / `⌘H` (file) |
| Go to line | `⌘G` |
| Go to definition | `⌘Click` or `F12` |
| Find usages | `⌥F7` |
| Rename | `F6` |
| Quick fix | `⌥Enter` |
| Format file | `⌥⌘L` |

### Navigation

| Action | Shortcut |
|--------|----------|
| Back | `⌘[` |
| Forward | `⌘]` |
| Recent files | `⌘E` |
| Next tab | `⌘⇧]` |
| Previous tab | `⌘⇧[` |
| Close tab | `⌘W` |
| Split right | `⌘\` |

### Search Palette

| Action | Shortcut |
|--------|----------|
| Navigate results | `↑` / `↓` |
| Open selected | `Enter` |
| Open in split | `⌘Enter` |
| Cycle filter tabs | `Tab` |
| Cycle scope | `⌘/` |
| Close | `Esc` |

---

## 9. Component Specifications

### Header Bar

- Height: 40px
- Background: Frame color (`#0A0E14`)
- Contains: App logo, workspace selector, profile selector, env toggle, search trigger, settings

### Sidebar

- Default width: 260px
- Min width: 200px
- Max width: 400px
- Resizable with drag handle
- Background: `#0D1117`

### Tab Bar

- Height: 36px
- Background: `#1C2128`
- Active tab: Editor background color (`#1E2228`) with accent left border
- Tab shows: File icon, filename, close button on hover

### Editor

- Background: `#1E2228`
- Gutter: Slightly darker than editor
- Active line: Subtle highlight
- Selection: Accent color at 20% opacity

### Tool Panels (Bottom)

- Default height: 200px
- Min height: 100px
- Background: `var(--surface-panel)` (`#060A0E`)
- **Unified tab bar**: Single row with panel tabs (Output, Problems, Terminal) on the left and session tabs on the right, separated by a vertical divider. Session tabs only appear when the Terminal panel is active.
- **Fixed glacier accent** (`--accent-project`, `#38BDF8`): The bottom panel uses `data-accent="project"` to scope its own accent independently of the workspace accent. This gives the terminal a consistent identity across all workspaces. The CSS uses `color-mix(in srgb, var(--accent) N%, transparent)` for all opacity variants, so if this decision changes later, removing the scoped `data-accent` will make it follow the workspace accent automatically.
- **Terminal session features**: Multi-session tabs with drag-and-drop reorder, double-click rename, right-click context menu (Rename, Close Terminal), inline rename input, and a "+" button for new sessions.
- **xterm.js theme**: Near-black background (`#0A0A0C`), warm parchment foreground (`#D4C4B0`), orange cursor and selection highlight. ANSI colors are neutral and do not change with accent.

### Status Bar

- Height: 24px
- Background: Frame color (`#0A0E14`)
- Contains: Language mode, encoding, line/col, git branch, running profiles

---

## Appendix: Design Tokens

For implementation, extract these as CSS custom properties or design tokens:

```css
:root {
  /* Surfaces */
  --surface-frame: #0A0E14;
  --surface-sidebar: #0D1117;
  --surface-tool-panel: #161B22;
  --surface-tab-bar: #1C2128;
  --surface-editor: #1E2228;
  --surface-hover: #21262D;
  --surface-border: #30363D;

  /* Text */
  --text-primary: #E6EDF3;
  --text-secondary: #8B949E;
  --text-muted: #6E7681;
  --text-disabled: #484F58;

  /* Workspace accents — see the Accent Colors table above for the constraints
     these values satisfy. Keep in sync with frontend/src/styles/tokens.css. */
  --accent-frontend: #F0389D;
  --accent-node: #8FC606;
  --accent-python: #BFAD00;
  --accent-go: #12B5CD;
  --accent-rust: #E2703A;
  --accent-docker: #0573D7;
  --accent-terraform: #A855F7;
  --accent-project: #38BDF8;
  --accent-general: #6B7280;

  /* Semantic */
  --status-success: #22C55E;
  --status-warning: #F59E0B;
  --status-error: #EF4444;
  --status-info: #3B82F6;

  /* Sizing */
  --header-height: 40px;
  --tab-bar-height: 36px;
  --status-bar-height: 24px;
  --sidebar-width: 260px;
  --tool-panel-height: 200px;

  /* Radii */
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
}
```

---

## 10. AI Chat Panel

### Overview

An AI assistant panel for context-aware coding assistance. Primary provider is Claude, with architecture supporting multiple providers (Codex, Gemini, etc.) and multi-panel layouts.

### Panel Location

**Code Mode:** Right sidebar panel, collapsible
- Can be detached to floating window
- Multiple panels can be open simultaneously (v2.5+)

**Keyboard:** `⌘⇧I` toggles AI panel

### Layout

```
┌─ AI ASSISTANT ─────────────────────────────────────────────────────┐
│ [Claude ▾] [+ Add]                            [Context: Auto ▾] [⚙]│
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│ 🤖 Claude                                                          │
│ ──────────────────────────────────────────────────────────────────│
│ I can see you're working on `Button.tsx`. The TypeScript error     │
│ on line 42 is because `onClick` is marked as required in your      │
│ `ButtonProps` interface but you're not passing it.                 │
│                                                                    │
│ **Two options:**                                                   │
│                                                                    │
│ 1. Make `onClick` optional:                                        │
│    ```typescript                                                   │
│    onClick?: () => void;                                           │
│    ```                                                             │
│                                                                    │
│ 2. Provide a default no-op:                                        │
│    ```typescript                                                   │
│    onClick = () => {}                                              │
│    ```                                                             │
│                                                                    │
│ [Apply Option 1] [Apply Option 2] [Explain More]                   │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│ 👤 You                                                             │
│ Why is my onClick handler not being called?                        │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│ [Ask about selection] [Explain file] [Find bugs] [Refactor]        │
├────────────────────────────────────────────────────────────────────┤
│ > Type a message...                                    [Send ⌘↩]   │
└────────────────────────────────────────────────────────────────────┘
```

### Context Modes

| Mode | Behavior |
|------|----------|
| **Auto** | Includes current file, selection, recent errors, workspace info |
| **Selection Only** | Only includes selected code |
| **File Only** | Includes entire current file |
| **Workspace** | Includes workspace structure and relevant files |
| **Custom** | User specifies which files/context to include |

### Provider Selector

```
┌─ Select Provider ──────────────────┐
│ ● Claude (Primary)                 │
│ ○ Claude (via API key)             │
│ ○ OpenAI GPT-4                     │
│ ○ OpenAI Codex                     │
│ ○ Google Gemini                    │
│ ○ Ollama (Local)                   │
│ ─────────────────────────────────  │
│ + Configure Providers...           │
└────────────────────────────────────┘
```

### Quick Actions

Buttons for common tasks:
- **Ask about selection** — Explain highlighted code
- **Explain file** — Overview of current file's purpose
- **Find bugs** — Analyze for potential issues
- **Refactor** — Suggest improvements
- **Write tests** — Generate test cases
- **Document** — Add comments/docstrings

### Code Application

When AI suggests code changes:

```
┌─ Apply Changes ────────────────────────────────────────────────────┐
│                                                                    │
│ Button.tsx (line 9)                                                │
│ ──────────────────────────────────────────────────────────────────│
│ - onClick: () => void;                                             │
│ + onClick?: () => void;                                            │
│ ──────────────────────────────────────────────────────────────────│
│                                                                    │
│                    [Reject] [Edit] [Apply]                         │
└────────────────────────────────────────────────────────────────────┘
```

- Shows diff preview before applying
- User can edit suggestion before applying
- Undo available after apply

### Multi-Panel Layout (v2.5+)

Multiple AI assistants visible simultaneously:

```
┌─────────────────────────────────────────────────────────────────────┐
│ [Explorer] │ [Editor]                │ [Claude]    │ [Codex]       │
│            │                         │             │               │
│            │                         │ chat...     │ chat...       │
│            │                         │             │               │
└─────────────────────────────────────────────────────────────────────┘
```

**Broadcast Mode:** Send same prompt to all active AI panels, compare responses

### Provider Configuration

```
┌─ SETTINGS: AI Providers ───────────────────────────────────────────┐
│                                                                    │
│ ─── Claude ────────────────────────────────────────────────────── │
│ API Key:        [sk-ant-••••••••••••••••••••] [Test]               │
│ Model:          [claude-sonnet-4-20250514 ▾]                           │
│ Max Tokens:     [4096        ]                                     │
│                                                                    │
│ ─── OpenAI ───────────────────────────────────────────────────── │
│ API Key:        [sk-••••••••••••••••••••    ] [Test]               │
│ Model:          [gpt-4-turbo ▾]                                    │
│                                                                    │
│ ─── Ollama (Local) ───────────────────────────────────────────── │
│ Host:           [http://localhost:11434     ]                      │
│ Model:          [codellama:13b ▾]                                  │
│                                                                    │
│                                           [Save] [Cancel]          │
└────────────────────────────────────────────────────────────────────┘
```

### Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Toggle AI panel | `⌘⇧I` |
| Send message | `⌘↩` |
| New conversation | `⌘⇧N` |
| Clear conversation | `⌘K` |
| Ask about selection | `⌘⇧E` |

---

## 11. Keyboard Shortcuts (Extended)

### AI Panel

| Action | Shortcut |
|--------|----------|
| Toggle AI panel | `⌘⇧I` |
| Send message | `⌘↩` |
| New conversation | `⌘⇧N` |
| Clear conversation | `⌘K` |
| Ask about selection | `⌘⇧E` |
| Focus AI input | `⌘⇧;` |

---

## Appendix: Roadmap Summary

### v1.0 — Core IDE
- IDE shell with workspaces, run profiles, search
- File explorer, editor, terminal
- Git integration
- Theme and visual identity

### v1.5 — AI Chat Panel
- Claude integration (primary)
- Context-aware assistance
- Code application with diff preview
- Provider architecture (ready for multi-provider)

### v2.0+ — Service Integration
- gRPC Service Adapter Pattern
- Multiple AI panels visible simultaneously
- Broadcast mode (compare AI responses)

---

*Document version: 3.0*
*Last updated: February 2026*
