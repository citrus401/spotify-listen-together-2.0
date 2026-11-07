import React from 'react';

export type Listener = {
  name: string;
  isHost: boolean;
  watchingAD: boolean;
  /** rooms only, the node server doesn't send these */
  id?: string;
  avatar?: string;
  owner?: boolean;
  /** ms off from the owner (+ = ahead), measured on their end. missing = not measuring, or an older version */
  sync?: number;
};

/** tiny "something changed, re-render" signal so the chip and the panel stay live without a state lib */
export class Store {
  private subs = new Set<() => void>();
  listeners: Listener[] = [];

  subscribe(fn: () => void) {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }

  changed() {
    this.subs.forEach((fn) => fn());
  }
}

export function useStore(store: Store) {
  const [, bump] = React.useState(0);
  React.useEffect(() => store.subscribe(() => bump((v) => v + 1)), [store]);
}
