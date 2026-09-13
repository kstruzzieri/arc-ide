import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from '../../components/ErrorBoundary';

function Thrower(): never {
  throw new Error('boom');
}

it('styles the reload button through the stylesheet the token pin reads', () => {
  // React and componentDidCatch both log the caught error; keep the run quiet.
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    // tokens.test.ts pins ErrorBoundary.module.css `.reload` to
    // --text-on-accent; that only reaches the screen if the button carries
    // the class. identity-obj-proxy maps styles.reload to 'reload'.
    render(
      <ErrorBoundary>
        <Thrower />
      </ErrorBoundary>
    );
    expect(screen.getByRole('button', { name: 'Reload Application' })).toHaveClass('reload');
  } finally {
    spy.mockRestore();
  }
});
