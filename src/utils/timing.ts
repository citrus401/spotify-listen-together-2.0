/*
  exact waits. spotify minimized or behind other windows = chromium pushes setTimeout to ~1 s ticks, so a
  30 ms wait took 940 ms in testing and every realign landed a second late. message channel callbacks
  don't get pushed, so waits that need to land on a moment step through those instead.
  that keeps the event loop busy while it waits, fine for the few hundred ms these are
*/

const channel = new MessageChannel();
const waiting: (() => void)[] = [];
channel.port1.onmessage = () => waiting.shift()?.();

/** gives the event loop one turn, without timer throttling */
export function tick() {
  return new Promise<void>((resolve) => {
    waiting.push(resolve);
    channel.port2.postMessage(0);
  });
}

/** resolves at local time t (Date.now), to the ms */
export async function waitUntil(t: number) {
  while (Date.now() < t) await tick();
}

/** resolves true once ok() is, false after ms */
export async function waitFor(ok: () => boolean, ms: number) {
  const until = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > until) return false;
    await tick();
  }
  return true;
}
