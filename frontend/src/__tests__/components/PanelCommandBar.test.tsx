import { fireEvent, render, screen, within } from '@testing-library/react';
import { PanelBarButton, PanelCommandBar } from '../../components/layout/PanelCommandBar';

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
