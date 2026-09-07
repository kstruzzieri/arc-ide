import { readFileSync } from 'fs';
import { relative, resolve } from 'path';
import ts from 'typescript';

// Bespoke AST check instead of react/button-has-type: eslint-plugin-react is
// not installed and the lint config stays minimal on purpose. Unlike a
// presence-only check, this also validates the value, because an invalid or
// non-literal type falls back to the HTML default of "submit".
const sourceRoot = resolve(__dirname, '..');
const VALID_TYPES = new Set(['button', 'submit', 'reset']);

function typeProblem(attr: ts.JsxAttribute | undefined, source: ts.SourceFile): string | null {
  if (!attr) {
    return '(no explicit type; a type inside a {...spread} does not count — add a literal type after the spread)';
  }
  if (!attr.initializer || !ts.isStringLiteral(attr.initializer)) {
    return `(non-literal type ${attr.initializer ? attr.initializer.getText(source) : ''}; use a string literal)`;
  }
  if (!VALID_TYPES.has(attr.initializer.text)) {
    return `(invalid type "${attr.initializer.text}")`;
  }
  return null;
}

it('requires an explicit literal type on every production button', () => {
  const invalid: string[] = [];
  let buttonCount = 0;

  const files = ts.sys.readDirectory(
    sourceRoot,
    ['.tsx'],
    ['**/__tests__/**', '**/*.test.tsx', '**/*.spec.tsx'],
    ['**/*.tsx']
  );
  expect(files.length).toBeGreaterThan(0);

  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      false,
      ts.ScriptKind.TSX
    );

    const visit = (node: ts.Node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.tagName.getText(source) === 'button'
      ) {
        buttonCount += 1;
        const typeAttr = node.attributes.properties.find(
          (property): property is ts.JsxAttribute =>
            ts.isJsxAttribute(property) && property.name.getText(source) === 'type'
        );
        const problem = typeProblem(typeAttr, source);
        if (problem) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          invalid.push(`${relative(sourceRoot, file)}:${line + 1} ${problem}`);
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
  }

  expect(invalid).toEqual([]);
  // Guard against a vacuous pass if the directory scan silently breaks.
  expect(buttonCount).toBeGreaterThan(50);
});
