import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommandPalette } from '../../components/CommandPalette';
import type { Command } from '../../utils/commands';
import { formatShortcut } from '../../utils/platform';

jest.mock('../../wails/bindings', () => ({}));

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

const actions = {
  open: jest.fn(),
  sidebar: jest.fn(),
  test: jest.fn(),
};

const commands: readonly Command[] = [
  {
    id: 'open-folder',
    title: 'Open Folder',
    keywords: ['workspace'],
    shortcut: '⌘O',
    run: actions.open,
  },
  { id: 'toggle-sidebar', title: 'Toggle Sidebar', run: actions.sidebar },
  {
    id: 'run-tests',
    title: 'Run Tests',
    keywords: ['verify'],
    shortcut: '⌘⇧T',
    run: actions.test,
  },
];

beforeEach(() => {
  jest.clearAllMocks();
});

function renderPalette(overrides: Partial<React.ComponentProps<typeof CommandPalette>> = {}) {
  const onClose = overrides.onClose ?? jest.fn();
  const result = render(
    <CommandPalette open commands={commands} onClose={onClose} {...overrides} />
  );
  return { ...result, onClose };
}

test('exposes native dialog, combobox, listbox, option, focus, and shortcut semantics', async () => {
  renderPalette();

  const dialog = screen.getByRole('dialog', { name: 'Command palette' });
  const combobox = screen.getByRole('combobox', { name: 'Command palette' });
  const listbox = screen.getByRole('listbox', { name: 'Commands' });
  const options = screen.getAllByRole('option');

  expect(dialog.tagName).toBe('DIALOG');
  expect(dialog).toHaveAttribute('open');
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  expect(combobox).toHaveAttribute('aria-controls', listbox.id);
  expect(combobox).toHaveAttribute('aria-expanded', 'true');
  expect(combobox).toHaveAttribute('aria-autocomplete', 'list');
  expect(combobox).toHaveAttribute('aria-activedescendant', options[0].id);
  expect(options[0]).toHaveAttribute('aria-selected', 'true');
  expect(options[1]).toHaveAttribute('aria-selected', 'false');
  expect(options[0]).toHaveAttribute('type', 'button');
  expect(options[0]).toHaveAttribute('tabindex', '-1');
  expect(within(options[2]).getByText(formatShortcut('⌘⇧T')).tagName).toBe('KBD');
  await waitFor(() => expect(combobox).toHaveFocus());
});

test('filters commands and repairs the active descendant to the first remaining option', async () => {
  const user = userEvent.setup();
  renderPalette();
  const combobox = screen.getByRole('combobox', { name: 'Command palette' });

  await user.keyboard('{ArrowDown}');
  expect(combobox).toHaveAttribute(
    'aria-activedescendant',
    screen.getByRole('option', { name: 'Toggle Sidebar' }).id
  );

  await user.type(combobox, 'verify');

  const option = screen.getByRole('option', { name: /Run Tests/ });
  expect(screen.getAllByRole('option')).toHaveLength(1);
  expect(combobox).toHaveAttribute('aria-activedescendant', option.id);
  expect(option).toHaveAttribute('aria-selected', 'true');
});

test('announces an empty result and clears the active descendant', async () => {
  const user = userEvent.setup();
  renderPalette();
  const combobox = screen.getByRole('combobox', { name: 'Command palette' });

  await user.type(combobox, 'does not exist');

  expect(screen.getByRole('status')).toHaveTextContent('No commands found');
  expect(screen.queryByRole('option')).not.toBeInTheDocument();
  expect(combobox).not.toHaveAttribute('aria-activedescendant');
});

test('keeps Tab and Shift+Tab focus on the combobox inside the modal', async () => {
  const user = userEvent.setup();
  renderPalette();
  const combobox = screen.getByRole('combobox', { name: 'Command palette' });

  await waitFor(() => expect(combobox).toHaveFocus());
  await user.tab();
  expect(combobox).toHaveFocus();
  await user.tab({ shift: true });
  expect(combobox).toHaveFocus();
});

test('wraps Arrow navigation and supports Home and End without moving DOM focus', async () => {
  const user = userEvent.setup();
  renderPalette();
  const combobox = screen.getByRole('combobox', { name: 'Command palette' });
  const options = screen.getAllByRole('option');

  await user.keyboard('{ArrowUp}');
  expect(combobox).toHaveAttribute('aria-activedescendant', options[2].id);
  await user.keyboard('{ArrowDown}');
  expect(combobox).toHaveAttribute('aria-activedescendant', options[0].id);
  await user.keyboard('{End}');
  expect(combobox).toHaveAttribute('aria-activedescendant', options[2].id);
  await user.keyboard('{Home}');
  expect(combobox).toHaveAttribute('aria-activedescendant', options[0].id);
  expect(combobox).toHaveFocus();
});

test('scrolls the newly active option into view', async () => {
  const user = userEvent.setup();
  renderPalette();
  const destination = screen.getByRole('option', { name: 'Toggle Sidebar' });
  const scrollIntoView = HTMLElement.prototype.scrollIntoView as jest.Mock;
  scrollIntoView.mockClear();

  await user.keyboard('{ArrowDown}');

  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  expect(scrollIntoView.mock.instances[0]).toBe(destination);
});

