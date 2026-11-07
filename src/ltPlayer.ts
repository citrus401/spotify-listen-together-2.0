import Client from './client';
import Patcher, { ogPlayerAPI } from './utils/patcher';
import SettingsManager from './utils/settings';
import UI from './ui/ui';
import pJson from '../package.json';
import './utils/spotifyUtils';
import {
  forcePlayTrack,
  getCurrentTrackUri,
  getTrackData,
  getTrackProgress,
  getTrackType,
  isListenableTrackType,
  isTrackPaused,
  pauseTrack,
  resumeTrack,
  SpotifyUtils,
  TrackType,
} from './utils/spotifyUtils';

const AD_CHECK_INTERVAL = 2000;
/*
  every correction is a seek and seeks hiccup (spotify won't do speed changes on music, checked), so the
  trick is clean readings: then the bar can be tight without seeking over noise.
  precise = rooms. timestamped positions + matched clocks, readings are a few ms off at most.
  loose = the node server. timing there is a guess at the network delay, so it needs more slack.
  drift is judged on the median of the last few readings so one bad one can't trigger a seek
*/
const PRECISE = { tolerance: 80, samples: 5, cooldown: 8000 };
const LOOSE = { tolerance: 250, samples: 3, cooldown: 30000 };
// 2 readings this far off in a row is a real jump (buffering, a skip), fixed right away
const BIG_DRIFT = 1000;
// progress is prob off for a bit after a seek or resume, so no judging drift till it settles
const SETTLE_TIME = 2000;
const MAX_SEEK_LEAD = 600;
// near the end a correction could seek past it and skip the song
const END_GUARD = 2000;

export default class LTPlayer {
  client = new Client(this);
  patcher = new Patcher(this);
  spotifyUtils = new SpotifyUtils(this);
  settingsManager = new SettingsManager(Spicetify.LocalStorage);
  ui = new UI(this);
  isHost = false;
  version = pJson.version;
  watchingAd = false;
  trackLoaded = true;
  currentLoadingTrack = '';

  volumeChangeEnabled = false;
  canChangeVolume = true;
  lastVolume: number | null = null;

  /** spotify takes a moment to actually play after a seek, so corrections aim this far ahead. learned, see onSyncPosition */
  private seekLead = 0;
  private correcting = false;
  private driftSamples: number[] = [];
  private lastCorrection = 0;
  /** last song the room told us about, '' till it does */
  private roomTrackUri = '';
  /** song we just got on in a room, the first good sync lines us up right away instead of waiting */
  private alignNext: string | null = null;
  private transitionWait: ReturnType<typeof setTimeout> | null = null;
  private mirroredNext = '';
  private mirroredAt = 0;
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private settleUntil = 0;
  private delayedResume: ReturnType<typeof setTimeout> | null = null;

  // listeners live here and not in init(), init runs on every connect and they used to pile up
  constructor() {
    this.patcher.subscribeToPlayerEvents();
    this.patcher.trackChanged.on((trackUri) => {
      this.onSongChanged(trackUri!);
    });

    setInterval(() => {
      this.resumeTrackIfAdPlaying();
    }, AD_CHECK_INTERVAL);
  }

  init() {
    this.patcher.patchAll();

    // this.volumeChangeEnabled = !!ogPlayerAPI.setVolume;

    // For testing
    (<any>Spicetify).OGFunctions = ogPlayerAPI;
  }

  unload() {
    this.patcher.unpatchAll();
  }

  private resumeTrackIfAdPlaying() {
    if (this.client.connected && getTrackType() === TrackType.Ad) {
      resumeTrack();
    }
  }

  requestChangeSong(trackUri: string) {
    this.client.socket?.emit('requestChangeSong', trackUri);
  }

  /** p2p rooms sync to the owner's real playback, so song changes can happen live */
  get liveRoom() {
    const kind = this.client.mode?.kind;
    return kind === 'host' || kind === 'join';
  }

