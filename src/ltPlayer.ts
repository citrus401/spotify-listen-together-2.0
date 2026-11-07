import Client from './client';
import Patcher, { ogPlayerAPI } from './utils/patcher';
import SettingsManager from './utils/settings';
import { waitFor, waitUntil } from './utils/timing';
import UI from './ui/ui';
import pJson from '../package.json';
import './utils/spotifyUtils';
import {
  forcePlayTrack,
  getCurrentTrackUri,
  getQueuedItems,
  getTrackData,
  getShareableContext,
  getTrackProgress,
  getTrackType,
  PlayContext,
  isListenableTrackType,
  isTrackPaused,
  pauseTrack,
  resumeTrack,
  SpotifyUtils,
  TrackType,
} from './utils/spotifyUtils';

const AD_CHECK_INTERVAL = 2000;
/*
  spotify won't change speed on music (setSpeed says not_supported_by_content_type) and has no ducking on
  desktop, so every correction is a jump of some kind. measured on 1.3.8:
  - a plain seek while playing: 125-200 ms of silence, lands anywhere within ±40 ms, and spotify's own
    report of where it landed is ~128 ms off till it fixes itself ~130 ms later
  - pause, seek while paused, resume: ~35 ms of silence, resumes 11-15 ms after the call, and the report
    stays true
  so rooms realign with the second one (realign()), on clean readings only.
  precise = rooms. timestamped positions + matched clocks. loose = the node server, timing there is a guess
  at the network delay so it keeps the old slack. drift is judged on the median of the last few readings
*/
// tolerance = mid-song drift that gets fixed. a playing song only gets touched past this, the rest of the
// time players barely drift (spotify's position moved 3 ms in 2.5 min, measured)
const PRECISE = { tolerance: 15, samples: 5, cooldown: 15000 };
const LOOSE = { tolerance: 250, samples: 3, cooldown: 30000 };
/*
  spotify's position report is only true some of the time. after a song starts it was 57-89 ms off till
  spotify corrected itself ~6 s in, and after a seek ~128 ms off for ~130 ms (measured). so a report only
  counts as settled once it's spotify fixing itself (a small jump on the same song), our own realign, or
  old enough
*/
const SETTLE_REPORT = 7000;
const SELF_FIX_MAX = 250;
// realign plans the restart this far ahead, enough for the seek while paused to land first
const REALIGN_PLAN = 50;
const BIG_JUMP_COOLDOWN = 5000;
/*
  with spotify minimized it takes 0-200 ms to act on a command and first reports the moment it was asked,
  then corrects that ~170-230 ms later. so ~4 in 10 single jumps landed 90-320 ms off (measured). every
  jump gets checked once that correction is in, and goes again if it's off. a jump is happening anyway, so
  another short one is the least noticeable time to fix it
*/
const ALIGN_GOAL = 10;
const ALIGN_TRIES = 3;
const ALIGN_CHECK = 600;
/*
  some pcs correct it way later tho. a friend on vorbis read ~0 ms off 600 ms after every jump, then 1-4 s in
  spotify moved its report +100 ms, so every jump really landed 100 ms ahead and the start delay it learned
  was garbage. so the check waits out that correction (each pc learns how late its come, reportFix), up to
  this long, and goes by what's left after it
*/
const VERIFY_MAX = 5000;
// the report has to sit still this long before a correction counts as done
const FIX_QUIET = 800;
// reports this soon after a resume are still the resume itself, not spotify correcting it
const RESUME_SETTLE = 500;
// corrections up to this long after a resume teach how far off its report was (see checkBias)
const BIAS_WINDOW = 10000;
// a pc that keeps missing waits longer and longer before trying again, never a blip every 15 s
const MAX_ALIGN_BACKOFF = 4 * 60 * 1000;
const TIMING_KEY = 'listenTogether:timing:';
// 2 readings this far off in a row is a real jump (buffering, a skip), fixed right away
const BIG_DRIFT = 1000;
// progress is prob off for a bit after a seek or resume, so no judging drift till it settles
const SETTLE_TIME = 2000;
const MAX_SEEK_LEAD = 600;
// near the end a correction could seek past it and skip the song
const END_GUARD = 2000;
// the room panel shows each friend's drift. sent at most this often, and only when it moved a bit
const SYNC_REPORT_EVERY = 2000;
const SYNC_REPORT_STEP = 2;
// no readings for this long (paused, loading, another song) = stop showing a number that's not true anymore
const SYNC_REPORT_STALE = 4000;
// a song change counts as picked by you (not spotify rolling into the next one) for this long after you clicked
const PICKED_WINDOW = 5000;

function sameList(a: string[], b: string[]) {
  return a.length === b.length && a.every((uri, i) => uri === b[i]);
}

/** what's queued as far as spotify's queue code knows, it can be ahead of _state. falls back to _state */
function queuedNow(): string[] {
  const raw = Spicetify.Platform.PlayerAPI._queue?._queue?.nextTracks;
  if (!Array.isArray(raw)) return getQueuedItems().map((i) => i.uri);
  return raw.filter((t: any) => t?.provider === 'queue').map((t: any) => String(t.contextTrack?.uri));
}

