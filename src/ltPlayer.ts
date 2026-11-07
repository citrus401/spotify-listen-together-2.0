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
  UpNext,
} from './utils/spotifyUtils';

const AD_CHECK_INTERVAL = 2000;
/*
  spotify won't change speed on music (setSpeed says not_supported_by_content_type) and has no ducking on
  desktop, so every correction is a jump of some kind. a plain seek is 125-200 ms of silence and lands
  anywhere within ±40. pause, seek while paused, resume is ~35 ms and lands right on it (jumpTo).

  where the music really is came from recording two spotifys on one pc and finding the echo between them:
  - after our resume the song is at the seek spot from the moment we called resume. 10 jumps landed within
    the same 10 ms step every time
  - spotify's position report is NOT that. right after a resume it's off by up to ~180 ms, it "corrects"
    itself later, and the corrections were noise (20-50 ms the wrong way on average). the old version
    trusted those and kept jumping after its own tail
  - a song rolling into the next one on its own keeps the timeline exact (113 vs 116 ms before/after)
  - mid song nothing drifts, the same gap 3 minutes later
  so every spotify keeps its own timeline from its last jump (anchor) and the report only gets listened to
  when it's way off (a real stall or someone seeking). what's left is the codecs: a flac copy and an ogg
  copy of a song sit 0-40 ms apart depending on the song, nothing up here can see that
  precise = rooms. timestamped positions + matched clocks. loose = the node server, timing there is a guess
  at the network delay so it keeps the old slack. drift is judged on the median of the last few readings
*/
// tolerance = mid-song drift that gets fixed. on our own timelines both sides read ~0, anything past this
// is a real slip
const PRECISE = { tolerance: 20, samples: 5, cooldown: 15000 };
const LOOSE = { tolerance: 250, samples: 3, cooldown: 30000 };
/*
  without our own timeline the report is all there is, and it's only sort of true. after a song starts it was
  57-89 ms off till spotify corrected itself ~6 s in, after a seek ~128 ms off for ~130 ms. so a bare report
  only counts as settled once it's spotify fixing itself (a small jump on the same song) or old enough
*/
const SETTLE_REPORT = 7000;
const SELF_FIX_MAX = 250;
// realign plans the restart this far ahead, enough for the seek while paused to land first
const REALIGN_PLAN = 50;
// a resume spotify hasn't said is playing by now is a slow start (audio still loading), see jumpTo
const SLOW_START = 300;
// how long a jump stays parked before it resumes. the ones spotify started ~110 ms late had all resumed within
// ~120 ms of parking. 5 bad in ~57 room jumps before this, 0 in 30 after (by ear)
const MIN_PARKED = 200;
const BIG_JUMP_COOLDOWN = 5000;
// a report this far from our own timeline = something really happened (a stall, a seek that wasn't ours).
// spotify's own wobble after a resume went up to ~180 ms
const ANCHOR_BREAK = 400;
// buffering this soon after our resume or a song change is just the start, not a stall
const STALL_GRACE = 1500;
// and it has to keep saying buffering this long to count as one
const STALL_MIN = 300;
// rolled into the next song on its own = the old timeline was at most this far from its end when it changed
const ROLLOVER_SLACK = 1500;
// the owner lines its own timeline up once a picked song has played this long (and is past any crossfade)
const SELF_ANCHOR_AFTER = 1500;
const SELF_ANCHOR_COOLDOWN = 20000;
// after a jump, how long a friend watches its own report for the owner's console. debug only, nothing learns off it
const REPORT_WATCH = 3000;
// a room position older than this isn't lined up to. a minimized owner sends one a sec, up to ~0.8 s late
const REF_STALE = 4000;
/*
  now and then (5 in ~50 room jumps, measured by ear) spotify starts ~110 ms late after the resume. those were
  the only ones where its first "playing" report sat way further behind our timeline than this pc's usual
  (-265..-269 vs -50..-164). so a reading this much past the usual = go again, once. 100 tripped on a fine one
*/
const LATE_START = 120;
const LATE_START_COOLDOWN = 20000;
const TIMING_KEY = 'listenTogether:timing:';
/*
  a friend plays the owner's up next as a list of our own. a real playlist link gets fetched by spotify itself,
  in its own order, and setQueue can't move its songs around. a list it can't look up gets played exactly as
  given, and setQueue rewrites all of it (adds, removes, reorders) without a hiccup. tested on 1.3.8
*/
const UP_NEXT_URI = 'spotify:internal:listen-together';
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

