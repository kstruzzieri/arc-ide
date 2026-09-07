# Issue #39: Dynamic CodeMirror Language Loading

## Issue Summary

Move CodeMirror language implementations out of the initial application graph. Editors and Git diffs start as usable plain text, load only the required language support, and reconfigure their existing CodeMirror views without losing editor state.

## Acceptance Criteria

- [x] All existing filename mappings keep their previous CodeMirror parser configuration.
- [x] Concurrent and repeated loads share CodeMirror's cached in-flight/resolved support by language variant.
- [x] Main-editor and diff loads cannot apply to a replaced file, session, view, or unmounted component.
- [x] Unsupported extensions and failed chunk loads remain usable plain text.
- [x] Hover signatures synchronously reuse an already-loaded parser and otherwise retain the regex fallback.
- [x] No `@codemirror/lang-*` implementation is statically reachable from the application entry.
- [x] The eager `codemirror-languages` manual chunk is gone.
- [x] A manifest-based production check prevents a future static-import regression.
- [x] No dependencies, backend APIs, generated Wails bindings, stores, roadmap, or README were changed.

## Test Strategy

- Exercise every supported extension, case-insensitive matching, and unsupported filenames.
- Verify resolved and concurrent loads are cached, a rejection becomes plain text, and a later call can retry.
- Begin fresh editor states with an empty language compartment, then test successful reconfiguration, rapid A-to-B and A-to-B-to-A switches, and unmount.
- Verify both Git diff panes use separate compartments and ignore results for replaced sessions or unmounted views.
- Verify hover rendering uses the regex fallback before a parser loads and the real parser afterward.
- Build with a Vite manifest, walk every static import from the application entry, require ten dynamic language entries, and reject the former aggregate chunk.
- Run the complete frontend and Go suites plus lint, formatting, production build, and diff hygiene checks.

## TDD: Before

The loader tests initially failed because the registry did not exist:

```text
Cannot find module '../../../../components/Editor/codemirror/languages'
```

The editor tests then failed because language support was still constructed synchronously and no guarded async reconfiguration occurred. Six assertions covering initial plain text, successful load, rapid switches, unmount, and hover parser reuse were red.

The four new diff tests were also red because neither pane had an async language compartment.

For the bundle check, a deliberately reachable static Python parser produced Vite's static/dynamic import warning and this expected failure:

```text
Error: CodeMirror language bundle regression:
- missing dynamic manifest entry for @codemirror/lang-python
```

## TDD: After

Focused editor and diff regression run:

```text
Test Suites: 7 passed, 7 total
Tests:       105 passed, 105 total
```

Complete frontend run:

```text
Test Suites: 134 passed, 134 total
Tests:       1490 passed, 1490 total
```

## Language Registry

| Variant | Extensions | Dynamic package |
| --- | --- | --- |
| JavaScript | `js`, `mjs`, `cjs` | `@codemirror/lang-javascript` |
| JSX | `jsx` | `@codemirror/lang-javascript` |
| TypeScript | `ts`, `mts`, `cts` | `@codemirror/lang-javascript` |
| TSX | `tsx` | `@codemirror/lang-javascript` |
| Python | `py`, `pyw`, `pyi` | `@codemirror/lang-python` |
| Go | `go` | `@codemirror/lang-go` |
| CSS | `css`, `scss`, `less` | `@codemirror/lang-css` |
| HTML | `html`, `htm` | `@codemirror/lang-html` |
| JSON | `json`, `jsonc` | `@codemirror/lang-json` |
| Markdown | `md`, `markdown` | `@codemirror/lang-markdown` |
| XML | `xml`, `xsl`, `xslt`, `svg`, `plist` | `@codemirror/lang-xml` |
| YAML | `yml`, `yaml` | `@codemirror/lang-yaml` |
| Rust | `rs` | `@codemirror/lang-rust` |

`LanguageDescription.load()` supplies the in-flight/resolved cache and clears its pending state after rejection, so the implementation adds no second cache or dependency.

## Bundle Evidence

Before, the manual `codemirror-languages-DMEX_p_I.js` chunk was part of the initial graph at 382,348 raw / 143,214 gzip bytes:

| Initial chunk | Raw bytes | Gzip bytes |
| --- | ---: | ---: |
| Application | 409,914 | 126,087 |
| Zustand | 8,349 | 3,250 |
| React | 184,035 | 57,586 |
| CodeMirror core | 394,531 | 128,061 |
| CodeMirror languages | 382,348 | 143,214 |
| Xterm | 330,507 | 83,050 |
| **Total** | **1,709,684** | **541,248** |

After, the initial static graph contains no language implementation or aggregate language chunk:

| Initial chunk | Raw bytes | Gzip bytes |
| --- | ---: | ---: |
| Application | 413,837 | 127,282 |
| Zustand | 8,349 | 3,250 |
| React | 184,035 | 57,586 |
| CodeMirror core | 394,531 | 128,057 |
| Xterm | 330,507 | 83,050 |
| **Total** | **1,331,259** | **399,225** |

The initial graph fell by **378,425 raw bytes (22.13%)** and **142,023 gzip bytes (26.24%)**. The manifest records all ten `@codemirror/lang-*` packages as dynamic entries. HTML and Markdown naturally import their package-required embedded-language chunks (JavaScript/CSS/HTML); those remain outside the initial graph and load only with those formats.

`npm run build` now generates the manifest and runs `scripts/check-language-bundle.mjs`. The standalone `npm run check:language-bundle` command can recheck the fresh output without rebuilding.

## Automated Verification

```text
npm test -- --runInBand        134 suites / 1490 tests passed
npm run lint                   0 errors (12 pre-existing warnings)
npm run format:check           passed
npm run build                  passed, including bundle graph check
go test ./...                  660 tests passed in 12 packages
wails build                    packaged darwin/arm64 application successfully
```
