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
// 150 is a guess, tune it. drift under this gets left alone, every correction is a seek and seeks hiccup
const DRIFT_TOLERANCE = 150;
// progress is prob off for a bit after a seek or resume, so no judging drift till it settles
const SETTLE_TIME = 2000;
const MAX_SEEK_LEAD = 1000;
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

  requestUpdateSong(paused: boolean, milliseconds: number) {
    let trackType = getTrackType();

    if (isListenableTrackType(trackType))
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
    if (this.currentLoadingTrack === trackUri) {
      if (this.trackLoaded)
        this.client.socket?.emit('changedSong', this.currentLoadingTrack);
    } else {
      forcePlayTrack(trackUri);
    }
  }

  get syncOffset() {
    return this.settingsManager.settings.syncOffset;
  }

  private resetSync() {
    this.correcting = false;
    this.settleUntil = Date.now() + SETTLE_TIME;
    if (this.delayedResume) clearTimeout(this.delayedResume);
    this.delayedResume = null;
  }

  onUpdateSong(pause: boolean, milliseconds?: number) {
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

  /** milliseconds = where an in sync listener is right now, the server lines up the arrival time */
  onSyncPosition(trackUri: string, milliseconds: number) {
    if (!this.trackLoaded || this.delayedResume) return;
    if (getCurrentTrackUri() !== trackUri || isTrackPaused()) return;
    if (Date.now() < this.settleUntil) return;

    const target = milliseconds + this.syncOffset;
    if (target < 0 || target > Spicetify.Player.getDuration() - END_GUARD)
      return;

    const drift = getTrackProgress() - target;

    if (this.correcting) {
      // whatever's left after our last seek is how late spotify starts playing after one.
      // half steps so one bad reading doesn't throw it way off
      this.seekLead = Math.min(
        MAX_SEEK_LEAD,
        Math.max(0, this.seekLead - drift / 2),
      );
      this.correcting = false;
    }

    if (Math.abs(drift) < DRIFT_TOLERANCE) return;

    console.log(
      `[listenTogether] ${Math.round(drift)}ms off, seeking (lead ${Math.round(this.seekLead)}ms)`,
    );
    ogPlayerAPI.seekTo(target + this.seekLead);
    this.correcting = true;
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
          pauseTrack();
          ogPlayerAPI.seekTo(0);

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
