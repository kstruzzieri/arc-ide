import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SourcePicker } from '../../../components/GolemConfig/SourcePicker';
import {
  APPLIED_SOURCE_VALUE,
  buildProfileSelectModel,
} from '../../../components/GolemConfig/profileSelect';
import type { ProfileInfo } from '../../../types/golemConfig';

const rows: ProfileInfo[] = [
  { id: 'curated/local', curated: true, description: 'Vetted local lineup' },
  { id: 'user/abacus', curated: false },
  { id: 'user/local', curated: false },
];
const list = { kind: 'loaded' as const, profiles: rows };
const model = (over: Partial<Parameters<typeof buildProfileSelectModel>[0]> = {}) =>
  buildProfileSelectModel({
    source: { kind: 'profile', profileId: 'user/local', sourceRevision: 'r' },
    list,
    provenance: null,
    appliedRevision: 'a',
    state: 'ready',
    ...over,
  });
const props = () => ({
  model: model(),
  disabled: false,
  describedBy: undefined,
  startRefusal: '',
  listNotice: '',
  onOpen: jest.fn(),
  onSelect: jest.fn(),
  onStartBlank: jest.fn(),
  onStartFromProfile: jest.fn(),
});

// [C3] The trigger is queried by ROLE: while the list is open, both the button (label
// htmlFor) and the listbox (aria-labelledby) answer to the name "Source".
const trigger = () => screen.getByRole('button', { name: 'Source' });

