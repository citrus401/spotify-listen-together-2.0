import LTPlayer from '../ltPlayer';
import { ogPlayerAPI } from './patcher';

export enum TrackType {
  Ad,
  Episode,
  Track,
  NoTrack,
  Unknown,
}

/** only the name gets used. returns { name } or { error } */
export async function getTrackData(trackUri: string) {
  const isEpisode = trackUri.split(':')[1] === 'episode';

  // the web api 429s the desktop token basically always now, spotify's own graphql doesn't
  try {
    const defs = Spicetify.GraphQL?.Definitions;
    const query = isEpisode ? defs?.getEpisodeName : defs?.getTrackName;
    if (query) {
      const res = await Spicetify.GraphQL.Request(query, { uri: trackUri });
      // trackUnion for tracks, some other union for episodes, both just have name
      const name = Object.values<any>(res?.data || {})[0]?.name;
      if (name) return { name };
    }
  } catch (error) {
    console.warn('[listenTogether] graphql name lookup failed', error);
  }

  // fallback. sp://auth/v2/token is gone, cosmos adds the token itself for web api urls now
  try {
    const id = isTrack(trackUri) ? trackUri.split(':')[2] : trackUri;
    const data = await Spicetify.CosmosAsync.get(
      `https://api.spotify.com/v1/${isEpisode ? 'episodes' : 'tracks'}/${id}`,
    );
    // cosmos hands back { code, error, message } instead of throwing, error is often ''
    if (data?.code) return { error: `${data.code} ${data.message || ''}`.trim() };
    return data;
  } catch (error) {
    return { error };
  }
}

export function getCurrentTrackUri(): string {
  // _state is undefined till the player sends its first update
  return Spicetify.Platform.PlayerAPI._state?.item?.uri || '';
}

/** what you queued yourself, in order. the playlist's upcoming songs are "context" and don't count */
export function getQueuedItems(): { uri: string; uid?: string }[] {
  const next: any[] = Spicetify.Platform.PlayerAPI._state?.nextItems || [];
  return next.filter((i) => i?.provider === 'queue' && typeof i.uri === 'string');
}

/** what plays next, in order: what you queued, then the playlist's upcoming songs (in your shuffle order) */
export function getUpcomingUris(count: number): string[] {
  const next: any[] = Spicetify.Platform.PlayerAPI._state?.nextItems || [];
  const seen = new Set([getCurrentTrackUri()]);
  const out: string[] = [];
  for (const i of next) {
    const uri = i?.uri;
    if (typeof uri !== 'string' || !(uri.startsWith('spotify:track:') || uri.startsWith('spotify:episode:'))) continue;
    // repeat fills this with the same songs over and over, one song on repeat went out as that song 10 times
    // and friends got all 10 in their queue. stops at the first one that's already been
    if (seen.has(uri)) break;
    seen.add(uri);
    out.push(uri);
    if (out.length >= count) break;
  }
  return out;
}

/** one song coming up, the way rooms pass it on. q = queued by hand, uid = its row in the playlist */
export type UpNext = { uri: string; uid?: string; q?: boolean };

/*
  everything coming up exactly as spotify has it: what you queued, then the playlist's next ones in your shuffle
  order (~80, spotify shows more as it goes). off spotify's queue code, _state only carries the first 50
*/
export function getUpNext(max: number): UpNext[] {
  const P = Spicetify.Platform.PlayerAPI;
  const raw: any[] = P._queue?._queue?.nextTracks ?? [];
  const items = raw.length
    ? raw.map((t) => ({ uri: t?.contextTrack?.uri, uid: t?.contextTrack?.uid, q: t?.provider === 'queue', blocked: !!t?.blocked?.length }))
    : (P._state?.nextItems ?? []).map((i: any) => ({ uri: i?.uri, uid: i?.uid, q: i?.provider === 'queue', blocked: false }));
  const s = P._state;
  const seen = new Set<string>([s?.item?.uid || s?.item?.uri || '']);
  const out: UpNext[] = [];
  for (const i of items) {
    if (typeof i.uri !== 'string' || !/^spotify:(track|episode):/.test(i.uri) || i.blocked) continue;
    // repeat lists the same rows over and over, one song on repeat went out as that song 10 times. stops where
    // it starts going round again. queued ones have no row, the same song queued twice is fine
    const key = i.q ? `q${out.length}` : i.uid || i.uri;
    if (seen.has(key)) break;
    seen.add(key);
    out.push(i.q ? { uri: i.uri, q: true } : typeof i.uid === 'string' && i.uid ? { uri: i.uri, uid: i.uid } : { uri: i.uri });
    if (out.length >= max) break;
  }
  return out;
}

export function isListenableTrackType(trackType?: TrackType) {
  if (trackType === undefined) trackType = getTrackType();

  return trackType === TrackType.Episode || trackType === TrackType.Track;
}