  requestUpdateSong(paused: boolean, milliseconds: number) {
    let trackType = getTrackType();
    const current = getCurrentTrackUri();

    if (isListenableTrackType(trackType) && this.isHost && current !== this.roomTrackUri) {
      // the room only hears about songs on a track change, so a song that was already sitting there when
      // you hosted got ignored and play did nothing. tell it about the song first, it starts everyone from here
      if (this.liveRoom) {
        // rooms: tell it the song, then the play/pause goes through the schedule like any other
        this.currentLoadingTrack = current;
        this.trackLoaded = true;
        this.client.socket?.emit('loadingSong', current);
        this.client.socket?.emit('requestUpdateSong', paused, milliseconds);
      } else if (!paused) {
        // a server makes everyone load then start together
        this.currentLoadingTrack = current;
        this.trackLoaded = true;
        pauseTrack();
        this.client.socket?.emit('loadingSong', current, milliseconds);
      }
    } else if (isListenableTrackType(trackType))
      this.client.socket?.emit('requestUpdateSong', paused, milliseconds);
    else
      this.onUpdateSong(
        paused,
        trackType === TrackType.Ad ? undefined : milliseconds,
      );
  }

  async requestSong(trackUri: string) {
    let data = await getTrackData(trackUri);
    if (data && data.error === undefined) {
      this.client.socket?.emit(
        'requestSong',
        trackUri,
        data.name || 'UNKNOWN NAME',
      );
    } else {
      console.error('Failed to request song:', data?.error);
    }
  }

  addToQueue(items: Spicetify.ContextTrack[]) {
    this.client.socket?.emit('addToQueue', items);
  }

  removeFromQueue(items: Spicetify.ContextTrack[]) {
    this.client.socket?.emit('removeFromQueue', items);
  }

  clearQueue() {
    this.client.socket?.emit('clearQueue');
  }

  // Server emitted events
  onQueueUpdate(queue: Spicetify.ContextTrack[]) {
    ogPlayerAPI.clearQueue();
    ogPlayerAPI.addToQueue(queue);
  }

  onAddToQueue(items: Spicetify.ContextTrack[]) {
    ogPlayerAPI.addToQueue(items);
  }

  onRemoveFromQueue(items: Spicetify.ContextTrack[]) {
    ogPlayerAPI.removeFromQueue(items);
  }

  onClearQueue() {
    ogPlayerAPI.clearQueue();
  }

  onChangeSong(trackUri: string) {
    this.roomTrackUri = trackUri;
    if (this.transitionWait) clearTimeout(this.transitionWait);
    this.transitionWait = null;

    if (this.currentLoadingTrack === trackUri) {
      if (this.trackLoaded)
        this.client.socket?.emit('changedSong', this.currentLoadingTrack);
      if (this.liveRoom) this.alignNext = trackUri;
      return;
    }

    // the room moved to the song we're about to roll into anyway (host's song ended a hair before ours).
    // let spotify change it itself so crossfade still happens, only force it if that doesn't come
    const s = Spicetify.Platform.PlayerAPI._state;
    const remaining = Spicetify.Player.getDuration() - getTrackProgress();
    if (
      this.liveRoom &&
      !isTrackPaused() &&
      s?.nextItems?.[0]?.uri === trackUri &&
      remaining < 15000
    ) {
      this.transitionWait = setTimeout(() => {
        this.transitionWait = null;
        if (getCurrentTrackUri() !== trackUri) forcePlayTrack(trackUri);
      }, Math.max(0, remaining) + 2500);
      return;
    }

    forcePlayTrack(trackUri);
  }

  /*
    friends keep the owner's next song at the top of their queue, so when a song ends both spotifys roll
    into the same one at the same moment, crossfade and all. otherwise the friend's would play whatever
    and get yanked over
  */
  mirrorNext(nextUri?: string) {
    if (!nextUri || this.client.mode?.kind !== 'join') return;
    const mine = Spicetify.Platform.PlayerAPI._state?.nextItems?.[0]?.uri;
    if (mine === nextUri) return;
    // spotify's state lags a bit after changing the queue, don't redo it every second
    if (this.mirroredNext === nextUri && Date.now() - this.mirroredAt < 5000) return;
    this.mirroredNext = nextUri;
    this.mirroredAt = Date.now();
    Promise.resolve(ogPlayerAPI.clearQueue?.())
      .then(() => ogPlayerAPI.addToQueue?.([{ uri: nextUri }]))
      .catch((e: any) => console.warn("[listenTogether] couldn't queue the host's next song", e));
  }

  get syncOffset() {
    return this.settingsManager.settings.syncOffset;
  }

  private resetSync() {
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
    this.correcting = false;
    this.driftSamples = [];
    this.settleUntil = Date.now() + SETTLE_TIME;
    if (this.delayedResume) clearTimeout(this.delayedResume);
    this.delayedResume = null;
  }