describe('SourcePicker', () => {
  it('is a labelled trigger that names the group of the selected profile', () => {
    render(<SourcePicker {...props()} />);
    expect(screen.getByLabelText('Source')).toBe(trigger());
    expect(trigger()).toHaveAttribute('aria-haspopup', 'listbox');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).toHaveAttribute('id', 'golem-profile-select');
    expect(trigger()).toHaveTextContent('Yours');
    expect(trigger()).toHaveTextContent('local');
    expect(trigger()).toHaveAttribute('data-value', 'user/local');
    // [C11] The label names the button "Source"; the current value reaches AT as its description.
    expect(trigger()).toHaveAccessibleDescription(/Current source: Yours · local/);
  });

  it('opens a grouped listbox where the two `local` entries stay apart by heading', async () => {
    const p = props();
    const user = userEvent.setup();
    render(<SourcePicker {...p} />);
    await user.click(trigger());
    expect(p.onOpen).toHaveBeenCalledTimes(1);
    const list = screen.getByRole('listbox', { name: 'Source' });
    expect(
      within(within(list).getByRole('group', { name: 'Curated' })).getByRole('option', {
        name: 'local',
      })
    ).toBeInTheDocument();
    const yours = within(list).getByRole('group', { name: 'Yours' });
    expect(within(yours).getByRole('option', { name: 'local' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    const start = within(list).getByRole('group', { name: 'Start from' });
    expect(within(start).getByRole('option', { name: /Blank draft/ })).toBeInTheDocument();
    expect(within(start).getByRole('option', { name: /Curated local/ })).toBeInTheDocument();
    expect(within(list).getByRole('option', { name: /^Applied/ })).toHaveTextContent('on disk');
  });

  it('selects with the keyboard and restores focus to the trigger', async () => {
    const p = props();
    const user = userEvent.setup();
    render(<SourcePicker {...p} />);
    trigger().focus();
    await user.keyboard('{ArrowDown}');
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('listbox', { name: 'Source' })).toHaveFocus();
    await user.keyboard('{Home}{Enter}');
    expect(p.onSelect).toHaveBeenCalledWith(APPLIED_SOURCE_VALUE);
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('Tab closes the list and hands focus to the trigger without cancelling the key (the browser then departs from the trigger)', async () => {
    // jsdom/user-event cannot model native Tab departure; Task 9's live keyboard pass covers it.
    // What must hold: focus is on the trigger, the list is closed, and keydown was NOT
    // default-prevented — so the browser's own Tab / Shift+Tab moves from the trigger.
    const p = props();
    const user = userEvent.setup();
    render(
      <>
        <button type="button">before</button>
        <SourcePicker {...p} />
        <button type="button">after</button>
      </>
    );
    await user.click(trigger());
    const list = screen.getByRole('listbox', { name: 'Source' });
    expect(list).toHaveFocus();
    const notPrevented = fireEvent.keyDown(list, { key: 'Tab' });
    expect(notPrevented).toBe(true); // fireEvent returns false when preventDefault was called
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger());
    const reopened = screen.getByRole('listbox', { name: 'Source' });
    expect(reopened).toHaveFocus();
    const shifted = fireEvent.keyDown(reopened, { key: 'Tab', shiftKey: true });
    expect(shifted).toBe(true);
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(p.onSelect).not.toHaveBeenCalled();
  });

  it('keeps the active entry by identity when the list is refreshed underneath it', async () => {
    const p = props();
    const user = userEvent.setup();
    const { rerender } = render(<SourcePicker {...p} />);
    trigger().focus();
    await user.keyboard('{ArrowDown}{End}');
    // [C8] onOpen kicks off an async list refresh; a shorter list arrives while the user is on the last entry.
    rerender(
      <SourcePicker
        {...p}
        model={model({ list: { kind: 'loaded', profiles: rows.slice(0, 1) } })}
      />
    );
    await user.keyboard('{Enter}');
    // The active entry was `Curated local` (last); it still exists, so Enter chooses it — never an index past the end.
    expect(p.onStartFromProfile).toHaveBeenCalledWith('curated/local');
  });

  it('routes START FROM entries to their commands', async () => {
    const p = props();
    const user = userEvent.setup();
    render(<SourcePicker {...p} />);
    await user.click(trigger());
    await user.click(screen.getByRole('option', { name: /Blank draft/ }));
    expect(p.onStartBlank).toHaveBeenCalledTimes(1);
    await user.click(trigger());
    await user.click(screen.getByRole('option', { name: /Curated local/ }));
    expect(p.onStartFromProfile).toHaveBeenCalledWith('curated/local');
    expect(p.onSelect).not.toHaveBeenCalled();
  });

  it('Escape closes without selecting; an outside pointer closes without stealing focus', async () => {
    const p = props();
    const user = userEvent.setup();
    render(
      <>
        <SourcePicker {...p} />
        <button type="button">elsewhere</button>
      </>
    );
    await user.click(trigger());
    await user.keyboard('{Escape}');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).toHaveFocus();
    await user.click(trigger());
    await user.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'elsewhere' })).toHaveFocus();
    expect(p.onSelect).not.toHaveBeenCalled();
  });

  it('while Missing lists only the disabled current entry and START FROM', async () => {
    const p = {
      ...props(),
      model: model({ source: { kind: 'applied' }, appliedRevision: undefined, state: 'missing' }),
    };
    const user = userEvent.setup();
    render(<SourcePicker {...p} />);
    expect(trigger()).toHaveTextContent('No applied configuration');
    await user.click(trigger());
    const list = screen.getByRole('listbox', { name: 'Source' });
    expect(within(list).getByRole('option', { name: 'No applied configuration' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    expect(within(list).queryByRole('group', { name: 'Curated' })).toBeNull();
    expect(within(list).queryByRole('group', { name: 'Yours' })).toBeNull();
    expect(within(list).getByRole('group', { name: 'Start from' })).toBeInTheDocument();
  });

  it('disables START FROM entries with the refusal while Invalid/Limited', async () => {
    const p = {
      ...props(),
      startRefusal: 'Unavailable while the configuration is Invalid or Limited.',
    };
    const user = userEvent.setup();
    render(<SourcePicker {...p} />);
    await user.click(trigger());
    const blank = screen.getByRole('option', { name: /Blank draft/ });
    expect(blank).toHaveAttribute('aria-disabled', 'true');
    await user.click(blank);
    expect(p.onStartBlank).not.toHaveBeenCalled();
    expect(
      screen.getByText('Unavailable while the configuration is Invalid or Limited.')
    ).toBeInTheDocument();
  });

  it('marks a PROVEN-absent retained profile unavailable and keeps it unchoosable', async () => {
    // [C9] The shipped model appends ` (unavailable)` only when a fully loaded list lacks the id;
    // a Missing/limited/unloaded retention keeps the bare slug — and so does the picker.
    const p = {
      ...props(),
      model: model({ source: { kind: 'profile', profileId: 'user/mine', sourceRevision: 'r' } }),
    };
    const user = userEvent.setup();
    render(<SourcePicker {...p} />);
    expect(trigger()).toHaveTextContent('unavailable');
    await user.click(trigger());
    const retained = screen.getByRole('option', { name: /mine/ });
    expect(retained).toHaveAttribute('aria-disabled', 'true');
    expect(retained).toHaveAttribute('aria-selected', 'true');
    expect(retained).toHaveTextContent('unavailable');
  });

  it('a retained profile from a limited list is not called unavailable', async () => {
    const p = {
      ...props(),
      model: model({
        source: { kind: 'profile', profileId: 'user/zzz', sourceRevision: 'r' },
        list: { kind: 'limited', profiles: rows },
      }),
    };
    render(<SourcePicker {...p} />);
    expect(trigger()).not.toHaveTextContent('unavailable');
  });

  it('a refresh that drops the active entry leaves nothing active and Enter chooses nothing', async () => {
    // [A4] The user is on `user/abacus`; the refreshed list no longer carries it.
    const p = props();
    const user = userEvent.setup();
    const { rerender } = render(<SourcePicker {...p} />);
    trigger().focus();
    await user.keyboard('{ArrowDown}');
    await user.click(screen.getByRole('option', { name: 'abacus' }).closest('[role="listbox"]')!); // keep the list open
    await user.keyboard('{Home}{ArrowDown}{ArrowDown}'); // Applied → curated local → abacus
    expect(screen.getByRole('listbox', { name: 'Source' })).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: 'abacus' }).id
    );
    rerender(
      <SourcePicker
        {...p}
        model={model({
          list: { kind: 'loaded', profiles: rows.filter((r) => r.id !== 'user/abacus') },
        })}
      />
    );
    expect(screen.getByRole('listbox', { name: 'Source' })).not.toHaveAttribute(
      'aria-activedescendant'
    );
    await user.keyboard('{Enter}');
    expect(p.onSelect).not.toHaveBeenCalled();
    expect(p.onStartFromProfile).not.toHaveBeenCalled();
  });

  it('type-ahead moves to the first entry starting with the typed letters', async () => {
    const p = props();
    const user = userEvent.setup();
    render(<SourcePicker {...p} />);
    trigger().focus();
    await user.keyboard('{ArrowDown}ab');
    expect(screen.getByRole('listbox', { name: 'Source' })).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: 'abacus' }).id
    );
    await user.keyboard('{Enter}');
    expect(p.onSelect).toHaveBeenCalledWith('user/abacus');
  });

  it('reveals the active option and bounds the list height', async () => {
    const scroll = jest.fn();
    Element.prototype.scrollIntoView = scroll;
    const p = props();
    const user = userEvent.setup();
    render(<SourcePicker {...p} />);
    trigger().focus();
    await user.keyboard('{ArrowDown}{End}');
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('renders the list notice below the entries', async () => {
    const p = { ...props(), listNotice: 'Loading profiles…' };
    const user = userEvent.setup();
    render(<SourcePicker {...p} />);
    await user.click(trigger());
    expect(
      within(screen.getByRole('listbox', { name: 'Source' })).getByText('Loading profiles…')
    ).toBeInTheDocument();
  });

  it('wraps a 256-byte identifier instead of widening the trigger', () => {
    // [A3] Legal identifiers can be 256 bytes; the trigger ellipsizes, the option wraps.
    const long = 'a'.repeat(256);
    const p = {
      ...props(),
      model: model({
        source: { kind: 'profile', profileId: `user/${long}`, sourceRevision: 'r' },
        list: { kind: 'loaded', profiles: [...rows, { id: `user/${long}`, curated: false }] },
      }),
    };
    render(<SourcePicker {...p} />);
    expect(trigger()).toHaveTextContent(long);
  });
});
