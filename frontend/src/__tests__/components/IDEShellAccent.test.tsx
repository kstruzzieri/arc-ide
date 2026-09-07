import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IDEShell } from '../../components/layout';
import { useIDEStore } from '../../stores/ideStore';
import { isMac } from '../../utils/platform';

const mockEventsOn = jest.fn().mockReturnValue(jest.fn());
const mockNavigateToEditorLocation = jest.fn();

jest.mock('../../wails/bindings', () => ({
  ToggleMaximize: jest.fn(),
}));
jest.mock('../../wails/runtime', () => ({
  EventsOn: (...args: unknown[]) => mockEventsOn(...args),
  WindowSetTitle: jest.fn(),
}));
jest.mock('../../utils/editorNavigation', () => ({
  navigateToEditorLocation: (...args: unknown[]) => mockNavigateToEditorLocation(...args),
}));

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: jest.fn(),
  });
});

const createShell = (accent?: 'project' | 'general') => (
  <IDEShell
    accent={accent}
    header={() => <div />}
    sidebar={<div />}
    leftPanel={<div />}
    centerPanel={<div />}
    golemPanel={() => <div />}
    bottomPanel={<div />}
    rightPanel={<div />}
    statusBar={<div />}
  />
);

it('applies data-accent="general"', () => {
  const { container } = render(
    <IDEShell
      accent="general"
      header={() => <div />}
      sidebar={<div />}
      leftPanel={<div />}
      centerPanel={<div />}
      golemPanel={() => <div />}
      bottomPanel={<div />}
      rightPanel={<div />}
      statusBar={<div />}
    />
  );
  expect(container.querySelector('[data-accent="general"]')).not.toBeNull();
});

it('renders a skip link before the shell chrome and a focusable main target', () => {
  const { container } = render(
    <IDEShell
      header={() => <div />}
      sidebar={<div />}
      leftPanel={<div />}
      centerPanel={<div />}
      golemPanel={() => <div />}
      bottomPanel={<div />}
      rightPanel={<div />}
      statusBar={<div />}
    />
  );

  const skipLink = screen.getByRole('link', { name: 'Skip to main content' });
  const main = screen.getByRole('main');

  expect(skipLink).toHaveAttribute('href', '#main-content');
  expect(container.firstElementChild?.firstElementChild).toBe(skipLink);
  expect(main).toHaveAttribute('id', 'main-content');
  expect(main).toHaveAttribute('tabindex', '-1');
});

it('opens and focuses the real command palette from the platform shortcut', async () => {
  render(createShell());

  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'P',
        metaKey: isMac(),
        ctrlKey: !isMac(),
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
  });

  expect(screen.getByRole('dialog', { name: 'Command palette' })).toHaveAttribute('open');
  await waitFor(() =>
    expect(screen.getByRole('combobox', { name: 'Command palette' })).toHaveFocus()
  );
});

it('does not resubscribe global shortcuts when IDEShell rerenders', () => {
  mockEventsOn.mockClear();
  const { rerender } = render(createShell());

  expect(mockEventsOn).toHaveBeenCalledTimes(2);

  rerender(createShell('general'));

  expect(mockEventsOn).toHaveBeenCalledTimes(2);
});

it('blocks native navigation while the palette is open and restores it after close', () => {
  mockEventsOn.mockClear();
  mockNavigateToEditorLocation.mockClear();
  useIDEStore.setState(useIDEStore.getInitialState());
  useIDEStore.setState({ activeFileId: '/current.ts' });
  useIDEStore.getState().pushNavigationHistory({ fileId: '/previous.ts', line: 3, column: 2 });
  render(createShell());

  const backCallback = mockEventsOn.mock.calls.find(([event]) => event === 'navigate:back')?.[1] as
    | (() => void)
    | undefined;
  expect(backCallback).toBeDefined();

  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'P',
        metaKey: isMac(),
        ctrlKey: !isMac(),
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
  });
  act(() => backCallback!());

  expect(mockEventsOn).toHaveBeenCalledTimes(2);
  expect(mockNavigateToEditorLocation).not.toHaveBeenCalled();
  expect(useIDEStore.getState().navigationHistory).toHaveLength(1);

  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Command palette' }), {
    key: 'Escape',
  });
  act(() => backCallback!());

  expect(mockEventsOn).toHaveBeenCalledTimes(2);
  expect(mockNavigateToEditorLocation).toHaveBeenCalledWith('/previous.ts', 3, 2);
  expect(useIDEStore.getState().navigationHistory).toHaveLength(0);
});