test('executes the active command once with Enter and closes once', async () => {
  const user = userEvent.setup();
  const { onClose } = renderPalette();
  const dialog = screen.getByRole('dialog');

  await user.keyboard('{ArrowDown}{Enter}');

  expect(actions.sidebar).toHaveBeenCalledTimes(1);
  expect(actions.open).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(dialog).not.toHaveAttribute('open');
});

test('executes a pointer-selected command once and closes once', async () => {
  const user = userEvent.setup();
  const { onClose } = renderPalette();
  const dialog = screen.getByRole('dialog');

  await user.click(screen.getByRole('option', { name: /Run Tests/ }));

  expect(actions.test).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(dialog).not.toHaveAttribute('open');
});

test('does not execute or close when a command becomes disabled before activation', async () => {
  const user = userEvent.setup();
  let enabled = true;
  const run = jest.fn();
  const onClose = jest.fn();
  renderPalette({
    commands: [{ id: 'conditional', title: 'Conditional', enabled: () => enabled, run }],
    onClose,
  });
  enabled = false;

  await user.keyboard('{Enter}');

  expect(run).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toHaveAttribute('open');
});

test('re-evaluates command availability when reopened with a stable registry and query', () => {
  let enabled = false;
  const conditionalCommands: readonly Command[] = [
    { id: 'conditional', title: 'Conditional', enabled: () => enabled, run: jest.fn() },
  ];
  const onClose = jest.fn();
  const { rerender } = render(
    <CommandPalette open={false} commands={conditionalCommands} onClose={onClose} />
  );

  expect(screen.queryByRole('option', { name: 'Conditional' })).not.toBeInTheDocument();
  enabled = true;
  rerender(<CommandPalette open commands={conditionalCommands} onClose={onClose} />);

  expect(screen.getByRole('option', { name: 'Conditional' })).toBeInTheDocument();
});

test('Escape closes once without executing a command', async () => {
  const user = userEvent.setup();
  const { onClose } = renderPalette();
  const dialog = screen.getByRole('dialog');

  await user.keyboard('{Escape}');

  expect(actions.open).not.toHaveBeenCalled();
  expect(actions.sidebar).not.toHaveBeenCalled();
  expect(actions.test).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(dialog).not.toHaveAttribute('open');
});

test('a native cancel close request closes once and keeps state in sync', () => {
  const { onClose } = renderPalette();
  const dialog = screen.getByRole('dialog');

  const prevented = !fireEvent(dialog, new Event('cancel', { cancelable: true }));

  expect(prevented).toBe(true);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(dialog).not.toHaveAttribute('open');
});

test('closes on a backdrop click but stays open for clicks inside the palette', () => {
  const { onClose } = renderPalette();
  const dialog = screen.getByRole('dialog');

  fireEvent.click(screen.getByRole('combobox', { name: 'Command palette' }));
  expect(onClose).not.toHaveBeenCalled();
  expect(dialog).toHaveAttribute('open');

  fireEvent.click(dialog);

  expect(actions.open).not.toHaveBeenCalled();
  expect(actions.sidebar).not.toHaveBeenCalled();
  expect(actions.test).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(dialog).not.toHaveAttribute('open');
});

test('stops every dialog keydown before window and prevents default only for handled keys', () => {
  const onWindowKeyDown = jest.fn();
  window.addEventListener('keydown', onWindowKeyDown);
  renderPalette();
  const combobox = screen.getByRole('combobox', { name: 'Command palette' });

  expect(fireEvent.keyDown(combobox, { key: 'x', cancelable: true })).toBe(true);
  expect(fireEvent.keyDown(combobox, { key: 'ArrowDown', cancelable: true })).toBe(false);
  expect(onWindowKeyDown).not.toHaveBeenCalled();

  window.removeEventListener('keydown', onWindowKeyDown);
});

test('restores connected prior focus after closing', async () => {
  const user = userEvent.setup();
  const onClose = jest.fn();
  const { rerender } = render(
    <>
      <button type="button">Open palette</button>
      <CommandPalette open={false} commands={commands} onClose={onClose} />
    </>
  );
  const opener = screen.getByRole('button', { name: 'Open palette' });
  opener.focus();

  rerender(
    <>
      <button type="button">Open palette</button>
      <CommandPalette open commands={commands} onClose={onClose} />
    </>
  );
  await waitFor(() =>
    expect(screen.getByRole('combobox', { name: 'Command palette' })).toHaveFocus()
  );
  rerender(
    <>
      <button type="button">Open palette</button>
      <CommandPalette open={false} commands={commands} onClose={onClose} />
    </>
  );

  await waitFor(() => expect(opener).toHaveFocus());
  await user.keyboard('x');
  expect(actions.open).not.toHaveBeenCalled();
});

test('falls back to main content when prior focus disconnects', async () => {
  const opener = document.createElement('button');
  const main = document.createElement('main');
  opener.textContent = 'Detached opener';
  main.id = 'main-content';
  main.tabIndex = -1;
  document.body.append(opener, main);
  opener.focus();

  const { rerender } = renderPalette();
  await waitFor(() =>
    expect(screen.getByRole('combobox', { name: 'Command palette' })).toHaveFocus()
  );
  opener.remove();
  rerender(<CommandPalette open={false} commands={commands} onClose={jest.fn()} />);

  await waitFor(() => expect(main).toHaveFocus());
  main.remove();
});