  onUpdateSong(pause: boolean, milliseconds?: number, at?: number) {
    if (typeof at === 'number' && milliseconds != undefined && this.liveRoom) {
      const hostNow = this.client.socket?.hostTime?.() ?? null;
      if (hostNow !== null) return this.scheduleUpdate(pause, milliseconds, at - hostNow);
    }
    this.resetSync();

    if (milliseconds == undefined) {
      pause ? pauseTrack() : resumeTrack();
      return;
    }

    if (pause) {
      ogPlayerAPI.seekTo(milliseconds);
      pauseTrack();
      return;
    }

    const target = milliseconds + this.syncOffset;
    // already playing it about there (host's own echo, someone joining mid song), a seek would just hiccup
    if (
      !isTrackPaused() &&
      target >= 0 &&
      Math.abs(getTrackProgress() - target) <
        // the room owner gets their own seeks echoed back late, 250 keeps that from double seeking
        (this.client.mode?.kind === 'host' ? LOOSE.tolerance : PRECISE.tolerance)
    ) {
      return;
    }
    if (target >= 0) {
      ogPlayerAPI.seekTo(target);
      resumeTrack();
    } else {
      // can't seek before 0, so a negative offset at the start of a song = just start late
      ogPlayerAPI.seekTo(0);
      pauseTrack();
      this.delayedResume = setTimeout(() => {
        this.delayedResume = null;
        resumeTrack();
      }, -target);
    }
  }

  /*
    rooms: do it at the shared moment. wait > 0 = that moment is coming, wait <= 0 = it already happened on
    the host's side (media keys etc), so jump to where they are now.
    no seek lead on the scheduled ones, everyone eats the same seek stall at the same time
  */
  private scheduleUpdate(pause: boolean, milliseconds: number, wait: number) {
    this.resetSync();
    const offset = this.syncOffset;
    const later = (fn: () => void) => {
      if (wait <= 0) return fn();
      this.scheduled = setTimeout(() => {
        this.scheduled = null;
        fn();
      }, wait);
    };
    const settle = () => (this.settleUntil = Date.now() + SETTLE_TIME);

    if (pause) {
      later(() => {
        pauseTrack();
        const spot = Math.max(0, milliseconds + offset);
        // only park on the exact spot if we're actually off, the owner usually already is
        if (Math.abs(getTrackProgress() - spot) >= PRECISE.tolerance) ogPlayerAPI.seekTo(spot);
      });
      return;
    }

    if (isTrackPaused()) {
      if (wait > 0) {
        // park on the spot now, so at the moment all that's left is hitting play
        ogPlayerAPI.seekTo(Math.max(0, milliseconds + offset));
        later(() => {
          resumeTrack();
          settle();
        });
      } else {
        ogPlayerAPI.seekTo(Math.max(0, milliseconds - wait + offset + this.seekLead));
        resumeTrack();
        settle();
      }
      return;
    }

    later(() => {
      // re-read the moment it runs, for the catch up case the target's been moving
      const target = milliseconds + Math.max(0, -wait) + offset;
      if (Math.abs(getTrackProgress() - target) >= PRECISE.tolerance) {
        ogPlayerAPI.seekTo(Math.max(0, target + (wait > 0 ? 0 : this.seekLead)));
        settle();
      }
    });
  }

