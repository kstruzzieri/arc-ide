/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/src/setupTests.ts'],
  moduleNameMapper: {
    '\\.(css|less|scss|sass)$': 'identity-obj-proxy',
    '\\.svg$': '<rootDir>/src/__mocks__/svgMock.js',
    '^@/(.*)$': '<rootDir>/src/$1',
    // The `$` anchor is load-bearing: it must not capture wails/runtime-helpers,
    // whose test exercises the real registration code.
    '(?:\\.\\./)+wails/runtime$': '<rootDir>/src/__mocks__/wailsRuntime.js',
    '^@wailsio/runtime$': '<rootDir>/src/__mocks__/wailsV3Runtime.js',
    // The generated bindings are ESM and spell relative imports with an explicit
    // `.js` extension ('./internal/ai/models.js'); jest's CJS resolver would look
    // for a literal .js file. Dropping the extension lets moduleFileExtensions
    // find the .ts source (and still finds real .js files in node_modules ESM).
    // Deliberately repo-wide rather than scoped to bindings/: jest maps by
    // import specifier, not by the importing file, so there is no scope to
    // narrow it to -- and the fallback resolves real .js files unchanged.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    // Also matches .js so ts-jest can down-level the ESM-only react-markdown
    // tree (see transformIgnorePatterns). isolatedModules = transpile only, so
    // ts-jest never tries to type-check those node_modules sources.
    '^.+\\.[jt]sx?$': [
      'ts-jest',
      {
        // tsconfig.json sets isolatedModules: true, so ts-jest transpiles only
        // and never type-checks the ESM node_modules sources allowed through
        // transformIgnorePatterns below.
        tsconfig: {
          jsx: 'react-jsx',
          allowJs: true,
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
        },
      },
    ],
  },
  // react-markdown 9 / remark-gfm 4 and their whole unified/micromark/mdast/hast
  // dependency tree ship ESM only; jest ignores node_modules by default, so let
  // just that tree through to the transform above. Prefix families below are all
  // exclusively markdown-ecosystem packages, save @wailsio/runtime: the package
  // itself is mapped to the mock above, but runtimeMockFidelity.test.ts loads
  // the shipped dist/create.js by file path to hold the mock's copy against it.
  // ponytail: hand-scoped allow-list. If a version bump adds a new transitive
  // ESM dep outside these families, a Golem test fails with "Unexpected token
  // 'export'" naming the package — add it here.
  transformIgnorePatterns: [
    'node_modules/(?!(' +
      [
        'react-markdown',
        'remark-[a-z-]+',
        'micromark[a-z-]*',
        'mdast-util-[a-z-]+',
        'unist-util-[a-z-]+',
        'hast-util-[a-z-]+',
        'vfile[a-z-]*',
        'character-(entities[a-z0-9-]*|reference-invalid)',
        'is-(alphabetical|alphanumerical|decimal|hexadecimal|plain-obj)',
        '@ungap/structured-clone',
        '@wailsio/runtime',
        'bail',
        'ccount',
        'comma-separated-tokens',
        'decode-named-character-reference',
        'devlop',
        'escape-string-regexp',
        'estree-util-is-identifier-name',
        'html-url-attributes',
        'longest-streak',
        'markdown-table',
        'parse-entities',
        'property-information',
        'space-separated-tokens',
        'stringify-entities',
        'trim-lines',
        'trough',
        'unified',
        'zwitch',
      ].join('|') +
      ')/)',
  ],
  testMatch: ['**/__tests__/**/*.test.ts?(x)', '**/?(*.)+(spec|test).ts?(x)'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/main.tsx',
    '!src/vite-env.d.ts',
  ],
  coverageThreshold: {
    global: {
      branches: 20,
      functions: 40,
      lines: 40,
      statements: 40,
    },
  },
};
