/*
  what the client talks through. socket.io's Socket already fits this shape,
  the peer to peer and loopback ones just copy it
*/
export interface Transport {
  emit(event: string, ...args: any[]): void;
  on(event: string, handler: (...args: any[]) => void): void;
  onAny(handler: (event: string, ...args: any[]) => void): void;
  disconnect(): void;
}

export class EventHub implements Transport {
  private handlers = new Map<string, ((...args: any[]) => void)[]>();
  private anyHandlers: ((event: string, ...args: any[]) => void)[] = [];

  on(event: string, handler: (...args: any[]) => void) {
    const list = this.handlers.get(event) || [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  onAny(handler: (event: string, ...args: any[]) => void) {
    this.anyHandlers.push(handler);
  }

  dispatch(event: string, ...args: any[]) {
    this.anyHandlers.forEach((h) => h(event, ...args));
    (this.handlers.get(event) || []).forEach((h) => h(...args));
  }

  emit(_event: string, ..._args: any[]) {}

  disconnect() {}
}

/** ack callbacks only work over socket.io, everything else would choke trying to send a function */
export function stripFunctions(args: any[]) {
  return args.filter((a) => typeof a !== 'function');
}