  /**
   * hostTimestamp = when (host's clock) the host was at milliseconds. rooms send it, the node server doesn't,
   * and then milliseconds is just where an in sync listener is when this lands
   */
  onSyncPosition(trackUri: string, milliseconds: number, hostTimestamp?: number) {
    // in your own room your playback IS the reference, so you never get yanked around
    if (this.client.mode?.kind === 'host') return;
    if (!this.trackLoaded || this.delayedResume) return;
    if (getCurrentTrackUri() !== trackUri || isTrackPaused()) return;
    // a fresh song gets lined up on the first reading, the settle wait is for after seeks
    if (Date.now() < this.settleUntil && this.alignNext !== trackUri) return;

    const hostNow =
      typeof hostTimestamp === 'number' ? this.client.socket?.hostTime?.() ?? null : null;
    const precise = hostNow !== null;
    const cfg = precise ? PRECISE : LOOSE;
    const expected = precise ? milliseconds + (hostNow! - hostTimestamp!) : milliseconds;

    const target = expected + this.syncOffset;
    if (target < 0 || target > Spicetify.Player.getDuration() - END_GUARD)
      return;

    const drift = getTrackProgress() - target;
    this.driftSamples.push(drift);
    if (this.driftSamples.length > cfg.samples) this.driftSamples.shift();
    const sorted = [...this.driftSamples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    if (this.correcting && this.driftSamples.length >= 3) {
      // what's left after our last seek is how late spotify starts playing after one. half steps on a
      // median, single readings made it overshoot and bounce back and forth
      this.seekLead = Math.min(MAX_SEEK_LEAD, Math.max(0, this.seekLead - median / 2));
      this.correcting = false;
    }

    // 2 big ones in a row is a real jump, not noise. those skip the wait
    const bigJump =
      this.driftSamples.length >= 2 &&
      this.driftSamples.slice(-2).every((d) => Math.abs(d) > BIG_DRIFT);

    // just got on a new song: line up on the first clean reading instead of waiting for 5
    const aligning = precise && this.alignNext === trackUri;
    if (aligning) this.alignNext = null;
    const alignNow = aligning && Math.abs(drift) >= cfg.tolerance;

    if (!bigJump && !alignNow) {
      if (this.driftSamples.length < cfg.samples) return;
      if (Math.abs(median) < cfg.tolerance) return;
      if (Date.now() - this.lastCorrection < cfg.cooldown) return;
    }

    console.log(
      `[listenTogether] ${Math.round(alignNow ? drift : median)}ms off (${alignNow ? 'new song' : precise ? 'precise' : 'loose'}), seeking with ${Math.round(this.seekLead)}ms lead`,
    );
    ogPlayerAPI.seekTo(target + this.seekLead);
    this.correcting = true;
    this.driftSamples = [];
    this.lastCorrection = Date.now();
    this.settleUntil = Date.now() + SETTLE_TIME;
  }

  setSyncOffset(offset: number) {
    const delta = offset - this.syncOffset;
    this.settingsManager.settings.syncOffset = offset;
    this.settingsManager.saveSettings();

    // move right away instead of waiting for the next sync, so you can hear the slider doing stuff
    if (
      delta !== 0 &&
      this.client.connected &&
      this.trackLoaded &&
      !isTrackPaused() &&
      isListenableTrackType()
    ) {
      // same lead as corrections, without it the seek stall ate most of a 300ms move in testing
      this.correcting = true;
      this.driftSamples = [];
      this.settleUntil = Date.now() + SETTLE_TIME;
      ogPlayerAPI.seekTo(
        Math.max(0, getTrackProgress() + delta + this.seekLead),
      );
    }
  }

  // Events
  onSongChanged(trackUri?: string) {
    if (trackUri === undefined) trackUri = getCurrentTrackUri();

    console.log(`Changed track to ${trackUri}`);
    this.currentLoadingTrack = trackUri;
    this.resetSync();

    if (this.client.connected) {
      if (isListenableTrackType(getTrackType(trackUri))) {
        this.trackLoaded = false;
        this.client.socket?.emit('loadingSong', trackUri);

        this.spotifyUtils.onTrackLoaded(trackUri!, () => {
          this.trackLoaded = true;
          if (this.liveRoom) {
            // keep playing, the first sync lines us up (and the owner is the reference anyway)
            this.alignNext = trackUri!;
          } else {
            pauseTrack();
            ogPlayerAPI.seekTo(0);
          }

          // Extract image url safely
          const imageUrl =
            Spicetify.Platform.PlayerAPI._state?.item?.images?.[0]?.['url'];
          this.client.socket?.emit(
            'changedSong',
            trackUri,
            Spicetify.Platform.PlayerAPI._state?.item?.name,
            imageUrl,
          );

          // Change volume back to normal
          if (this.volumeChangeEnabled) {
            ogPlayerAPI.setVolume(this.lastVolume);
            this.lastVolume = null;
            this.canChangeVolume = true;
          }
        });
      } else {
        this.client.socket?.emit('changedSong', trackUri);
      }
    }
  }

  onLogin() {
    this.roomTrackUri = '';
    pauseTrack();
    if (this.volumeChangeEnabled) {
      this.canChangeVolume = true;
      this.lastVolume = Spicetify.Player.getVolume();
      this.ui.bottomMessage('Connected to the server.');
    }
  }

  muteBeforePlay() {
    // Lower volume to 0s
    if (this.volumeChangeEnabled) {
      this.canChangeVolume = false;
      if (this.lastVolume === null)
        this.lastVolume = Spicetify.Player.getVolume();
      ogPlayerAPI.setVolume(0);
    }
  }
}