function median(xs: number[]) {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** the last 5 of something this pc learned earlier */
function savedList(name: string): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(TIMING_KEY + name) || '[]');
    return Array.isArray(v) ? v.filter((x) => Number.isFinite(x)).slice(-5) : [];
  } catch {
    return [];
  }
}

/** a timing number this pc learned earlier, or the fallback */
function savedTiming(name: string, fallback: number) {
  const v = Number(localStorage.getItem(TIMING_KEY + name) ?? NaN);
  return Number.isFinite(v) ? v : fallback;
}

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
  /** rooms: the owner's queue and next song. null = the room doesn't send its queue (older version) */
  private roomQueue: string[] | null = null;
  private roomNext = '';
  private mirroredKey = '';
  private mirroredAt = 0;
  private settleUntil = 0;
  private delayedResume: ReturnType<typeof setTimeout> | null = null;
  /** spotify's last position report, and whether it can be trusted (see SETTLE_REPORT) */
  private report = { key: '', track: '', pos: 0, ts: 0, paused: true, since: 0, settled: false };
  private trustNextReport = false;
  /*
    ms from resume() to the music really playing, after a seek while paused. learned from where jumps really
    landed, not from spotify's first report: on a friend's pc every jump landed ~75 ms behind while spotify
    reported it right on time. kept per pc between sessions. can go below 0 on a pc whose spotify reports the
    start late. new key cuz the old one got learned off reports that weren't done correcting yet
  */
  private resumeLag = savedTiming('startLag', 13);
  /** ms from a seek while paused to spotify saying it's parked there. learned, 10-200 depending on if it's minimized */
  private parkLag = savedTiming('parkLag', 40);
  /** how long after a resume this pc's spotify still corrects its report. -1 = don't know yet, 0 = it doesn't */
  private reportFix = savedTiming('reportFix', -1);
  private resumedAt = 0;
  private checks = 0;
  /** the last few corrections spotify made to the report right after one of our resumes, see checkBias */
  private biasSeen = savedList('biasSeen');
  /** how far that report is behind where the song really is: the middle one, minimized spotify throws a random -100 now and then */
  private reportBias = median(this.biasSeen);
  /** the report's still the one from our last resume, nothing's corrected it yet */
  private biasPending = false;
  /** that jump's check is done, so a correction from here on means the check was off too */
  private lateOpen = false;
  /** when you last picked a song yourself (play, next, previous), see onSongChanged */
  songPickedAt = 0;
  /** tries at copying the room's current queue, see mirrorQueue */
  private mirrorTries = 0;
  private mirroring = false;
  /** jumps that still missed after all their tries in a row. each one doubles the wait before the next */
  private alignMisses = 0;
  private realigning = false;
  /** a jump and its checks are running, readings and other jumps keep out */
  private aligning = false;
  /** > 0 while the sync itself is calling the player, the patcher lets those through */
  ownCommand = 0;
  private resyncWanted = false;
  /** bumped on every room action and reset, a pending scheduled one only runs if it's still the latest */
  private scheduleGen = 0;
  /** the room's last position: song, ms, host clock time, and if the owner's report was settled */
  private lastRef: { trackUri: string; ms: number; hostTs: number; settled: boolean } | null = null;
  private lastReadingAt = 0;
  private sentSync: number | null = null;
  private sentSyncAt = 0;
  private sentSyncTo: unknown = null;

  // listeners live here and not in init(), init runs on every connect and they used to pile up
  constructor() {
    this.patcher.subscribeToPlayerEvents();
    this.patcher.trackChanged.on((trackUri) => {
      this.onSongChanged(trackUri!);
    });

    setInterval(() => {
      this.resumeTrackIfAdPlaying();
    }, AD_CHECK_INTERVAL);
    // spotify's reports can come and get fixed within ~130 ms, so look often enough to see both
    setInterval(() => {
      if (this.client.connected) this.positionSettled();
    }, 40);
  }

  init() {
    this.patcher.patchAll();
    // a new room, nothing known about it yet. an old room's position got used for a realign once
    this.roomQueue = null;
    this.roomNext = '';
    this.mirroredKey = '';
    this.mirrorTries = 0;
    this.lastRef = null;
    this.alignNext = null;
    this.resyncWanted = false;

    // this.volumeChangeEnabled = !!ogPlayerAPI.setVolume;

    // For testing
    (<any>Spicetify).OGFunctions = ogPlayerAPI;
  }

  unload() {
    this.patcher.unpatchAll();
    // left a room: the owner's songs we copied in don't belong in your queue anymore
    if (this.mirroredKey) {
      this.mirroredKey = '';
      Promise.resolve(ogPlayerAPI.clearQueue?.()).catch(() => {});
    }
  }

  private resumeTrackIfAdPlaying() {
    if (this.client.connected && getTrackType() === TrackType.Ad) {
      resumeTrack();
    }
  }

  requestChangeSong(trackUri: string) {
    this.client.socket?.emit('requestChangeSong', trackUri);
  }

  /** you made the room you're in, so your spotify is what everyone else copies */
  get ownsRoom() {
    return this.client.mode?.kind === 'host';
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
        this.client.socket?.emit('loadingSong', current, 0, getShareableContext());
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
    if (this.client.mode?.kind !== 'host') return ogPlayerAPI.removeFromQueue(items);
    // in your own room this came from a friend. their queue items have their own ids, so find ours by song,
    // one of ours per one of theirs (the same song queued twice only loses one)
    const mine = getQueuedItems();
    const picked: { uri: string; uid?: string }[] = [];
    for (const item of items || []) {
      const match = mine.find((m) => m.uri === item?.uri && !picked.includes(m));
      if (match) picked.push(match);
    }
    if (picked.length) ogPlayerAPI.removeFromQueue(picked.map((m) => ({ uri: m.uri, uid: m.uid })));
  }

  onClearQueue() {
    ogPlayerAPI.clearQueue();
  }

  onChangeSong(trackUri: string, context?: PlayContext) {
    this.roomTrackUri = trackUri;
    const play = () => {
      // started it ourselves, so it's at whatever moment that happened to be. realign as soon as the room's
      // position is settled. songs that roll over on their own are left alone, they're already in line
      if (this.liveRoom) this.alignNext = trackUri;
      forcePlayTrack(trackUri, context);
      if (!context) return;
      // a private or region locked playlist won't open for everyone. if we didn't land on the song, go solo
      setTimeout(() => {
        if (this.roomTrackUri === trackUri && getCurrentTrackUri() !== trackUri)
          forcePlayTrack(trackUri);
      }, 4000);
    };
    if (this.transitionWait) clearTimeout(this.transitionWait);
    this.transitionWait = null;

    // already on it (rejoined, or had it open): playing it again would restart it at 0, and since the song
    // didn't change spotify never says so, so the room kept sending it every 5 s and it kept restarting.
    // just tell the room and line up
    if (this.liveRoom && getCurrentTrackUri() === trackUri && this.currentLoadingTrack !== trackUri) {
      this.currentLoadingTrack = trackUri;
      this.trackLoaded = true;
      this.alignNext = trackUri;
      this.client.socket?.emit('changedSong', trackUri);
      return;
    }

    if (this.currentLoadingTrack === trackUri) {
      if (this.trackLoaded)
        this.client.socket?.emit('changedSong', this.currentLoadingTrack);
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
        if (getCurrentTrackUri() !== trackUri) play();
      }, Math.max(0, remaining) + 2500);
      return;
    }

    play();
  }

  mirrorNext(nextUri?: string) {
    if (!nextUri || this.client.mode?.kind !== 'join') return;
    this.roomNext = nextUri;
    this.mirrorQueue();
  }

  /** the owner's queue, sent whenever it changes. rooms from before this never send it */
  onQueueSync(uris: string[]) {
    if (this.client.mode?.kind !== 'join' || !Array.isArray(uris)) return;
    this.roomQueue = uris.filter((u) => typeof u === 'string');
    this.mirrorQueue();
  }

  /*
    a friend's queue is the owner's queue. with nothing queued it's just the owner's next song, so when a song
    ends both spotifys roll into the same one at the same moment, crossfade and all (otherwise the friend's
    would play whatever and get yanked over)
  */
  private mirrorQueue() {
    // not mid jump either, a queue change makes spotify report its position again and that'd mess up the check
    if (this.client.mode?.kind !== 'join' || this.mirroring || this.aligning) return;
    const want = this.roomQueue?.length ? this.roomQueue : this.roomNext ? [this.roomNext] : [];
    // older room, no queue from it: only ever set the next song, never wipe
    if (this.roomQueue === null && !want.length) return;
    const mine = getQueuedItems().map((i) => i.uri);
    if (sameList(want, mine)) {
      this.mirrorTries = 0;
      return;
    }

    // song changes don't land on both sides at the exact same moment, so mid change one list is a song
    // ahead of the other. wait till we're on the room's song and its list moved past it
    const current = getCurrentTrackUri();
    if (this.roomTrackUri !== current || want[0] === current) return;

    const key = want.join(' ');
    if (key !== this.mirroredKey) {
      this.mirroredKey = key;
      this.mirrorTries = 0;
    }
    // spotify's state lags a bit after changing the queue so give it a sec. and a list that still doesn't
    // match after 3 goes gets left alone, redoing it forever piled one song up dozens of times for a friend
    const wait = this.mirrorTries ? 3000 * 2 ** (this.mirrorTries - 1) : 0;
    if (this.mirrorTries >= 3 || Date.now() - this.mirroredAt < wait) return;
    this.mirrorTries++;
    this.mirroredAt = Date.now();
    this.mirroring = true;
    this.copyQueue(mine, want)
      .catch((e: any) => console.warn("[listenTogether] couldn't copy the host's queue", e))
      .finally(() => (this.mirroring = false));
  }

  private async copyQueue(mine: string[], want: string[]) {
    // usual case, a song played through: same list minus the new one at the end, so only add that
    const tail = mine.length < want.length && mine.every((uri, i) => uri === want[i]);
    if (!tail && mine.length) {
      await ogPlayerAPI.clearQueue();
      // spotify adds 2+ songs on top of its own cached copy of the queue, and adding before that copy had the
      // clear in it put every old song right back. so wait for it
      if (!(await waitFor(() => !queuedNow().length && !getQueuedItems().length, 2000))) return;
    }
    // one at a time, a single add doesn't touch that cached copy at all
    for (const uri of want.slice(tail ? mine.length : 0)) await ogPlayerAPI.addToQueue([{ uri }]);
  }

  get syncOffset() {
    return this.settingsManager.settings.syncOffset;
  }

  private resetSync() {
    this.scheduleGen++;
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
    // already playing it about there (host's own echo, someone joining mid song), a seek would just hiccup.
    // only the node server gets here, rooms always schedule
    if (!isTrackPaused() && target >= 0 && Math.abs(getTrackProgress() - target) < LOOSE.tolerance) return;
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
    the host's side (media keys etc), so jump to where they are now. the owner runs these too, so play,
    pause and seeks land with the precise jump on every side and spotify's reports stay true
  */
  private scheduleUpdate(pause: boolean, milliseconds: number, wait: number) {
    this.resetSync();
    const offset = this.syncOffset;
    const at = Date.now() + wait;
    // where the song should be at local time t, playing from the shared moment on
    const spotAt = (t: number) => milliseconds + offset + Math.max(0, t - at);

    if (pause) {
      const stop = () => {
        pauseTrack();
        const spot = Math.max(0, milliseconds + offset);
        // only park on the exact spot if we're actually off, the owner usually already is
        if (Math.abs(getTrackProgress() - spot) >= PRECISE.tolerance) ogPlayerAPI.seekTo(spot);
      };
      if (wait <= 0) return stop();
      const gen = this.scheduleGen;
      waitUntil(at).then(() => gen === this.scheduleGen && stop());
      return;
    }

    // already there (the owner's own echo, a resume that changes nothing): leave it alone
    if (!isTrackPaused() && Math.abs(this.progress() - spotAt(Date.now())) < PRECISE.tolerance) return;
    const first = () => Math.max(at, Date.now() + REALIGN_PLAN);
    const go = () =>
      this.client.mode?.kind === 'join'
        ? this.jumpAndCheck(() => spotAt, first(), 'room')
        : this.jumpTo(spotAt, first(), 'room');
    // start a bit before the moment so the seek is parked by then and the start lands right on it.
    // waitUntil and not setTimeout, a minimized spotify would run it up to a second late
    const lead = 200;
    if (wait - lead <= 0) return go();
    const gen = this.scheduleGen;
    waitUntil(at - lead).then(() => gen === this.scheduleGen && go());
  }

  /** is spotify's position report trustworthy right now. see SETTLE_REPORT */
  positionSettled() {
    const s = Spicetify.Platform.PlayerAPI._state;
    if (!s || s.positionAsOfTimestamp == null || s.timestamp == null) return false;
    const track = s.item?.uri || '';
    const pos = Number(s.positionAsOfTimestamp);
    const ts = Number(s.timestamp);
    const paused = !!s.isPaused;
    const key = `${track}|${ts}|${pos}|${paused}`;
    const last = this.report;
    if (key !== last.key) {
      // a small jump on the same song while playing = spotify correcting its own last report
      const moved = pos - (last.pos + (ts - last.ts));
      const selfFix =
        last.key !== '' && track === last.track && !paused && !last.paused && Math.abs(moved) < SELF_FIX_MAX;
      // buffering = the music really stopped for a bit, not the report getting fixed
      if (this.biasPending) this.checkBias(selfFix && !s.isBuffering, moved);
      const ours = this.trustNextReport && !paused;
      if (ours) this.trustNextReport = false;
      this.report = { key, track, pos, ts, paused, since: Date.now(), settled: ours || selfFix };
    }
    if (!this.report.settled && Date.now() - this.report.since > SETTLE_REPORT) this.report.settled = true;
    return this.report.settled && !paused;
  }

  /** where the song really is: spotify's report, plus how far that report's known to be behind right after our jumps */
  progress() {
    return getTrackProgress() + (this.biasPending && !isTrackPaused() ? this.reportBias : 0);
  }

  /*
    spotify's report right after our resume is behind where the music really is, and it only fixes that later:
    on its own 1-4 s in on some pcs, or only once something else makes it report again (adding a song moved it
    +35-47 ms here, +100 on a friend's, measured). going by the raw report the check aimed at one number and
    the correction moved it to another, so every song he got lined up and then "drifted" 100 ms. so how far
    behind it is gets learned off every correction and added on (progress()) till spotify corrects it itself.
    moved = how far this new report moved from the last one
  */
  private checkBias(sameChain: boolean, moved: number) {
    // paused, other song, a real jump: that report's gone
    if (!sameChain) return void (this.biasPending = false);
    // the first ~half second is still the resume itself, minimized spotify corrects that one ~200 ms in
    const age = Date.now() - this.resumedAt;
    if (age < RESUME_SETTLE) return;
    this.biasPending = false;
    // way later it's more likely something else happened than spotify fixing our resume, so don't learn off it
    if (age > BIAS_WINDOW) return;
    const missed = moved - this.reportBias;
    this.biasSeen = [...this.biasSeen, Math.round(moved)].slice(-5);
    this.reportBias = median(this.biasSeen);
    localStorage.setItem(TIMING_KEY + 'biasSeen', JSON.stringify(this.biasSeen));
    // the jump's check is over and went by the old guess, so it was off by what the guess missed. once per jump,
    // and not off one of those random ones
    if (!this.lateOpen || Math.abs(missed) < 3 || Math.abs(missed) > 80) return;
    this.lateOpen = false;
    this.resumeLag = Math.min(400, Math.max(-200, this.resumeLag + Math.max(-40, Math.min(40, -missed * 0.6))));
    localStorage.setItem(TIMING_KEY + 'startLag', String(Math.round(this.resumeLag)));
    console.log(`[listenTogether] spotify corrected itself ${Math.round(moved)} ms ${Date.now() - this.resumedAt} ms after a jump, ${Math.round(missed)} more than expected`);
    this.sendSyncDebug('late correction', missed);
  }

  /** spotify corrected its report this long after one of our resumes */
  private learnReportFix(ms: number) {
    // up to a late one right away, down slowly. a check that ends before the correction is way worse than a slow one
    this.reportFix = Math.max(ms, this.reportFix > 0 ? this.reportFix * 0.8 + ms * 0.2 : 0);
    localStorage.setItem(TIMING_KEY + 'reportFix', String(Math.round(this.reportFix)));
  }

  /** a long check went by without any correction */
  private learnNoReportFix() {
    this.reportFix = this.reportFix > 150 ? this.reportFix * 0.6 : 0;
    localStorage.setItem(TIMING_KEY + 'reportFix', String(Math.round(this.reportFix)));
  }

  /*
    the precise jump: pause, seek while paused to exactly where the song should be when it starts again,
    then resume on the planned moment. ~35 ms of quiet and it lands within a few ms, where a plain seek is
    125-200 ms of quiet landing anywhere within ±40 (measured). spotAt(t) = where to be at local time t
  */
  private async jumpTo(spotAt: (t: number) => number, resumeAt: number, why: string) {
    if (this.realigning) return false;
    const end = Spicetify.Player.getDuration() - END_GUARD;
    const state = () => Spicetify.Platform.PlayerAPI._state;
    // a player call that never comes back can't be allowed to hang the jump with the music paused
    const own = async (fn: () => any) => {
      this.ownCommand++;
      try {
        return await Promise.race([
          fn(),
          new Promise((_, no) => setTimeout(() => no(new Error('player call timed out')), 2500)),
        ]);
      } finally {
        this.ownCommand--;
      }
    };
    let pausedIt = false;
    let playing = false;
    this.realigning = true;
    try {
      /*
        a seek sent before spotify has really paused gets dropped, and it then resumes from wherever it
        paused (landed ~85 ms behind every time, the length of the pause). so wait for spotify to say it's
        paused, then for it to say it's parked on the exact spot, and only then play. with spotify minimized
        those take up to ~200 ms, so the restart gets planned with however long parking has been taking
      */
      if (!state()?.isPaused) {
        pausedIt = true;
        await own(() => ogPlayerAPI.pause());
        await waitFor(() => !!state()?.isPaused, 600);
      }
      let parked = false;
      for (let tries = 0; tries < 3 && !parked; tries++) {
        resumeAt = Math.max(resumeAt, Date.now() + this.parkLag * 1.5 + 15);
        const spot = Math.round(spotAt(resumeAt + this.resumeLag));
        if (spot < 0 || spot > end) return false;
        const seekAt = Date.now();
        await own(() => ogPlayerAPI.seekTo(spot));
        parked = await waitFor(
          () => !!state()?.isPaused && Math.abs(Number(state().positionAsOfTimestamp) - spot) < 3,
          600,
        );
        if (parked) {
          this.parkLag = this.parkLag * 0.7 + (Date.now() - seekAt) * 0.3;
          localStorage.setItem(TIMING_KEY + 'parkLag', String(Math.round(this.parkLag)));
        }
        // parked too late for the planned moment counts as not parked, plan again
        if (parked && Date.now() > resumeAt - 2) parked = false;
      }
      await waitUntil(resumeAt);
      // trusted, with what it's known to be off added on (progress())
      this.trustNextReport = true;
      this.biasPending = false;
      this.lateOpen = false;
      const calledAt = Date.now();
      this.resumedAt = calledAt;
      await own(() => ogPlayerAPI.resume());
      let started = await waitFor(() => !state()?.isPaused && Number(state().timestamp) >= calledAt - 5, 1500);
      // never leave someone sitting paused because a resume got lost somewhere
      if (!started && state()?.isPaused) {
        console.warn("[listenTogether] resume didn't take, trying again");
        await own(() => ogPlayerAPI.resume());
        started = await waitFor(() => !state()?.isPaused, 1500);
      }
      playing = started;
      if (started) {
        // see the resume's report first, so it's not taken for a correction. the owner doesn't get a check, so
        // a correction counts against its jump from here on. a friend's check opens that when it's done
        this.positionSettled();
        this.biasPending = true;
        this.lateOpen = this.client.mode?.kind !== 'join';
        const lag = Number(state().timestamp) - calledAt;
        const off = Number(state().positionAsOfTimestamp) - spotAt(Number(state().timestamp));
        console.log(`[listenTogether] realigned (${why}), landed ${Math.round(off)} ms off, start lag ${Math.round(lag)} ms`);
      }
      this.driftSamples = [];
      this.lastCorrection = Date.now();
      return true;
    } catch (e) {
      console.warn('[listenTogether] realign failed', e);
      return false;
    } finally {
      // whatever happened, never leave someone paused that we paused
      if (pausedIt && !playing && Spicetify.Platform.PlayerAPI._state?.isPaused) {
        this.ownCommand++;
        Promise.resolve(ogPlayerAPI.resume()).finally(() => this.ownCommand--);
      }
      this.realigning = false;
    }
  }

  /** where the room is at local time t, off its last settled position. null = nothing good to go by */
  private roomSpotAt() {
    const ref = this.lastRef;
    if (!ref || !ref.settled || getCurrentTrackUri() !== ref.trackUri) return null;
    const hostNow = this.client.socket?.hostTime?.();
    if (hostNow == null) return null;
    // host clock minus ours, so a local moment maps onto the host's timeline
    const skew = hostNow - Date.now();
    return (t: number) => ref.ms + (t + skew - ref.hostTs) + this.syncOffset;
  }

  /** line up with the room right now. false = nothing good to line up to yet */
  private realign(why: string) {
    if (!this.liveRoom || this.client.mode?.kind !== 'join' || this.aligning || !this.roomSpotAt()) return false;
    this.jumpAndCheck(() => this.roomSpotAt(), Date.now() + REALIGN_PLAN, why);
    return true;
  }

  /*
    jump, wait for spotify to correct its report of where that landed, check, go again if it's off.
    spotAtNow is asked fresh every try. anything the room does meanwhile (seek, pause, new song) bumps
    scheduleGen and stops it
  */
  private async jumpAndCheck(spotAtNow: () => ((t: number) => number) | null, firstAt: number, why: string) {
    if (this.aligning) return false;
    this.aligning = true;
    const gen = this.scheduleGen;
    const track = getCurrentTrackUri();
    try {
      for (let i = 0; i < ALIGN_TRIES; i++) {
        const spotAt = spotAtNow();
        if (!spotAt) return false;
        const label = i ? `${why}, try ${i + 1}` : why;
        if (!(await this.jumpTo(spotAt, i ? Date.now() + REALIGN_PLAN : firstAt, label))) return false;
        const timeline: string[] = [];
        const off = await this.landing(spotAtNow, gen, track, timeline);
        if (off === null) {
          console.log(`[listenTogether] ${label}: check skipped, ${gen !== this.scheduleGen ? "room did something new" : isTrackPaused() ? "paused" : "other song"}`);
          return false;
        }
        console.log(`[listenTogether] ${label}: really ${Math.round(off)} ms off (${timeline.join(' ')})`);
        // behind = the music starts later than planned on this pc, so plan it earlier next time. part of the
        // way and at most 40 ms a go: spotify still lands one randomly ~90 ms off now and then, and a full
        // step on that swung it the wrong way in testing
        this.resumeLag = Math.min(400, Math.max(-200, this.resumeLag + Math.max(-40, Math.min(40, -off * 0.6))));
        localStorage.setItem(TIMING_KEY + 'startLag', String(Math.round(this.resumeLag)));
        this.sendSyncDebug(label, off, timeline.join(' '));
        if (Math.abs(off) <= ALIGN_GOAL) {
          this.alignMisses = 0;
          return true;
        }
      }
      this.alignMisses++;
      return false;
    } finally {
      this.aligning = false;
      this.driftSamples = [];
      this.lastCorrection = Date.now();
    }
  }

  /*
    where the last jump really landed (ms ahead of the room), once spotify's done correcting its report: at least
    ALIGN_CHECK, longer on a pc known to correct late, and never while it's still moving. timeline gets
    "ms since resume:off" at the start and at every correction. null = the room did something or the song changed
  */
  private async landing(
    spotAtNow: () => ((t: number) => number) | null,
    gen: number,
    track: string,
    timeline: string[],
  ) {
    const start = this.resumedAt;
    // every 5th check sits through the whole thing again, in case this pc's corrections got later
    const probe = this.reportFix < 0 || ++this.checks % 5 === 0;
    const window = probe ? VERIFY_MAX : Math.min(VERIFY_MAX, Math.max(ALIGN_CHECK, this.reportFix + 1000));
    const read = () => {
      const s = Spicetify.Platform.PlayerAPI._state;
      return { pos: Number(s?.positionAsOfTimestamp), ts: Number(s?.timestamp) };
    };
    const offNow = () => {
      const at = spotAtNow();
      return at ? this.progress() - at(Date.now()) : null;
    };
    const note = () => {
      const off = offNow();
      if (off !== null && timeline.length < 16) timeline.push(`${Date.now() - start}:${Math.round(off)}`);
    };
    let last = read();
    let movedAt = 0;
    note();
    for (;;) {
      await waitUntil(Date.now() + 40);
      if (gen !== this.scheduleGen || getCurrentTrackUri() !== track || isTrackPaused()) return null;
      this.positionSettled();
      const now = read();
      if (now.pos !== last.pos || now.ts !== last.ts) {
        // spotify also just reports again now and then without anything changing, that's not a correction
        if (Math.abs(now.pos - (last.pos + (now.ts - last.ts))) >= 3) {
          movedAt = Date.now();
          note();
        }
        last = now;
      }
      const since = Date.now() - start;
      if (since > VERIFY_MAX + 2000) break;
      if (since < window || Date.now() - movedAt < FIX_QUIET) continue;
      break;
    }
    // only learned in here, where nothing else is going on. anything else (queue changes, the end of a song)
    // makes spotify report again too and it learned garbage off that
    if (movedAt) this.learnReportFix(movedAt - start);
    // sat through a long one and nothing came, so this pc prob doesn't do it (anymore)
    else if (window >= 2000) this.learnNoReportFix();
    note();
    this.lateOpen = true;
    return offNow();
  }

  /** how a jump went, to the room owner's console. what made a friend's pc land 75 ms off couldn't be seen otherwise */
  private sendSyncDebug(label: string, off: number, timeline = '') {
    if (this.client.mode?.kind !== 'join') return;
    let info: any = {};
    Promise.resolve(Spicetify.Platform.PlaybackAPI?.getPlaybackInfo?.())
      .then((i: any) => (info = i || {}))
      .catch(() => {})
      .finally(() =>
        this.client.socket?.emit('syncDebug', {
          label,
          off: Math.round(off),
          resumeLag: Math.round(this.resumeLag),
          parkLag: Math.round(this.parkLag),
          reportFix: Math.round(this.reportFix),
          timeline,
          hidden: document.visibilityState === 'hidden',
          codec: String(info.codecName || ''),
          bitrate: Number(info.fileBitrate) || 0,
        }),
      );
  }

  /** the sync button. hosts line everyone up, anyone else just themselves */
  resync() {
    if (!this.liveRoom) return;
    // a host gets the room's resync back like everyone else, so no lining up twice
    if (this.isHost) this.client.socket?.emit('resyncAll');
    else if (this.client.mode?.kind === 'join') this.onResync();
  }

  /** the room asked us to line up again */
  onResync() {
    // nothing settled to line up to right this second (owner just changed songs), do it on the next one
    if (!this.realign('asked')) this.resyncWanted = true;
  }

  /**
   * hostTimestamp = when (host's clock) the host was at milliseconds. rooms send it, the node server doesn't,
   * and then milliseconds is just where an in sync listener is when this lands. settled = the owner's
   * position report is trustworthy right now (older rooms don't say, so that counts as yes)
   */
  onSyncPosition(trackUri: string, milliseconds: number, hostTimestamp?: number, settled?: boolean) {
    // in your own room your playback IS the reference, so you never get yanked around
    if (this.client.mode?.kind === 'host') return;
    if (Date.now() - this.lastReadingAt > SYNC_REPORT_STALE) this.reportSync(null);
    // a room sends timestamps. before the clocks are matched those can't be used yet, so wait, never fall
    // back to the server's guesswork
    const room = typeof hostTimestamp === 'number';
    const precise = room && this.client.socket?.hostTime?.() != null;
    if (room && !precise) return;
    if (precise) this.lastRef = { trackUri, ms: milliseconds, hostTs: hostTimestamp!, settled: settled !== false };
    if (!this.trackLoaded || this.delayedResume || this.realigning || this.aligning) return;
    if (getCurrentTrackUri() !== trackUri) return;
    if (!precise) return isTrackPaused() ? undefined : this.loosePosition(milliseconds);

    // the owner's report isn't trustworthy right now, nothing to compare against
    if (settled === false) return;
    // got on this song ourselves, or the sync button: line up on the first settled position, no waiting.
    // works from paused too, that's how someone who joined while paused on the song starts playing
    if (this.alignNext === trackUri || this.resyncWanted) {
      const why = this.resyncWanted ? 'asked' : 'new song';
      this.alignNext = null;
      this.resyncWanted = false;
      if (this.realign(why)) return;
    }
    if (isTrackPaused()) return;
    // our own report isn't trustworthy right now either (song just started, someone seeked)
    if (!this.positionSettled() || Date.now() < this.settleUntil) return;

    const hostNow = this.client.socket!.hostTime!()!;
    const target = milliseconds + (hostNow - hostTimestamp!) + this.syncOffset;
    if (target < 0 || target > Spicetify.Player.getDuration() - END_GUARD) return;

    const drift = this.progress() - target;
    this.driftSamples.push(drift);
    if (this.driftSamples.length > PRECISE.samples) this.driftSamples.shift();
    const sorted = [...this.driftSamples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.lastReadingAt = Date.now();
    // same median the corrections go by, so the panel shows what the sync actually sees
    if (this.driftSamples.length >= 3) this.reportSync(median);

    // 2 big ones in a row is a real jump (buffering, a skip), fixed right away. but never back to back, if
    // one didn't fix it a loop of them would just keep pausing
    const bigJump =
      this.driftSamples.length >= 2 &&
      this.driftSamples.slice(-2).every((d) => Math.abs(d) > BIG_DRIFT) &&
      Date.now() - this.lastCorrection > BIG_JUMP_COOLDOWN;
    if (!bigJump) {
      if (this.driftSamples.length < PRECISE.samples) return;
      if (Math.abs(median) < PRECISE.tolerance) return;
      const backoff = Math.min(MAX_ALIGN_BACKOFF, PRECISE.cooldown * 2 ** this.alignMisses);
      if (Date.now() - this.lastCorrection < backoff) return;
    }
    this.realign(`${Math.round(median)} ms off`);
  }

  /** the node server: no timestamps, so the old way with plain seeks and a learned lead */
  private loosePosition(milliseconds: number) {
    if (Date.now() < this.settleUntil) return;
    const target = milliseconds + this.syncOffset;
    if (target < 0 || target > Spicetify.Player.getDuration() - END_GUARD) return;
    const drift = this.progress() - target;
    this.driftSamples.push(drift);
    if (this.driftSamples.length > LOOSE.samples) this.driftSamples.shift();
    const sorted = [...this.driftSamples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (this.correcting && this.driftSamples.length >= 3) {
      // what's left after our last seek is how late spotify starts playing after one. half steps on a
      // median, single readings made it overshoot and bounce back and forth
      this.seekLead = Math.min(MAX_SEEK_LEAD, Math.max(0, this.seekLead - median / 2));
      this.correcting = false;
    }
    const bigJump =
      this.driftSamples.length >= 2 && this.driftSamples.slice(-2).every((d) => Math.abs(d) > BIG_DRIFT);
    if (!bigJump) {
      if (this.driftSamples.length < LOOSE.samples) return;
      if (Math.abs(median) < LOOSE.tolerance) return;
      if (Date.now() - this.lastCorrection < LOOSE.cooldown) return;
    }
    console.log(`[listenTogether] ${Math.round(median)}ms off (loose), seeking with ${Math.round(this.seekLead)}ms lead`);
    ogPlayerAPI.seekTo(target + this.seekLead);
    this.correcting = true;
    this.driftSamples = [];
    this.lastCorrection = Date.now();
    this.settleUntil = Date.now() + SETTLE_TIME;
  }

  /** tells the room how far off we are, for the panel. rooms only, the node server doesn't know this one */
  private reportSync(ms: number | null) {
    if (this.client.mode?.kind !== 'join') return;
    // new room, it hasn't heard anything from us yet
    if (this.sentSyncTo !== this.client.socket) {
      this.sentSyncTo = this.client.socket;
      this.sentSync = null;
      this.sentSyncAt = 0;
    }
    const value = ms === null ? null : Math.round(ms);
    if (value === null) {
      if (this.sentSync === null) return;
    } else if (this.sentSync !== null) {
      if (Date.now() - this.sentSyncAt < SYNC_REPORT_EVERY) return;
      if (Math.abs(value - this.sentSync) < SYNC_REPORT_STEP) return;
    }
    this.sentSync = value;
    this.sentSyncAt = Date.now();
    this.client.socket?.emit('syncStat', value);
  }

  setSyncOffset(offset: number) {
    const delta = offset - this.syncOffset;
    this.settingsManager.settings.syncOffset = offset;
    this.settingsManager.saveSettings();

    // move right away instead of waiting for the next sync, so you can hear the slider doing stuff
    if (
      delta === 0 ||
      !this.client.connected ||
      !this.trackLoaded ||
      isTrackPaused() ||
      !isListenableTrackType()
    )
      return;
    // a friend lines up with the room again, the offset is part of where it aims
    if (this.client.mode?.kind === 'join') {
      this.realign('offset');
      return;
    }
    // the owner just moves. a plain seek, the precise jump pauses and the room would take that as the
    // owner pausing everyone
    this.correcting = true;
    this.driftSamples = [];
    this.settleUntil = Date.now() + SETTLE_TIME;
    ogPlayerAPI.seekTo(Math.max(0, this.progress() + delta + this.seekLead));
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
        /*
          a friend who's a host only changes the room's song when they picked one. their spotify rolling into the
          next song on its own is just the song ending a hair before the owner's, and passing that on made the
          owner skip early and everyone jump, every single song
        */
        const picked = !this.liveRoom || this.ownsRoom || Date.now() - this.songPickedAt < PICKED_WINDOW;
        // the node server only reads the first arg, rooms also take the playlist/album it's playing from
        if (picked) this.client.socket?.emit('loadingSong', trackUri, 0, getShareableContext());

        this.spotifyUtils.onTrackLoaded(trackUri!, () => {
          this.trackLoaded = true;
          // rooms keep playing: rolled over on its own = still in line, started by the room = onChangeSong
          // already asked for a realign. the server makes everyone wait at 0 and start together
          if (!this.liveRoom) {
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
