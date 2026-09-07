import { render, screen, fireEvent } from '@testing-library/react';
import { RunProfileCard } from '../../components/RunProfiles/RunProfileCard';
import { useIDEStore } from '../../stores/ideStore';
import type { RunProfile } from '../../types/runProfile';

jest.mock('../../wails/bindings', () => ({
  StartRunProfile: jest.fn(() => Promise.resolve()),
  StopRunProfile: jest.fn(() => Promise.resolve()),
  RestartRunProfile: jest.fn(() => Promise.resolve()),
  PinRunProfile: jest.fn(() => Promise.resolve()),
  UnpinRunProfile: jest.fn(() => Promise.resolve()),
  SetActiveVariant: jest.fn(() => Promise.resolve()),
  AdoptRunProfile: jest.fn(() => Promise.resolve()),
  UnadoptRunProfile: jest.fn(() => Promise.resolve()),
}));

const profile: RunProfile = { id: 'p1', name: 'dev', type: 'single', source: 'user' };
const common = {
  profile,
  visualState: 'idle' as const,
  runOutput: undefined,
  runHistory: [],
  isDormant: false,
  isDuplicate: false,
  onFocusOutput: jest.fn(),
};

beforeEach(() => useIDEStore.setState({ selectedProfileId: null }));

test('renders the target toggle; pressed state reflects isSelectedTarget', () => {
  const { rerender } = render(<RunProfileCard {...common} isSelectedTarget={false} />);
  const toggle = screen.getByRole('button', { name: /set as run target|run target/i });
  expect(toggle).toHaveAttribute('aria-pressed', 'false');
  rerender(<RunProfileCard {...common} isSelectedTarget={true} />);
  expect(screen.getByRole('button', { name: /run target/i })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
});

test('clicking the toggle selects the profile and does not expand the card', () => {
  render(<RunProfileCard {...common} isSelectedTarget={false} />);
  fireEvent.click(screen.getByRole('button', { name: /run target/i }));
  expect(useIDEStore.getState().selectedProfileId).toBe('p1');
});

test('dormant cards can be selected from the keyboard', () => {
  render(<RunProfileCard {...common} isDormant={true} isSelectedTarget={false} />);
  fireEvent.keyDown(screen.getByRole('button', { name: /^dev$/ }), { key: 'Enter' });
  expect(useIDEStore.getState().selectedProfileId).toBe('p1');
});
