import { readFileSync } from 'fs';
import { resolve } from 'path';
import { cssRule } from '../helpers/cssRule';

const css = readFileSync(resolve(__dirname, '../../styles/reset.css'), 'utf8');

describe('reset.css', () => {
  // The universal `margin: 0` cancels the UA stylesheet's `dialog { margin: auto }`,
  // the rule that centres a showModal() dialog; without it a modal that declares
  // no margin of its own draws at the window's top-left, under the transparent
  // macOS titlebar. Restored at element specificity so every module `.dialog` still
  // wins its own margin.
  it('restores the UA dialog margin the universal reset removes', () => {
    expect(cssRule(css, 'dialog')).toMatch(/^\s*margin: auto;$/m);
  });
});
