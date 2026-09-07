type EventSource<T> = {
  On(name: string, cb: (ev: { data: T }) => void): () => void;
};

// Every Firn event carries 0 or 1 payload (guarded since Task 0), so the v3
// WailsEvent bridge is one field read and returns Wails' cleanup unchanged.
export function registerEvent<T>(
  events: EventSource<T>,
  name: string,
  cb: (data: T) => void
): () => void {
  return events.On(name, (ev) => cb(ev.data));
}
