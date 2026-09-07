import type { LanguageSupport } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import {
  getLanguageDescription,
  getLoadedLanguageSupport,
  loadLanguageSupport,
} from '../../../../components/Editor/codemirror/languages';

jest.mock('@codemirror/lang-javascript', () => ({ javascript: jest.fn() }));
jest.mock('@codemirror/lang-python', () => ({ python: jest.fn() }));
jest.mock('@codemirror/lang-go', () => ({ go: jest.fn() }));
jest.mock('@codemirror/lang-css', () => ({ css: jest.fn() }));
jest.mock('@codemirror/lang-html', () => ({ html: jest.fn() }));
jest.mock('@codemirror/lang-json', () => ({ json: jest.fn() }));
jest.mock('@codemirror/lang-markdown', () => ({ markdown: jest.fn() }));
jest.mock('@codemirror/lang-xml', () => ({ xml: jest.fn() }));
jest.mock('@codemirror/lang-yaml', () => ({ yaml: jest.fn() }));
jest.mock('@codemirror/lang-rust', () => ({ rust: jest.fn() }));

const support = (name: string) => ({ name }) as unknown as LanguageSupport;
const mockedJavascript = jest.mocked(javascript);

describe('CodeMirror language registry', () => {
  beforeEach(() => mockedJavascript.mockClear());

  it.each([
    ['file.js', 'JavaScript'],
    ['file.mjs', 'JavaScript'],
    ['file.cjs', 'JavaScript'],
    ['file.jsx', 'JSX'],
    ['file.ts', 'TypeScript'],
    ['file.mts', 'TypeScript'],
    ['file.cts', 'TypeScript'],
    ['file.tsx', 'TSX'],
    ['file.py', 'Python'],
    ['file.pyw', 'Python'],
    ['file.pyi', 'Python'],
    ['file.go', 'Go'],
    ['file.css', 'CSS'],
    ['file.scss', 'CSS'],
    ['file.less', 'CSS'],
    ['file.html', 'HTML'],
    ['file.htm', 'HTML'],
    ['file.json', 'JSON'],
    ['file.jsonc', 'JSON'],
    ['file.md', 'Markdown'],
    ['file.markdown', 'Markdown'],
    ['file.xml', 'XML'],
    ['file.xsl', 'XML'],
    ['file.xslt', 'XML'],
    ['file.svg', 'XML'],
    ['file.plist', 'XML'],
    ['file.yml', 'YAML'],
    ['file.yaml', 'YAML'],
    ['file.rs', 'Rust'],
  ])('maps %s to the %s variant', (filename, name) => {
    expect(getLanguageDescription(filename)?.name).toBe(name);
  });

  it('matches extensions case-insensitively', () => {
    expect(getLanguageDescription('/tmp/Component.TSX')?.name).toBe('TSX');
  });

  it('returns null for unsupported filenames', async () => {
    expect(getLanguageDescription('notes.txt')).toBeNull();
    expect(getLoadedLanguageSupport('notes.txt')).toBeNull();
    await expect(loadLanguageSupport('notes.txt')).resolves.toBeNull();
  });

  it('de-duplicates in-flight and resolved loads and exposes loaded support synchronously', async () => {
    const typescriptSupport = support('typescript');
    mockedJavascript.mockReturnValueOnce(typescriptSupport);

    const [first, second] = await Promise.all([
      loadLanguageSupport('first.ts'),
      loadLanguageSupport('second.mts'),
    ]);

    expect(first).toBe(typescriptSupport);
    expect(second).toBe(typescriptSupport);
    expect(mockedJavascript).toHaveBeenCalledTimes(1);

    await expect(loadLanguageSupport('third.cts')).resolves.toBe(typescriptSupport);
    expect(mockedJavascript).toHaveBeenCalledTimes(1);
    expect(getLoadedLanguageSupport('fourth.ts')).toBe(typescriptSupport);
  });

  it('logs contextual failures, falls back to plain text, and retries later', async () => {
    const error = new Error('chunk failed');
    const javascriptSupport = support('javascript');
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockedJavascript.mockImplementationOnce(() => {
      throw error;
    });
    mockedJavascript.mockReturnValueOnce(javascriptSupport);

    await expect(loadLanguageSupport('broken.MJS')).resolves.toBeNull();
    expect(getLoadedLanguageSupport('broken.MJS')).toBeNull();
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to load CodeMirror language "JavaScript" for "broken.MJS":',
      error
    );

    await expect(loadLanguageSupport('broken.MJS')).resolves.toBe(javascriptSupport);
    expect(mockedJavascript).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });
});
