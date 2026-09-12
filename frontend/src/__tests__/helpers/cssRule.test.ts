import { cssRule } from './cssRule';

// The stylesheet guards in styles/ and utils/ read real CSS through this
// helper, so each guarantee they lean on gets one direct check here.
// Every decoy precedes the real `.dialog` block: a match that is too loose
// binds to the first candidate, so ordering them last would let it pass.
const sheet = `
/* .dialog { color: decoy; } */
.dialogTitle {
  color: blue;
}
.root .dialog {
  color: green;
}
.dialog {
  /* a } inside a comment must not end the body */
  color: red;
}
`;

it('strips comments before matching, so a } or a decoy selector in one is ignored', () => {
  expect(cssRule(sheet, '.dialog')).toMatch(/color:\s*red/);
  expect(cssRule(sheet, '.dialog')).not.toMatch(/decoy|inside a comment/);
});

it('requires { to follow the selector, so .dialog cannot bind to .dialogTitle', () => {
  expect(cssRule(sheet, '.dialogTitle')).toMatch(/color:\s*blue/);
  expect(cssRule(sheet, '.dialog')).not.toMatch(/blue/);
});

it('anchors the selector to a line start, so a compound cannot satisfy its last part', () => {
  expect(cssRule(sheet, '.root .dialog')).toMatch(/color:\s*green/);
  expect(cssRule(sheet, '.dialog')).not.toMatch(/green/);
  expect(() => cssRule('.root .dialog { color: green; }', '.dialog')).toThrow(
    'Missing CSS rule .dialog'
  );
});

it('throws when the rule is missing rather than returning an empty body', () => {
  expect(() => cssRule(sheet, '.missing')).toThrow('Missing CSS rule .missing');
});