/** the current song's real length. the player's duration is that minus any crossfade */
function songLength() {
  const item = Spicetify.Platform.PlayerAPI._state?.item;
  return Number(item?.duration?.milliseconds ?? item?.metadata?.duration) || 0;
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
  /** ms from a seek while paused to spotify saying it's parked there. learned, 10-200 depending on if it's minimized */
  private parkLag = savedTiming('parkLag', 40);
  private resumedAt = 0;
  /*
    our own timeline: at local time `at` the song was at `pos`. set by our jumps, carried into the next song
    when spotify rolls over on its own. dur = what the player plays of it (the length minus any crossfade),
    meta = the song's real length, since = when this timeline started
  */
  private anchor: { track: string; pos: number; at: number; dur: number; meta: number; since: number } | null = null;
  /** where a running jump is headed, so the owner's position doesn't blip (or read as paused) mid jump */
  private jumpPlan: ((t: number) => number) | null = null;
  private selfAnchorAt = 0;
  /** this pc's crossfade in ms, worked out at the last song that rolled over (its length minus what played) */
  private crossfade = 0;
  /** when spotify started saying it's buffering, 0 = it isn't */
  private bufferingSince = 0;
  /** the timeline our last jump made, till spotify's first real "playing" report after it got looked at */
  private startCheck: LTPlayer['anchor'] = null;
  /** how far that first report sat from our timeline on the last few jumps here. kept per pc, so the check
   * works from the first jump of a session too */
  private startDevs: number[] = (() => {
    try {
      const v = JSON.parse(localStorage.getItem(TIMING_KEY + 'startDevs') || '[]');
      return Array.isArray(v) ? v.filter((x) => Number.isFinite(x)).slice(-7) : [];
    } catch {
      return [];
    }
  })();
  private lateFixAt = 0;
  /** when you last picked a song yourself (play, next, previous), see onSongChanged */
  songPickedAt = 0;
  /** tries at copying the room's current queue, see mirrorQueue */
  private mirrorTries = 0;
  private mirroring = false;
  /** rooms: the owner's whole up next. null = an older owner that only sends uris (the old mirrorQueue then) */
  private roomUpNext: UpNext[] | null = null;
  private upNextKey = '';
  private upNextTries = 0;
  private upNextAt = 0;
  /** your shuffle from before a room's up next took over, put back when you leave */
  private shuffleBefore: boolean | null = null;
  /** the room moved on to our next song, we switch to it on the owner's next position (see onChangeSong) */
  private rollTo: string | null = null;
  /** the song a running jump puts us on, when it isn't the one we're on (upNextSeat) */
  private seatFor: string | null = null;
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
      if (!this.client.connected) return;
      this.positionSettled();
      this.checkAnchor();
      this.maybeSelfAnchor();
      this.mirrorUpNext();
    }, 40);
    // timers crawl when spotify's minimized, its own state updates don't. a song rolling over has to be seen
    try {
      Spicetify.Platform.PlayerAPI.getEvents?.().addListener('update', () => this.checkAnchor());
    } catch {}
    // learned off spotify's reports by older versions, all of it turned out to be noise
    for (const k of ['startLag', 'reportFix', 'biasSeen']) localStorage.removeItem(TIMING_KEY + k);
  }

  init() {
    this.patcher.patchAll();
    // a new room, nothing known about it yet. an old room's position got used for a realign once
    this.roomQueue = null;
    this.roomUpNext = null;
    this.upNextKey = '';
    this.upNextTries = 0;
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
    this.anchor = null;
    // left a room: the owner's songs we copied in don't belong in your queue anymore
    if (this.mirroredKey || this.onUpNextList()) {
      this.mirroredKey = '';
      Promise.resolve(ogPlayerAPI.clearQueue?.()).catch(() => {});
    }
    // the owner's list plays in its order with shuffle off, your own shuffle comes back with you
    if (this.shuffleBefore !== null) {
      const was = this.shuffleBefore;
      this.shuffleBefore = null;
      if (was) Promise.resolve(Spicetify.Player.setShuffle(true)).catch(() => {});
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

  /** rooms: whoever made it is the host, anyone they let on the controls is a co-host. the server just has hosts */
  get whoCanControl() {
    return this.liveRoom ? 'the host and co-hosts' : 'the hosts';
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
      // a forced start isn't a roll over, so the old timeline doesn't carry into it
      this.anchor = null;
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

    /*
      a co-host skipped. they play our copy of the owner's up next, which isn't the owner's playlist, so
      the song came without one and the owner played it on its own: playlist and queue gone, for everyone. one
      that's in the owner's up next (or the one just before) gets skipped to right there instead
    */
    if (this.client.mode?.kind === 'host' && getCurrentTrackUri() !== trackUri && this.skipInQueue(trackUri)) return;

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

    // only if we're really on it. this used to be left over from an older room, so after rejoining a friend
    // told the room "on it" while playing some other song, and then lined that song up to the room's time
    if (this.currentLoadingTrack === trackUri && getCurrentTrackUri() === trackUri) {
      if (this.trackLoaded)
        this.client.socket?.emit('changedSong', this.currentLoadingTrack);
      return;
    }

    /*
      on the owner's up next our list is theirs, so this is our next song too. but spotify plays a list it didn't
      fetch itself to the very end, no crossfade, while the owner's playlist crossfades. waiting for ours put
      friends 6 s behind every song and then they jumped. so it switches on the owner's next position instead,
      parked right on it (onSyncPosition). a hard cut instead of the fade, but in time
    */
    if (this.client.mode?.kind === 'join' && this.onUpNextList() && !isTrackPaused() && this.nextOnList() === trackUri) {
      if (Spicetify.Player.getDuration() - getTrackProgress() > 1500) {
        this.rollTo = trackUri;
        this.alignNext = trackUri;
        // the owner's position comes twice a sec. if nothing good does, the plain way
        this.transitionWait = setTimeout(() => {
          this.transitionWait = null;
          if (this.rollTo === trackUri) this.rollTo = null;
          if (this.roomTrackUri === trackUri && getCurrentTrackUri() !== trackUri && !this.aligning) play();
        }, 3000);
        return;
      }
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
    if (this.client.mode?.kind !== 'join' || this.mirroring || this.aligning || this.roomUpNext) return;
    // an empty list from the room means nothing's coming up there (one song on repeat), so ours goes empty too.
    // only an older room that never sends one gets the next song instead
    const want = this.roomQueue ?? (this.roomNext ? [this.roomNext] : []);
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

  /** skips to uri inside the queue we already have, next or the one just before. false = it isn't there */
  private skipInQueue(uri: string) {
    const P = Spicetify.Platform.PlayerAPI;
    const q = P._queue?._queue;
    if (!q) return false;
    const next = (q.nextTracks ?? []).find((t: any) => t?.contextTrack?.uri === uri && !t?.blocked?.length);
    const prev = (q.prevTracks ?? [])[(q.prevTracks ?? []).length - 1];
    let go: (() => any) | null = null;
    if (next) go = () => ogPlayerAPI.skipToNext({ uri, uid: next.contextTrack.uid });
    // spotify's own previous restarts the song when it's 3 s in, a friend's previous means the song before
    else if (prev?.contextTrack?.uri === uri && P._contextPlayer?.skipPrev)
      go = () => P._contextPlayer.skipPrev({ allowSeeking: false, loggingParams: {} });
    if (!go) return false;
    this.ownCommand++;
    Promise.resolve()
      .then(go)
      .catch((e: any) => console.warn("[listenTogether] couldn't skip in the queue", e))
      .finally(() => this.ownCommand--);
    return true;
  }

  /** the owner's whole up next, every time it changes */
  onUpNext(items: UpNext[]) {
    if (this.client.mode?.kind !== 'join' || !Array.isArray(items)) return;
    this.roomUpNext = items.filter((i) => i && typeof i.uri === 'string');
    this.mirrorUpNext();
  }

  private onUpNextList() {
    return Spicetify.Platform.PlayerAPI._state?.context?.uri === UP_NEXT_URI;
  }

  private nextOnList(): string {
    const next = (Spicetify.Platform.PlayerAPI._queue?._queue?.nextTracks ?? []).find((t: any) => !t?.blocked?.length);
    return next?.contextTrack?.uri || '';
  }

  /*
    keeps a friend's up next exactly the owner's: queued songs, the playlist part, the order, all of it. one
    setQueue with the whole list, the same call spotify's own queue edits make. only once we're on our own list
    (UP_NEXT_URI), that happens in the friend's next jump (upNextSeat)
  */
  private mirrorUpNext() {
    if (this.client.mode?.kind !== 'join' || !this.roomUpNext || this.mirroring || this.aligning || this.jumpPlan) return;
    const Q = Spicetify.Platform.PlayerAPI._queue;
    const current = getCurrentTrackUri();
    if (!Q?._queue || !this.onUpNextList() || this.roomTrackUri !== current) return;
    const want = this.roomUpNext;
    // mid song change the owner's list can still be the one from the song before
    if (want[0] && !want[0].q && want[0].uri === current) return;
    const have = (Q._queue.nextTracks ?? [])
      .filter((t: any) => !t?.blocked?.length)
      .map((t: any) => (t?.provider === 'queue' ? 'q:' : '') + t?.contextTrack?.uri);
    const wantKeys = want.map((i) => (i.q ? 'q:' : '') + i.uri);
    if (sameList(have, wantKeys)) {
      this.upNextTries = 0;
      return;
    }
    const key = wantKeys.join(' ');
    if (key !== this.upNextKey) {
      this.upNextKey = key;
      this.upNextTries = 0;
    }
    // a list that still doesn't match after 3 goes is left alone, never a loop
    const wait = this.upNextTries ? 2000 * 2 ** (this.upNextTries - 1) : 0;
    if (this.upNextTries >= 3 || Date.now() - this.upNextAt < wait) return;
    this.upNextTries++;
    this.upNextAt = Date.now();
    this.mirroring = true;
    const nextTracks = want.map((i) => ({
      contextTrack: { uri: i.uri, uid: i.q ? undefined : i.uid, metadata: { is_queued: String(!!i.q) } },
      provider: i.q ? 'queue' : 'context',
    }));
    Promise.resolve(
      Q._client.setQueue({
        nextTracks,
        prevTracks: Q._queue.prevTracks ?? [],
        // spotify's own edits pass it like this, as text it overflowed
        queueRevision: BigInt(Q._queue.queueRevision ?? 0),
      }),
    )
      .catch((e: any) => console.warn("[listenTogether] couldn't copy the owner's up next", e))
      .finally(() => (this.mirroring = false));
  }

  /*
    a friend that's in a room with the owner's up next but not on our own list yet: the songs to start it with,
    this song first. null = nothing to do. the owner's list catching up comes after, through mirrorUpNext
  */
  private upNextSeat(): { uri: string; uid?: string }[] | null {
    if (this.client.mode?.kind !== 'join' || !this.roomUpNext || !Spicetify.Platform.PlayerAPI._contextPlayer?.play) return null;
    // moving on to the next song of our list: it first, then whatever comes after it on our list. queued ones
    // can't go in a list like that, mirrorUpNext puts them back right after
    if (this.seatFor && this.seatFor !== getCurrentTrackUri()) {
      const list = (Spicetify.Platform.PlayerAPI._queue?._queue?.nextTracks ?? []).filter(
        (t: any) => !t?.blocked?.length && t?.provider !== 'queue',
      );
      const at = list.findIndex((t: any) => t?.contextTrack?.uri === this.seatFor);
      const rest = at >= 0 ? list.slice(at + 1) : [];
      return [{ uri: this.seatFor }, ...rest.map((t: any) => ({ uri: t.contextTrack.uri, uid: t.contextTrack.uid }))];
    }
    if (this.onUpNextList()) return null;
    const current = getCurrentTrackUri();
    if (!current || current !== this.roomTrackUri || !Spicetify.Platform.PlayerAPI._contextPlayer?.play) return null;
    // still the list from the song before = it starts with this one
    const want = this.roomUpNext[0] && !this.roomUpNext[0].q && this.roomUpNext[0].uri === current ? this.roomUpNext.slice(1) : this.roomUpNext;
    return [{ uri: current }, ...want.filter((i) => !i.q).map((i) => ({ uri: i.uri, uid: i.uid }))];
  }

  /** starts our own list paused on spot, so the jump that's running resumes it on the planned moment */
  private playUpNextSeat(tracks: { uri: string; uid?: string }[], spot: number) {
    const P = Spicetify.Platform.PlayerAPI;
    if (this.shuffleBefore === null) this.shuffleBefore = !!P._state?.shuffle;
    return P._contextPlayer.play({
      preparePlayRequest: {
        context: {
          uri: UP_NEXT_URI,
          pages: [{ tracks: tracks.map((t, n) => ({ uri: t.uri, uid: t.uid || `lt${n}`, metadata: {} })), metadata: {}, isLoading: false }],
          metadata: {},
          isLoading: false,
        },
        playOrigin: { featureIdentifier: 'listen_together' },
        options: {
          skipTo: { trackUri: tracks[0].uri, trackUid: 'lt0' },
          seekTo: { value: BigInt(Math.max(0, Math.round(spot))) },
          initiallyPaused: true,
          // the owner's order is the order, spotify shuffling it again would undo all of it
          playerOptionsOverride: { shufflingContext: { value: false } },
        },
      },
      loggingParams: {},
    });
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

    // a friend that isn't on the room's song yet (still loading it, or stuck on another) would line the wrong
    // song up to the room's time. it lines up once it gets there instead
    const join = this.client.mode?.kind === 'join';
    if (join && this.roomTrackUri && getCurrentTrackUri() !== this.roomTrackUri) {
      this.alignNext = this.roomTrackUri;
      return;
    }
    // already there (the owner's own echo, a resume that changes nothing): leave it alone
    if (!isTrackPaused() && Math.abs(this.progress() - spotAt(Date.now())) < PRECISE.tolerance) return;
    const first = () => Math.max(at, Date.now() + REALIGN_PLAN);
    const go = () => (join ? this.alignJump(() => spotAt, first(), 'room') : this.jumpTo(spotAt, first(), 'room'));
    // start a bit before the moment so the seek is parked by then and the start lands right on it. however long
    // parking's been taking here, minimized that's up to ~200 ms. waitUntil and not setTimeout, a minimized
    // spotify would run it up to a second late
    const lead = Math.max(200, Math.round(this.parkLag * 2 + 100));
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
      const ours = this.trustNextReport && !paused;
      if (ours) this.trustNextReport = false;
      this.report = { key, track, pos, ts, paused, since: Date.now(), settled: ours || selfFix };
    }
    if (!this.report.settled && Date.now() - this.report.since > SETTLE_REPORT) this.report.settled = true;
    if (this.jumpPlan || paused) return false;
    if (this.anchorNow() !== null) return true;
    // the owner lines itself up a sec into a song (maybeSelfAnchor). friends going by its bare report before
    // that would just have to line up all over again right after
    if (this.client.mode?.kind === 'host' && Date.now() - this.report.since < SETTLE_REPORT) return false;
    return this.report.settled;
  }

  /** where the song really is: our own timeline when there is one, spotify's report when there isn't */
  progress() {
    if (this.jumpPlan) return this.jumpPlan(Date.now());
    return this.anchorNow() ?? getTrackProgress();
  }

  /** a jump is running. the music's paused for a moment but nobody should take that as a pause */
  get jumping() {
    return this.jumpPlan !== null;
  }

  private anchorNow() {
    const a = this.anchor;
    if (!a || isTrackPaused() || a.track !== getCurrentTrackUri()) return null;
    return a.pos + (Date.now() - a.at);
  }

  /*
    keeps our own timeline honest. carries it into the next song when spotify rolls over on its own, drops it
    when the music really did something else (paused, a stall, a seek that wasn't ours, a picked song)
  */
  private checkAnchor() {
    const a = this.anchor;
    const s = Spicetify.Platform.PlayerAPI._state;
    if (!a || !s || this.jumpPlan) return;
    const now = Date.now();
    const track = s.item?.uri || '';
    if (track !== a.track) {
      this.anchor = null;
      // rolled over on its own: no gap, the new song starts right where the old one's playing part ended (its
      // length minus crossfade). a picked song or one the room forced is a fresh start and needs a jump
      // minimized spotify can miss the update where the length shrinks by the crossfade, the last one known fills in
      const playDur = a.meta > 0 && a.dur >= a.meta ? a.meta - this.crossfade : a.dur;
      const end = a.at + (playDur - a.pos);
      const rolled =
        !s.isPaused && playDur > 0 && now - this.songPickedAt > PICKED_WINDOW && now >= end - ROLLOVER_SLACK && now - end < 3000;
      if (!rolled || !isListenableTrackType(getTrackType(track))) return;
      const pos = Number(s.positionAsOfTimestamp) + (now - Number(s.timestamp));
      // spotify's report this early can be ~90 off. way more = it wasn't a clean roll over after all
      if (Math.abs(pos - (now - end)) > ANCHOR_BREAK) return;
      this.crossfade = Math.max(0, a.meta - playDur);
      this.anchor = { track, pos: 0, at: end, dur: Number(s.duration) || 0, meta: songLength(), since: now };
      return;
    }
    if (s.isPaused) return void (this.anchor = null);
    // shrinks by the crossfade once spotify knows what's next, has to be the latest one when the song ends
    if (Number(s.duration) > 0) a.dur = Number(s.duration);
    this.bufferingSince = s.isBuffering ? this.bufferingSince || now : 0;
    if (this.startCheck === a && !s.isBuffering && Number(s.timestamp) >= a.at - 5) this.checkStart(a, s);
    if (now - a.since < STALL_GRACE) return;
    const off = Number(s.positionAsOfTimestamp) + (now - Number(s.timestamp)) - (a.pos + (now - a.at));
    // a stall = buffering that sticks around. spotify flashes it for a moment at the end of a song when it moves
    // on to the next one, and dropping the timeline there cost a friend an extra jump every song
    const nearEnd = a.pos + (now - a.at) > a.dur - 3000;
    const stalled = this.bufferingSince > 0 && now - this.bufferingSince > STALL_MIN && !nearEnd;
    if (stalled || Math.abs(off) > ANCHOR_BREAK) {
      this.anchor = null;
      console.log(`[listenTogether] own timeline dropped, ${stalled ? 'spotify is buffering' : `its report is ${Math.round(off)} ms off it`}`);
    }
  }

  /** spotify's first real "playing" report after our jump. way further behind than usual = it started late, go again */
  private checkStart(a: NonNullable<LTPlayer['anchor']>, s: any) {
    this.startCheck = null;
    const now = Date.now();
    const dev = Number(s.positionAsOfTimestamp) + (now - Number(s.timestamp)) - (a.pos + (now - a.at));
    const usual = [...this.startDevs].sort((x, y) => x - y)[Math.floor(this.startDevs.length / 2)];
    this.startDevs = [...this.startDevs, Math.round(dev)].slice(-7);
    localStorage.setItem(TIMING_KEY + 'startDevs', JSON.stringify(this.startDevs));
    if (this.startDevs.length < 4 || dev > usual - LATE_START || now - this.lateFixAt < LATE_START_COOLDOWN) return;
    this.lateFixAt = now;
    console.log(`[listenTogether] started late (report ${Math.round(dev)} vs usual ${Math.round(usual)}), going again`);
    if (this.client.mode?.kind === 'join') {
      this.realign('late start');
      return;
    }
    // the owner goes again onto the same timeline, so whoever lined up to it is right once this lands
    if (this.aligning || this.jumpPlan) return;
    this.aligning = true;
    this.jumpTo((t) => a.pos + (t - a.at), now + REALIGN_PLAN, 'late start').finally(() => (this.aligning = false));
  }

  /*
    the owner's position is what everyone lines up to, so it has to be on a timeline too. a song that rolled
    over keeps it, a picked one doesn't, so the owner jumps once itself a sec in (~35 ms of quiet). only with
    friends in the room, and never inside a crossfade, pausing there cuts the old song's tail off
  */
  private maybeSelfAnchor() {
    if (this.client.mode?.kind !== 'host' || this.jumpPlan || this.aligning || !this.trackLoaded) return;
    if (isTrackPaused() || this.anchorNow() !== null || this.ui.store.listeners.length < 2) return;
    if (!isListenableTrackType() || Date.now() - this.selfAnchorAt < SELF_ANCHOR_COOLDOWN) return;
    const pos = getTrackProgress();
    if (pos < Math.max(SELF_ANCHOR_AFTER, this.crossfade + 500)) return;
    if (pos > Spicetify.Player.getDuration() - END_GUARD - 3000) return;
    this.selfAnchorAt = Date.now();
    const t0 = Date.now();
    this.aligning = true;
    this.jumpTo((t) => pos + (t - t0), t0 + REALIGN_PLAN, 'own timeline').finally(() => (this.aligning = false));
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
    this.jumpPlan = spotAt;
    // the old timeline's gone the moment we pause, even if this jump gives up halfway
    this.anchor = null;
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
      let onTime = false;
      let spot = 0;
      let calledAt = 0;
      let started = false;
      let slowStarts = 0;
      // how each try went, for the log when it ends up late
      const trace: string[] = [];
      for (let tries = 0; tries < 5 && !onTime; tries++) {
        // a friend not on the owner's up next yet gets onto it right here, parked on the spot like a seek would.
        // starting that list takes ~200 ms and spotify redraws its queue right after, a seek ~50. every miss
        // plans a bit further out
        const seat = this.upNextSeat();
        resumeAt = Math.max(resumeAt, Date.now() + (seat ? 450 : this.parkLag * 1.5 + 15 + MIN_PARKED) + tries * 60);
        spot = Math.round(spotAt(resumeAt));
        if (spot < 0 || spot > end) return false;
        const seekAt = Date.now();
        if (seat) await own(() => this.playUpNextSeat(seat, spot));
        else await own(() => ogPlayerAPI.seekTo(spot));
        parked = await waitFor(
          () =>
            !!state()?.isPaused &&
            Math.abs(Number(state().positionAsOfTimestamp) - spot) < 3 &&
            (!seat || state()?.item?.uri === seat[0].uri),
          600,
        );
        if (parked) {
          this.parkLag = this.parkLag * 0.7 + (Date.now() - seekAt) * 0.3;
          localStorage.setItem(TIMING_KEY + 'parkLag', String(Math.round(this.parkLag)));
        }
        trace.push(`${seat ? 'list' : 'seek'} ${Date.now() - seekAt}/${resumeAt - seekAt}ms${parked ? '' : ' never parked'}`);
        // parked too late for the planned moment, plan again
        if (!parked || Date.now() > resumeAt - 2) continue;
        await waitUntil(resumeAt);
        /*
          spotify sometimes hogs the page right when we should resume (redrawing its queue after the list
          switch held it 27-64 ms). resuming then = starting late, so plan a new moment instead. the music's
          paused anyway, that's a slightly longer pause and never a late start
        */
        const missed = Date.now() - resumeAt;
        if (missed > 2) {
          trace.push(`missed by ${missed}ms`);
          continue;
        }
        this.trustNextReport = true;
        calledAt = Date.now();
        this.resumedAt = calledAt;
        await own(() => ogPlayerAPI.resume());
        started = await waitFor(() => !state()?.isPaused && Number(state().timestamp) >= calledAt - 5, SLOW_START);
        /*
          a song spotify hasn't cached yet (a first listen) started ~500 ms after the resume, a cached one says it's
          playing within ~140. waiting that out = half a sec off, so pause again and give it a fresh moment, the
          audio's loaded by then
        */
        if (!started && slowStarts < 2 && tries < 4) {
          slowStarts++;
          trace.push('slow start');
          await own(() => ogPlayerAPI.pause());
          await waitFor(() => !!state()?.isPaused, 600);
          resumeAt = Date.now() + 300;
          continue;
        }
        onTime = true;
      }
      if (!onTime) {
        // out of tries, go now and go by what spotify says happened
        await waitUntil(resumeAt);
        this.trustNextReport = true;
        calledAt = Date.now();
        this.resumedAt = calledAt;
        await own(() => ogPlayerAPI.resume());
      }
      if (!started) started = await waitFor(() => !state()?.isPaused && Number(state().timestamp) >= calledAt - 5, 1500);
      // never leave someone sitting paused because a resume got lost somewhere
      if (!started && state()?.isPaused) {
        console.warn("[listenTogether] resume didn't take, trying again");
        await own(() => ogPlayerAPI.resume());
        started = await waitFor(() => !state()?.isPaused, 1500);
      }
      playing = started;
      if (started) {
        // see the resume's report first, so it's not taken for a correction
        this.positionSettled();
        // parked on the spot = the song's there from the moment resume got called. that's the truth from here
        // on, not whatever spotify reports (see the top). a seek that never landed gives no timeline
        // it only really started this long after the resume (still loading after all our tries): when spotify says
        if (parked && Date.now() - calledAt > SLOW_START + 100)
          calledAt = Number(state().timestamp) - Math.max(0, Number(state().positionAsOfTimestamp) - spot);
        if (parked) {
          this.anchor = { track: getCurrentTrackUri(), pos: spot, at: calledAt, dur: Number(state().duration) || 0, meta: songLength(), since: Date.now() };
          this.startCheck = this.anchor;
        }
        const late = calledAt - resumeAt;
        console.log(`[listenTogether] jumped (${why}) to ${spot}${parked ? '' : ", seek didn't land"}${late > 2 ? `, ${late} ms late (${trace.join(', ')})` : ''}`);
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
      this.jumpPlan = null;
    }
  }

  /** where the room is at local time t, off its last settled position. null = nothing good to go by */
  private roomSpotAt(anyTrack = false) {
    const ref = this.lastRef;
    if (!ref || !ref.settled || (!anyTrack && getCurrentTrackUri() !== ref.trackUri)) return null;
    // the owner's last word on a song the room's already moved on from. a friend once lined up to one of
    // those, 2 s past where the owner's song had crossfaded out
    if (this.roomTrackUri && ref.trackUri !== this.roomTrackUri) return null;
    const hostNow = this.client.socket?.hostTime?.();
    if (hostNow == null) return null;
    if (hostNow - ref.hostTs > REF_STALE) return null;
    // host clock minus ours, so a local moment maps onto the host's timeline
    const skew = hostNow - Date.now();
    return (t: number) => ref.ms + (t + skew - ref.hostTs) + this.syncOffset;
  }

  /** line up with the room right now. false = nothing good to line up to yet */
  private realign(why: string) {
    if (!this.liveRoom || this.client.mode?.kind !== 'join' || this.aligning || !this.roomSpotAt()) return false;
    this.alignJump(() => this.roomSpotAt(), Date.now() + REALIGN_PLAN, why);
    return true;
  }

  /*
    a friend lining up: one jump, and that's it. the old version checked every jump against spotify's report
    and went again when it looked off, but the report is the thing that's off, so it chased its own tail
    (2-3 jumps every time, landing 50-70 ms off by ear). anything the room does meanwhile bumps scheduleGen
  */
  private async alignJump(spotAtNow: () => ((t: number) => number) | null, firstAt: number, why: string) {
    if (this.aligning) return false;
    this.aligning = true;
    try {
      const spotAt = spotAtNow();
      if (!spotAt) return false;
      const ok = await this.jumpTo(spotAt, firstAt, why);
      if (ok && this.anchor) this.watchReports(why, this.anchor);
      // lined up with the room on this song already, a "new song" one on top would just be another jump
      if (ok && this.alignNext === getCurrentTrackUri()) this.alignNext = null;
      return ok;
    } finally {
      this.aligning = false;
      this.driftSamples = [];
      this.lastCorrection = Date.now();
    }
  }

  /*
    for the owner's console only: what this pc's spotify reports for a few secs after a jump, against our own
    timeline. "ms since the resume:ms the report's ahead" every time it changes. nothing's learned off it
  */
  private async watchReports(label: string, anchor: NonNullable<LTPlayer['anchor']>) {
    const timeline: string[] = [];
    let key = '';
    let off = 0;
    const end = anchor.at + REPORT_WATCH;
    while (Date.now() < end && this.anchor === anchor) {
      const s = Spicetify.Platform.PlayerAPI._state;
      const k = `${s?.timestamp}|${s?.positionAsOfTimestamp}`;
      if (k !== key && s && !s.isPaused) {
        key = k;
        off = Number(s.positionAsOfTimestamp) + (Date.now() - Number(s.timestamp)) - (anchor.pos + (Date.now() - anchor.at));
        if (timeline.length < 16) timeline.push(`${Date.now() - anchor.at}:${Math.round(off)}`);
      }
      // a plain timer, waitUntil keeps the event loop spinning and this is just for the console
      await new Promise((r) => setTimeout(r, 40));
    }
    this.sendSyncDebug(label, off, timeline.join(' '));
  }

  /** how a jump went, to the room owner's console. off = where spotify's report ended up vs our own timeline */
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
          parkLag: Math.round(this.parkLag),
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
    // the room moved on to our next song (see rollTo in onChangeSong): straight onto it, on the owner's spot
    if (this.rollTo === trackUri && getCurrentTrackUri() !== trackUri && precise && settled !== false) {
      this.rollTo = null;
      this.alignNext = null;
      this.seatFor = trackUri;
      this.alignJump(() => this.roomSpotAt(true), Date.now() + REALIGN_PLAN, 'next song').finally(() => (this.seatFor = null));
      return;
    }
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
    // no timeline of our own = going by spotify's report, and that can be 100+ ms off while it looks fine (a
    // friend's read ~0 while his music was 100 ahead). so line up once, the jump gives us one
    if (this.anchorNow() === null) {
      if (Date.now() < this.settleUntil || Date.now() - this.lastCorrection < BIG_JUMP_COOLDOWN) return;
      if (getTrackProgress() < this.crossfade + 500) return;
      this.realign('no timeline');
      return;
    }
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
      if (Date.now() - this.lastCorrection < PRECISE.cooldown) return;
    }
    // a different crossfade than the owner's lands a rolled over song a sec off. fixed once the fade's done,
    // pausing inside it cuts the old song's tail off
    if (getTrackProgress() < this.crossfade + 500) return;
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
    // the owner moves its own music. the room reads progress() - offset, so everyone else stays put. the room
    // also reads a running jump as still playing (jumping), so the short pause doesn't pause everyone
    if (this.aligning || this.jumpPlan) return;
    const p0 = this.progress() + delta;
    const t0 = Date.now();
    this.aligning = true;
    this.jumpTo((t) => p0 + (t - t0), t0 + REALIGN_PLAN, 'offset').finally(() => (this.aligning = false));
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
          a co-host only changes the room's song when they picked one. their spotify rolling into the
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
    this.currentLoadingTrack = '';
    this.trackLoaded = true;
    this.anchor = null;
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
