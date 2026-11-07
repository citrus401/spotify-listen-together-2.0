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
