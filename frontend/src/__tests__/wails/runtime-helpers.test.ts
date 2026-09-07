import { registerEvent } from '../../wails/runtime-helpers';

describe('registerEvent', () => {
  it('registers the unwrapping callback and returns cleanup unchanged', () => {
    type Payload = { termId: string; data: string };
    const cb = jest.fn<void, [Payload]>();
    const cleanup = jest.fn();
    const on = jest.fn((_name: string, _cb: (ev: { data: Payload }) => void) => cleanup);

    expect(registerEvent({ On: on }, 'terminal:output', cb)).toBe(cleanup);
    const wrapped = on.mock.calls[0][1];
    wrapped({ data: { termId: 't1', data: 'x' } });
    expect(cb).toHaveBeenCalledWith({ termId: 't1', data: 'x' });
    expect(on).toHaveBeenCalledWith('terminal:output', expect.any(Function));
  });
});
