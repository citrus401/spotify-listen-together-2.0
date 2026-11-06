/*
  the room itself, ported from the node server (backend/player.ts + socket.ts) so a spotify can be the
  server. no spicetify or node stuff in here, it only gets messages in and hands messages out
*/

export type ContextTrack = { uri: string; uid?: string | null; metadata?: any };

interface Member {
  id: string;
  name: string;
  isHost: boolean;
  loggedIn: boolean;
  trackUri: string;
  /** one way ms, half the ping */
  latency: number;
}

export interface RoomHostIO {
  send(memberId: string, event: string, ...args: any[]): void;
}

// same numbers the node server uses
const MAX_DELAY = 5000;
const SYNC_INTERVAL = 3000;

function isListenable(uri: string) {
  return uri.startsWith('spotify:track:') || uri.startsWith('spotify:episode:');
}

export function versionsCompatible(a: string, b: string) {
  const [aMajor, aMinor] = a.split('.');
  const [bMajor, bMinor] = b.split('.');
  return aMajor === bMajor && aMinor === bMinor;
}

export default class RoomHost {
  private members = new Map<string, Member>();
  private trackUri = '';
  private paused = true;
  private milliseconds = 0;
  private millisecondsLastUpdate = Date.now();
  private loadingTrack: ReturnType<typeof setTimeout> | null = null;
  private locked = false;
  private loadAtMilliseconds = 0;
  private queue: ContextTrack[] = [];
  private syncTimer: ReturnType<typeof setInterval>;

  /** ownerId = whoever made the room, they're always host */
  constructor(
    private io: RoomHostIO,
    private ownerId: string,
    private version: string,
  ) {
    this.syncTimer = setInterval(() => this.syncListeners(), SYNC_INTERVAL);
  }

  close() {
    clearInterval(this.syncTimer);
    if (this.loadingTrack) clearTimeout(this.loadingTrack);
  }

  addMember(id: string) {
    if (this.members.has(id)) return;
    this.members.set(id, {
      id,
      name: 'Unnamed',
      isHost: false,
      loggedIn: false,
      trackUri: '',
      latency: 0,
    });
  }

  setLatency(id: string, latency: number) {
    const m = this.members.get(id);
    if (m) m.latency = Math.min(latency, MAX_DELAY);
  }

  memberLeft(id: string) {
    if (!this.members.delete(id)) return;
    this.checkListenerHasAD();
    this.sendListeners();
    if (this.listeners().length === 0) this.onNoListeners();
  }

  handle(id: string, event: string, args: any[]) {
    const m = this.members.get(id);
    if (!m) return;

    switch (event) {
      case 'login': {
        const [name, version] = args;
        if (typeof version !== 'string' || !versionsCompatible(version, this.version)) {
          this.io.send(id, 'versionMismatch', this.version);
          return;
        }
        m.name = String(name || 'Unnamed').slice(0, 40);
        m.loggedIn = true;
        if (id === this.ownerId) this.updateHost(m, true);
        this.checkListenerHasAD();
        if (!this.locked) this.checkDesynchronizedListeners();
        this.sendListeners();
        this.io.send(id, 'queueUpdate', this.queue);
        return;
      }

      // no passwords in a p2p room, the owner just gets asked
      case 'requestHost':
        if (!m.isHost) this.io.send(this.ownerId, 'hostRequested', m.name, id);
        return;

      case 'grantHost': {
        const target = this.members.get(args[0]);
        if (id === this.ownerId && target) {
          this.updateHost(target, true);
          this.io.send(target.id, 'bottomMessage', 'Host permissions acquired.');
        }
        return;
      }

      case 'cancelHost':
        if (id !== this.ownerId) this.updateHost(m, false);
        return;

      case 'requestUpdateSong':
        if (!m.isHost) return;
        if (this.locked)
          this.io.send(id, 'bottomMessage', 'Listen together is currently locked!');
        else this.updateSong(!!args[0], Number(args[1]) || 0);
        return;

      case 'loadingSong': {
        const uri = String(args[0] || '');
        if (m.isHost && uri !== this.trackUri) {
          if (this.locked)
            this.io.send(id, 'bottomMessage', 'Listen together is currently locked!');
          else this.changeSong(uri);
        }
        return;
      }

      case 'changedSong': {
        const uri = String(args[0] || '');
        if (uri === '') return;
        m.trackUri = uri;
        this.checkListenerHasAD();
        if (!this.locked) {
          if (this.loadingTrack !== null) this.checkTrackLoaded();
          else this.checkDesynchronizedListeners();
        }
        return;
      }

      case 'requestSong':
        this.listeners()
          .filter((l) => l.isHost)
          .forEach((h) => this.io.send(h.id, 'songRequested', args[0], args[1], m.name));
        return;

      // the node server let anyone touch the queue, only the client checked. hosts only here
      case 'addToQueue':
        if (!m.isHost || !Array.isArray(args[0])) return;
        this.queue.push(...args[0]);
        this.emitToListeners('addToQueue', [...args[0]]);
        return;

      case 'removeFromQueue': {
        if (!m.isHost || !Array.isArray(args[0])) return;
        const removed: ContextTrack[] = [];
        for (const t of args[0] as ContextTrack[]) {
          const i = this.queue.findIndex((q) => q.uri === t.uri);
          if (i !== -1) removed.push(this.queue.splice(i, 1)[0]);
        }
        this.emitToListeners('removeFromQueue', removed);
        return;
      }

      case 'clearQueue':
        if (!m.isHost) return;
        this.queue = [];
        this.emitToListeners('clearQueue');
        return;

      case 'requestListeners':
        this.sendListeners(id);
        return;
    }
  }

