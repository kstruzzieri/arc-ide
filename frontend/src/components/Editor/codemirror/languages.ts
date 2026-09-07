import { LanguageDescription, type LanguageSupport } from '@codemirror/language';

const languages = [
  LanguageDescription.of({
    name: 'JavaScript',
    extensions: ['js', 'mjs', 'cjs'],
    load: () => import('@codemirror/lang-javascript').then(({ javascript }) => javascript()),
  }),
  LanguageDescription.of({
    name: 'JSX',
    extensions: ['jsx'],
    load: () =>
      import('@codemirror/lang-javascript').then(({ javascript }) => javascript({ jsx: true })),
  }),
  LanguageDescription.of({
    name: 'TypeScript',
    extensions: ['ts', 'mts', 'cts'],
    load: () =>
      import('@codemirror/lang-javascript').then(({ javascript }) =>
        javascript({ typescript: true })
      ),
  }),
  LanguageDescription.of({
    name: 'TSX',
    extensions: ['tsx'],
    load: () =>
      import('@codemirror/lang-javascript').then(({ javascript }) =>
        javascript({ jsx: true, typescript: true })
      ),
  }),
  LanguageDescription.of({
    name: 'Python',
    extensions: ['py', 'pyw', 'pyi'],
    load: () => import('@codemirror/lang-python').then(({ python }) => python()),
  }),
  LanguageDescription.of({
    name: 'Go',
    extensions: ['go'],
    load: () => import('@codemirror/lang-go').then(({ go }) => go()),
  }),
  LanguageDescription.of({
    name: 'CSS',
    extensions: ['css', 'scss', 'less'],
    load: () => import('@codemirror/lang-css').then(({ css }) => css()),
  }),
  LanguageDescription.of({
    name: 'HTML',
    extensions: ['html', 'htm'],
    load: () => import('@codemirror/lang-html').then(({ html }) => html()),
  }),
  LanguageDescription.of({
    name: 'JSON',
    extensions: ['json', 'jsonc'],
    load: () => import('@codemirror/lang-json').then(({ json }) => json()),
  }),
  LanguageDescription.of({
    name: 'Markdown',
    extensions: ['md', 'markdown'],
    load: () => import('@codemirror/lang-markdown').then(({ markdown }) => markdown()),
  }),
  LanguageDescription.of({
    name: 'XML',
    extensions: ['xml', 'xsl', 'xslt', 'svg', 'plist'],
    load: () => import('@codemirror/lang-xml').then(({ xml }) => xml()),
  }),
  LanguageDescription.of({
    name: 'YAML',
    extensions: ['yml', 'yaml'],
    load: () => import('@codemirror/lang-yaml').then(({ yaml }) => yaml()),
  }),
  LanguageDescription.of({
    name: 'Rust',
    extensions: ['rs'],
    load: () => import('@codemirror/lang-rust').then(({ rust }) => rust()),
  }),
];

export function getLanguageDescription(filename: string): LanguageDescription | null {
  return LanguageDescription.matchFilename(languages, filename.toLowerCase());
}

export async function loadLanguageSupport(filename: string): Promise<LanguageSupport | null> {
  const description = getLanguageDescription(filename);
  if (!description) return null;

  try {
    return await description.load();
  } catch (error) {
    console.error(
      `Failed to load CodeMirror language "${description.name}" for "${filename}":`,
      error
    );
    return null;
  }
}

export function getLoadedLanguageSupport(filename: string): LanguageSupport | null {
  return getLanguageDescription(filename)?.support ?? null;
}
