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
  /** last time we told this one to get on the room's song, so a client that can't play it doesn't get spammed */
  resyncedAt: number;
}

export interface RoomHostIO {
  send(memberId: string, event: string, ...args: any[]): void;
}

/** where the owner's player actually is. null if it can't say */
export type Reference = () => {
  trackUri: string;
  position: number;
  playing: boolean;
  /** what the owner's spotify plays next, friends queue it so their song changes line up (crossfade) */
  nextUri?: string;
} | null;

// same numbers the node server uses
const MAX_DELAY = 5000;
const SYNC_INTERVAL = 3000;
// rooms with a reference send timestamped positions, cheap enough to do every second for tighter sync
const REFERENCE_SYNC_INTERVAL = 1000;
// a client that can't play the room's song (region locked etc) would get told to every time it reports
const RESYNC_COOLDOWN = 5000;
// play/pause/seek in rooms get scheduled this far past the slowest friend's one way delay, so everyone does
// it at the same moment instead of the host first and friends a network trip later. capped so a laggy
// friend can't make the play button feel dead
const SCHEDULE_MARGIN = 60;
const MAX_SCHEDULE = 500;
// how often the owner's actual player gets checked for stuff we didn't see coming (media keys, phone, etc)
const WATCH_INTERVAL = 250;
// a jump this big between two checks = the owner seeked somehow
const EXTERNAL_SEEK = 1500;

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
  private loadAtTime = 0;
  private resumeLive = false;
  private recheckTimer: ReturnType<typeof setTimeout> | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  /** a scheduled action is still landing, the watcher and syncs keep out till then */
  private pendingUntil = 0;
  private queue: ContextTrack[] = [];
  private syncTimer: ReturnType<typeof setInterval>;

  /**
   * ownerId = whoever made the room, they're always host.
   * reference = the owner's real playback. when there is one everyone syncs to the actual music
   * instead of a clock, and the owner never gets corrected
   */
  constructor(
    private io: RoomHostIO,
    private ownerId: string,
    private version: string,
    private reference?: Reference,
  ) {
    this.syncTimer = setInterval(
      () => this.syncListeners(),
      reference ? REFERENCE_SYNC_INTERVAL : SYNC_INTERVAL,
    );
    if (reference) this.watchTimer = setInterval(() => this.watchOwner(), WATCH_INTERVAL);
  }

  close() {
    clearInterval(this.syncTimer);
    if (this.loadingTrack) clearTimeout(this.loadingTrack);
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    if (this.watchTimer) clearInterval(this.watchTimer);
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
      resyncedAt: 0,
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
        else if (this.reference)
          this.updateSongAt(
            !!args[0],
            Number(args[1]) || 0,
            Date.now() + Math.min(MAX_SCHEDULE, this.maxLatency() + SCHEDULE_MARGIN),
          );
        else this.updateSong(!!args[0], Number(args[1]) || 0);
        return;

      case 'loadingSong': {
        const uri = String(args[0] || '');
        if (m.isHost && uri !== this.trackUri) {
          if (this.locked)
            this.io.send(id, 'bottomMessage', 'Listen together is currently locked!');
          else if (this.reference) {
            this.changeSongLive(uri);
          } else {
            this.changeSong(uri);
            // 2nd arg = start mid song, for when the host hits play on a song they already had open
            this.loadAtMilliseconds = Math.max(0, Number(args[1]) || 0);
          }
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
      : this.milliseconds + Math.max(0, Date.now() - this.millisecondsLastUpdate);
  }

  private maxLatency() {
    return Math.max(0, ...this.listeners().map((l) => l.latency));
  }

  /** where the owner will be when a message sent right now lands, null if there's no usable reference */
  private referenceAtArrival() {
    const ref = this.reference?.();
    if (!ref || !ref.playing || ref.trackUri !== this.trackUri) return null;
    return ref.position + this.maxLatency();
  }

  /** delays each send so it lands for everyone at the same moment, the slowest connection sets the pace */
  private emitToListeners(event: string, ...args: any[]) {
    const listeners = this.listeners();
    const maxLatency = this.maxLatency();
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
    with a reference that's the owner's actual music, otherwise the clock. the client does the drift math
  */
  private syncListeners() {
    if (this.locked || this.paused || this.loadingTrack !== null || !isListenable(this.trackUri))
      return;

    // with a reference: the owner's position + when it was read (owner's clock). friends match clocks with
    // the owner, so network delay and jitter just don't matter. sent straight out, no delaying
    if (this.reference) {
      const at = Date.now();
      if (at < this.pendingUntil) return;
      const ref = this.reference();
      // no clock fallback here. if the owner isn't playing the room's song right now there's nothing true to send
      if (!ref || !ref.playing || ref.trackUri !== this.trackUri) return;
      this.listeners().forEach((l) =>
        this.io.send(l.id, 'syncPosition', this.trackUri, ref.position, at, ref.nextUri || ''),
      );
      return;
    }
    this.emitToListeners('syncPosition', this.trackUri, this.getTrackProgress());
  }

  /*
    "at host time `at` the song is at `milliseconds`, paused or playing from then on". at in the future =
    everyone does it at that moment. at in the past = it already happened on the owner's side, catch up.
    sent straight to everyone, the timestamp does the timing
  */
  private updateSongAt(pause: boolean, milliseconds: number, at: number) {
    if (this.loadingTrack !== null || !isListenable(this.trackUri)) return;
    this.paused = pause;
    this.milliseconds = milliseconds;
    this.millisecondsLastUpdate = at;
    this.loadAtMilliseconds = 0;
    this.pendingUntil = Math.max(at, Date.now()) + 800;
    this.listeners().forEach((l) => this.io.send(l.id, 'updateSong', pause, milliseconds, at));
  }

  /*
    the owner's player is the truth, so anything they do gets noticed here even if it never went through our
    buttons: media keys, the mini player, their phone as a remote, the sleep timer
  */
  private watchOwner() {
    if (this.locked || this.loadingTrack !== null || !isListenable(this.trackUri)) return;
    const now = Date.now();
    if (now < this.pendingUntil) return;
    const ref = this.reference?.();
    if (!ref || ref.trackUri !== this.trackUri) return;

    if (ref.playing === this.paused) {
      this.updateSongAt(!ref.playing, ref.position, now);
      return;
    }
    if (ref.playing && Math.abs(ref.position - this.getTrackProgress()) > EXTERNAL_SEEK) {
      this.updateSongAt(false, ref.position, now);
      return;
    }
    // nothing happened, re-anchor so slow drift (buffering hiccups) never adds up to a fake "seek"
    if (ref.playing) {
      this.milliseconds = ref.position;
      this.millisecondsLastUpdate = now;
    }
  }

  private updateSong(pause: boolean, milliseconds: number) {
    if (this.loadingTrack !== null || !isListenable(this.trackUri)) return;
    this.paused = pause;
    this.milliseconds = milliseconds;
    this.millisecondsLastUpdate = Date.now();
    this.loadAtMilliseconds = 0;
    this.emitToListeners('updateSong', this.paused, milliseconds);
  }

  /*
    rooms with a reference don't do the pause, rewind to 0, wait for everyone, play together dance on every
    song change. that stuttered every song and killed crossfade. the owner just keeps playing and everyone
    else gets on the song and lines up live off the syncs. only = just these people (late joiners)
  */
  private changeSongLive(trackUri: string, only?: Member[]) {
    if (!isListenable(trackUri)) return;
    if (this.loadingTrack !== null) clearTimeout(this.loadingTrack);
    this.loadingTrack = null;
    this.trackUri = trackUri;
    const ref = this.reference?.();
    this.paused = !(ref?.playing ?? true);
    this.milliseconds = ref && ref.trackUri === trackUri ? ref.position : 0;
    this.millisecondsLastUpdate = Date.now();
    const now = Date.now();
    (only ?? this.listeners()).forEach((l) => {
      // only targeted resyncs count, a normal song change for everyone isn't someone being off
      if (only) l.resyncedAt = now;
      this.io.send(l.id, 'changeSong', trackUri);
    });
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
    if (this.reference) {
      const next = this.reference()?.nextUri;
      const now = Date.now();
      const off = this.listeners().filter(
        (l) =>
          l.trackUri !== this.trackUri &&
          // already on the owner's next song = their spotify just changed a bit early, the owner's is about to
          !(next && l.trackUri === next),
      );
      const due = off.filter((l) => now - l.resyncedAt >= RESYNC_COOLDOWN);
      if (due.length) this.changeSongLive(this.trackUri, due);
      // the rest got told very recently. look again when that runs out, or they'd sit on the wrong song
      // till they happen to report again
      const waiting = off.filter((l) => now - l.resyncedAt < RESYNC_COOLDOWN);
      if (waiting.length && !this.recheckTimer) {
        const wait = Math.min(...waiting.map((l) => RESYNC_COOLDOWN - (now - l.resyncedAt)));
        this.recheckTimer = setTimeout(() => {
          this.recheckTimer = null;
          if (!this.locked) this.checkDesynchronizedListeners();
        }, wait + 50);
      }
      return;
    }
    if (this.listeners().some((l) => l.trackUri !== this.trackUri)) {
      this.loadAtMilliseconds = this.referenceAtArrival() ?? this.getTrackProgress();
      this.loadAtTime = Date.now();
      // everyone already in keeps playing while the new person loads
      this.resumeLive = !this.paused;
      this.changeSong(this.trackUri);
    }
  }

  private trackLoaded() {
    if (this.loadingTrack) clearTimeout(this.loadingTrack);
    this.loadingTrack = null;
    const milliseconds = this.loadAtMilliseconds;
    const live = this.resumeLive;
    const since = this.loadAtTime;
    this.loadAtMilliseconds = 0;
    this.resumeLive = false;
    // a second for everyone's player to settle before the shared play
    setTimeout(() => {
      // someone joined mid song. the old way sent the position from before they loaded, so the whole
      // room jumped back a few seconds every time somebody joined
      const at = live
        ? this.referenceAtArrival() ?? milliseconds + (Date.now() - since)
        : milliseconds;
      this.updateSong(false, at);
    }, 1000);
  }

  private lock(lock: boolean) {
    if (this.locked === lock) return;
    this.locked = lock;
    if (!lock) {
      const host = this.listeners().find((l) => l.isHost);
      if (this.reference) this.changeSongLive(host?.trackUri || this.trackUri);
      else this.changeSong(host?.trackUri || this.trackUri);
    }
    this.sendListeners();
  }

  private onNoListeners() {
    this.trackUri = '';
    this.paused = true;
    this.milliseconds = 0;
  }
}