  private listeners() {
    return [...this.members.values()].filter((m) => m.loggedIn);
  }

  private getTrackProgress() {
    return this.paused
      ? this.milliseconds
      : this.milliseconds + (Date.now() - this.millisecondsLastUpdate);
  }

  /** delays each send so it lands for everyone at the same moment, the slowest connection sets the pace */
  private emitToListeners(event: string, ...args: any[]) {
    const listeners = this.listeners();
    const maxLatency = Math.max(0, ...listeners.map((l) => l.latency));
    listeners.forEach((l) => {
      const delay = maxLatency - l.latency;
      if (delay <= 0) this.io.send(l.id, event, ...args);
      else setTimeout(() => this.io.send(l.id, event, ...args), delay);
    });
  }

  private sendListeners(to?: string) {
    const list = this.listeners().map((l) => ({
      name: l.name,
      isHost: l.isHost,
      watchingAD: l.trackUri.includes('spotify:ad:'),
    }));
    if (to) this.io.send(to, 'listeners', list);
    else this.members.forEach((m) => this.io.send(m.id, 'listeners', list));
  }

  private updateHost(m: Member, isHost: boolean) {
    m.isHost = isHost;
    this.io.send(m.id, 'isHost', isHost);
    this.sendListeners();
  }

  /*
    arrives for everyone at once like updateSong did, so on arrival an in sync listener is exactly here.
    the client does the drift math
  */
  private syncListeners() {
    if (this.locked || this.paused || this.loadingTrack !== null || !isListenable(this.trackUri))
      return;
    this.emitToListeners('syncPosition', this.trackUri, this.getTrackProgress());
  }

  private updateSong(pause: boolean, milliseconds: number) {
    if (this.loadingTrack !== null || !isListenable(this.trackUri)) return;
    this.paused = pause;
    this.milliseconds = milliseconds;
    this.millisecondsLastUpdate = Date.now();
    this.loadAtMilliseconds = 0;
    this.emitToListeners('updateSong', this.paused, milliseconds);
  }

  private changeSong(trackUri: string) {
    if (!isListenable(trackUri)) return;
    if (this.loadingTrack !== null) clearTimeout(this.loadingTrack);
    this.milliseconds = 0;
    this.trackUri = trackUri;
    this.emitToListeners('changeSong', trackUri);
    // someone who never finishes loading can't hold the room forever
    this.loadingTrack = setTimeout(() => this.trackLoaded(), MAX_DELAY);
  }

  private checkTrackLoaded() {
    if (this.listeners().every((l) => l.trackUri === this.trackUri)) this.trackLoaded();
  }

  // one person on an ad freezes the room till it's over, same as the server
  private checkListenerHasAD() {
    this.lock(this.listeners().some((l) => l.trackUri.startsWith('spotify:ad:')));
  }

  private checkDesynchronizedListeners() {
    if (this.loadingTrack !== null) return;
    if (this.listeners().some((l) => l.trackUri !== this.trackUri)) {
      this.loadAtMilliseconds = this.getTrackProgress();
      this.changeSong(this.trackUri);
    }
  }

  private trackLoaded() {
    if (this.loadingTrack) clearTimeout(this.loadingTrack);
    this.loadingTrack = null;
    const milliseconds = this.loadAtMilliseconds;
    this.loadAtMilliseconds = 0;
    // a second for everyone's player to settle before the shared play
    setTimeout(() => this.updateSong(false, milliseconds), 1000);
  }

  private lock(lock: boolean) {
    if (this.locked === lock) return;
    this.locked = lock;
    if (!lock) {
      const host = this.listeners().find((l) => l.isHost);
      this.changeSong(host?.trackUri || this.trackUri);
    }
    this.sendListeners();
  }

  private onNoListeners() {
    this.trackUri = '';
    this.paused = true;
    this.milliseconds = 0;
  }
}
