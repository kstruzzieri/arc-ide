import { fireEvent, render, screen, within } from '@testing-library/react';
import { PanelBarButton, PanelCommandBar } from '../../components/layout/PanelCommandBar';
import { useIDEStore } from '../../stores/ideStore';
import * as platform from '../../utils/platform';

beforeEach(() => useIDEStore.setState(useIDEStore.getInitialState()));
afterEach(() => jest.restoreAllMocks());

it('exposes a movable header region, the name, and a collapse control outside the region', () => {
  const onCollapse = jest.fn();
  const onGear = jest.fn();
  render(
    <PanelCommandBar
      panel="golem"
      name="GOLEM"
      tile={<span>⬡</span>}
      meta={<span>live</span>}
      controls={
        <PanelBarButton label="Configuration" onClick={onGear}>
          <span>gear</span>
        </PanelBarButton>
      }
      onCollapse={onCollapse}
    />
  );

  const identity = screen.getByRole('group', { name: 'Golem panel header' });
  expect(identity).toHaveAttribute('aria-roledescription', 'movable panel header');
  expect(identity).toHaveAttribute('tabindex', '0');
  expect(within(identity).getByText('GOLEM')).toBeInTheDocument();
  expect(within(identity).getByText('live')).toBeInTheDocument();

  const collapse = screen.getByRole('button', { name: 'Collapse Golem panel' });
  expect(identity.contains(collapse)).toBe(false);
  fireEvent.click(collapse);
  expect(onCollapse).toHaveBeenCalledTimes(1);

  const gear = screen.getByRole('button', { name: 'Configuration' });
  expect(identity.contains(gear)).toBe(false);
  fireEvent.click(gear);
  expect(onGear).toHaveBeenCalledTimes(1);
});

it('keys the bar by panel for CSS', () => {
  const { container } = render(
    <PanelCommandBar panel="files" name="FILES" tile={<span />} onCollapse={jest.fn()} />
  );
  expect(container.firstElementChild).toHaveAttribute('data-panel', 'files');
});

it('starts a directed drag from the identity region and clears it on dragend', () => {
  render(<PanelCommandBar panel="golem" name="GOLEM" tile={<span />} onCollapse={jest.fn()} />);
  const identity = screen.getByRole('group', { name: 'Golem panel header' });
  expect(identity).toHaveAttribute('draggable', 'true');
  const setData = jest.fn();
  fireEvent.dragStart(identity, { dataTransfer: { setData, effectAllowed: '' } });
  expect(useIDEStore.getState().centerDrag).toBe('golem');
  expect(setData).toHaveBeenCalledWith('application/x-firn-center-panel', 'golem');
  expect(identity).toHaveAttribute('data-dragging', 'true');
  fireEvent.dragEnd(identity);
  expect(useIDEStore.getState().centerDrag).toBeNull();
  expect(identity).not.toHaveAttribute('data-dragging');
});

it('swaps on the platform chord only when the identity itself is the target', () => {
  jest.spyOn(platform, 'isMac').mockReturnValue(true);
  render(<PanelCommandBar panel="golem" name="GOLEM" tile={<span />} onCollapse={jest.fn()} />);
  const identity = screen.getByRole('group', { name: 'Golem panel header' });
  fireEvent.keyDown(identity, { key: 'ArrowLeft', metaKey: true, shiftKey: true });
  expect(useIDEStore.getState().centerOrder).toBe('golem-first');
  // A chord bubbling from a control must not reorder.
  fireEvent.keyDown(screen.getByRole('button', { name: 'Collapse Golem panel' }), {
    key: 'ArrowRight',
    metaKey: true,
    shiftKey: true,
  });
  expect(useIDEStore.getState().centerOrder).toBe('golem-first');
});
