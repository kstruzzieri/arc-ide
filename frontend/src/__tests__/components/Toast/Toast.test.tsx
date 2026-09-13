import { act, fireEvent, render, screen } from '@testing-library/react';
import { Toast } from '../../../components/Toast';
import { useIDEStore } from '../../../stores/ideStore';

// Reset store between tests
beforeEach(() => {
  useIDEStore.setState({ toast: null, heldToasts: [] });
});

describe('Toast', () => {
  it('should render nothing when no toast', () => {
    const { container } = render(<Toast />);
    expect(container.firstChild).toBeNull();
  });

  it('should render error toast message', () => {
    useIDEStore.setState({
      toast: { message: 'Failed to save file.ts', type: 'error' },
    });
    render(<Toast />);
    expect(screen.getByText('Failed to save file.ts')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('should render info toast message', () => {
    useIDEStore.setState({
      toast: { message: 'File saved', type: 'info' },
    });
    render(<Toast />);
    expect(screen.getByText('File saved')).toBeInTheDocument();
  });

  it('should have a dismiss button', () => {
    useIDEStore.setState({
      toast: { message: 'Error', type: 'error' },
    });
    render(<Toast />);
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });

  it('auto-dismisses an ordinary toast but keeps a sticky one until dismissed', () => {
    jest.useFakeTimers();
    try {
      useIDEStore.setState({ toast: { message: 'Transient', type: 'error' } });
      const { rerender } = render(<Toast />);
      act(() => {
        jest.advanceTimersByTime(4000);
      });
      expect(useIDEStore.getState().toast).toBeNull();

      // A sticky toast carries a message the user must act on (#290's
      // refused save): no timer, only the Dismiss button clears it.
      act(() => {
        useIDEStore.setState({ toast: { message: 'Act on me', type: 'error', sticky: true } });
      });
      rerender(<Toast />);
      act(() => {
        jest.advanceTimersByTime(60_000);
      });
      expect(useIDEStore.getState().toast?.message).toBe('Act on me');
      fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
      expect(useIDEStore.getState().toast).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