export function getTrackType(trackUri?: string): TrackType {
  if (trackUri === undefined) trackUri = getCurrentTrackUri();

  switch ((trackUri.split(':')[1] || '').toLowerCase()) {
    case '': {
      return TrackType.NoTrack;
    }
    case 'ad': {
      return TrackType.Ad;
    }
    case 'track': {
      return TrackType.Track;
    }
    case 'episode': {
      return TrackType.Episode;
    }
    default: {
      return TrackType.Unknown;
    }
  }
}

export function isTrack(trackUri: string): boolean {
  return (trackUri.match(/:/g) || []).length == 2;
}

export function pauseTrack() {
  if (Spicetify.Player.isPlaying()) ogPlayerAPI.pause();
}

export function resumeTrack() {
  if (!Spicetify.Player.isPlaying()) ogPlayerAPI.resume();
}

export function isTrackPaused() {
  return !Spicetify.Player.isPlaying();
}

/*
  same math spotify's own progress bar uses. spicetify's getProgress keeps counting while buffering,
  which reads as drift and made us seek for nothing
*/
export function getTrackProgress() {
  const s = Spicetify.Platform.PlayerAPI._state;
  if (!s || s.positionAsOfTimestamp == null || s.timestamp == null)
    return Spicetify.Player.getProgress();
  const pos = Number(s.positionAsOfTimestamp);
  if (s.isPaused || s.isBuffering) return pos;
  const now = pos + (Date.now() - Number(s.timestamp)) * (s.speed ?? 1);
  return s.duration ? Math.min(now, Number(s.duration)) : now;
}

/** the playlist/album/etc a song plays from. uid = which row, playlists can have the same song twice */
export type PlayContext = { uri: string; uid?: string };

// what a friend can open too. liked songs, your episodes, local files etc are per account so they're out
const SHAREABLE_CONTEXT = /^spotify:(playlist|album|artist|show):[A-Za-z0-9]+$/;

export function isShareableContext(ctx: any): ctx is PlayContext {
  return (
    !!ctx &&
    typeof ctx.uri === 'string' &&
    SHAREABLE_CONTEXT.test(ctx.uri) &&
    (ctx.uid === undefined || (typeof ctx.uid === 'string' && ctx.uid.length <= 64))
  );
}

export function getShareableContext(): PlayContext | undefined {
  const s = Spicetify.Platform.PlayerAPI._state;
  const uri = s?.context?.uri;
  if (!isShareableContext({ uri })) return undefined;
  // row uids are only stable across accounts for playlists, albums etc go by the song alone
  const uid = uri.startsWith('spotify:playlist:') ? s?.item?.uid : undefined;
  return typeof uid === 'string' && uid ? { uri, uid } : { uri };
}

/*
  plays the song inside its playlist/album when there is one, same call spotify's own ui makes. without it
  whoever didn't start the playlist was on the song alone like a single, so skip just restarted it
*/
export function forcePlayTrack(trackUri: string, context?: PlayContext): void {
  if (context && isShareableContext(context)) {
    forcePlay({ uri: context.uri }, {}, {
      skipTo: context.uid ? { uri: trackUri, uid: context.uid } : { uri: trackUri },
    });
    return;
  }
  forcePlay({ uri: trackUri }, {}, {});
}

export function forcePlay(uri: any, origins: any, options: any): void {
  Spicetify.Platform.PlayerAPI.play(uri, origins, {
    ...options,
    ltForced: true,
  });
}

export class SpotifyUtils {
  constructor(public ltPlayer: LTPlayer) {}

  loadedInterval: NodeJS.Timer | null = null;
  timeoutLoadedCallback: NodeJS.Timeout | null = null;

  onTrackLoaded(trackUri: string, callback: () => void) {
    if (this.loadedInterval) clearInterval(this.loadedInterval);
    if (this.timeoutLoadedCallback) clearTimeout(this.timeoutLoadedCallback);

    this.loadedInterval = setInterval(() => {
      console.log(
        `Check loaded: ${getCurrentTrackUri()}===${trackUri}   ${
          Spicetify.Platform.PlayerAPI._state?.item?.name
        }  ${!Spicetify.Platform.PlayerAPI._state?.isBuffering}`,
      );
      if (
        getCurrentTrackUri() === trackUri &&
        Spicetify.Platform.PlayerAPI._state?.item?.name &&
        !Spicetify.Platform.PlayerAPI._state?.isBuffering
      ) {
        if (this.loadedInterval) clearInterval(this.loadedInterval);
        if (this.timeoutLoadedCallback)
          clearTimeout(this.timeoutLoadedCallback);
        callback();
      }
    }, 100);

    this.timeoutLoadedCallback = setTimeout(() => {
      if (this.timeoutLoadedCallback) clearTimeout(this.timeoutLoadedCallback);
      if (this.loadedInterval) clearInterval(this.loadedInterval);
      callback();
    }, 5000);

    return this.loadedInterval;
  }
}
