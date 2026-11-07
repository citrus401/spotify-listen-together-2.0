import { LiteEvent } from './liteEvent';
import LTPlayer from '../ltPlayer';
import { isTrackPaused } from './spotifyUtils';

import {
  ClearQueueCommand,
  PauseCommand,
  PlayCommand,
  RemoveFromQueueCommand,
  ResumeCommand,
  SeekToCommand,
  SkipToNextCommand,
  SkipToPreviousCommand,
} from '../commands';
import { Command } from '../interfaces';
import { AddToQueueCommand } from '../commands/addToQueueCommand';

export let ogPlayerAPI: any;

const PATCHED_METHODS = [
  'play',
  'pause',
  'resume',
  'seekTo',
  'skipToNext',
  'skipToPrevious',
  'addToQueue',
  'removeFromQueue',
  'clearQueue',
];

// spotify reads defaultPrevented off whatever emitSync returns, so blocking has to hand back this
// instead of undefined or it throws
const BLOCKED_EVENT = { defaultPrevented: true };

export default class Patcher {
  private patched = false;
  private subscribed = false;
  private lastData: any = null;
  constructor(public ltPlayer: LTPlayer) {}

  private readonly onTrackChanged = new LiteEvent<string>();
  public get trackChanged() {
    return this.onTrackChanged.expose();
  }

  patchAll() {
    if (this.patched) return;
    console.log('Patching');
    this.setOGFunctions();
    this.subscribeToPlayerEvents();
    this.overridePlayerFunctions();
    this.patched = true;
  }

  unpatchAll() {
    if (!this.patched) return;
    console.log('Unpatching');
    this.restorePlayerFunctions();
    this.patched = false;
  }

  private setOGFunctions() {
    // only keep originals from the first patch, a reconnect would grab our own wrappers otherwise
    if (ogPlayerAPI) return;

    ogPlayerAPI = PATCHED_METHODS.reduce(
      (obj: { [key: string]: any }, method) => {
        const fn = Spicetify.Platform.PlayerAPI[method];
        // spotify renames stuff between versions, missing one shouldn't kill the whole extension
        if (typeof fn === 'function') {
          obj[method] = fn.bind(Spicetify.Platform.PlayerAPI);
        } else {
          console.warn(`[listenTogether] PlayerAPI.${method} is gone, skipping it`);
        }
        return obj;
      },
      {},
    );

    // Manual patching for nested functions
    const emitter = Spicetify.Platform.PlayerAPI._events?._emitter;
    if (typeof emitter?.emitSync === 'function') {
      ogPlayerAPI.emitSync = emitter.emitSync.bind(emitter);
    } else {
      console.warn('[listenTogether] player event emitter moved, the extra play/pause guard is off');
    }

    // bound to the real one. this used to be a wrapper that looked setVolume up live, then "restoring" it on
    // disconnect made setVolume call itself forever and volume died till restart
    const playback = Spicetify.Platform.PlaybackAPI;
    if (typeof playback?.setVolume === 'function') {
      ogPlayerAPI.setVolume = playback.setVolume.bind(playback);
    }
  }

  // called on load too, so listentogether/<server> links work before you ever connected
  subscribeToPlayerEvents() {
    // once per session, these stacked up on every reconnect before
    if (this.subscribed) return;
    this.subscribed = true;

    Spicetify.Player.addEventListener('songchange', (event) => {
      this.trackChangeHandler(event!.data);
    });
    Spicetify.Platform.History.listen(this.historyChangeHandler);
  }

  private trackChangeHandler = (data: any) => {
    if (!data || !this.patched) return;

    if (this.lastData?.item?.uri !== data?.item?.uri) {
      this.onTrackChanged.trigger(data?.item?.uri || '');
    }

    this.lastData = data;
  };

  private overridePlayerFunctions() {
    const handlers = {
      play: this.playHandler(ogPlayerAPI.play),
      pause: this.pauseHandler(ogPlayerAPI.pause),
      resume: this.resumeHandler(ogPlayerAPI.resume),
      skipToNext: this.skipToNextHandler(ogPlayerAPI.skipToNext),
      seekTo: this.seekToHandler(ogPlayerAPI.seekTo),
      skipToPrevious: this.skipToPreviousHandler(ogPlayerAPI.skipToPrevious),
      addToQueue: this.addToQueueHandler(ogPlayerAPI.addToQueue),
      removeFromQueue: this.removeFromQueueHandler(ogPlayerAPI.removeFromQueue),
      clearQueue: this.clearQueueHandler(ogPlayerAPI.clearQueue),
    };

    for (const [key, handler] of Object.entries(handlers)) {
      if (ogPlayerAPI[key]) Spicetify.Platform.PlayerAPI[key] = handler;
    }

    if (ogPlayerAPI.emitSync) {
      Spicetify.Platform.PlayerAPI._events._emitter.emitSync =
        this.emitSyncHandler;
    }
    // volume isn't patched. the old patch hit PlayerAPI which has no setVolume, so it never blocked anything anyway
  }

  private restorePlayerFunctions() {
    PATCHED_METHODS.forEach((method) => {
      if (ogPlayerAPI[method])
        Spicetify.Platform.PlayerAPI[method] = ogPlayerAPI[method];
    });

    if (ogPlayerAPI.emitSync) {
      Spicetify.Platform.PlayerAPI._events._emitter.emitSync =
        ogPlayerAPI.emitSync;
    }
  }

  private emitSyncHandler = (e: any, t: any) => {
    // our own sync commands go through. with spotify minimized its state can lag, and a realign's resume got
    // blocked as if it was a stray media key, leaving the friend paused
    if (this.ltPlayer.ownCommand > 0) return ogPlayerAPI.emitSync(e, t);
    if (this.ltPlayer.client.connected && !this.ltPlayer.isHost) {
      if (t?.action === 'play' && t?.options?.ltForced !== true)
        return BLOCKED_EVENT;
      if (t?.action === 'pause' && isTrackPaused()) return BLOCKED_EVENT;
      if (t?.action === 'resume' && !isTrackPaused()) return BLOCKED_EVENT;
    }
    return ogPlayerAPI.emitSync(e, t);
  };

  private playHandler = (ogPlay: any) => {
    return async (
      uri: Spicetify.ContextTrack,
      context: any,
      options?: any,
    ): Promise<void> => {
      const command = new PlayCommand(this.ltPlayer, uri, context, options);
      this.restrictAccess(() => ogPlay(uri, context, options), command);
    };
  };

  private pauseHandler = (ogPause: any) => {
    return async (): Promise<void> => {
      const command = new PauseCommand(this.ltPlayer);
      this.restrictAccess(ogPause, command);
    };
  };

  private resumeHandler = (ogResume: any) => {
    return async (): Promise<void> => {
      const command = new ResumeCommand(this.ltPlayer);
      this.restrictAccess(ogResume, command);
    };
  };

  private skipToNextHandler = (ogSkipToNext: any) => {
    return async (e: any): Promise<void> => {
      const command = new SkipToNextCommand(this.ltPlayer, e);
      this.restrictAccess(ogSkipToNext, command);
    };
  };

  private seekToHandler = (ogSkipTo: any) => {
    return async (ms: number): Promise<void> => {
      const command = new SeekToCommand(this.ltPlayer, ms);
      this.restrictAccess(ogSkipTo, command);
    };
  };

  private skipToPreviousHandler = (ogSkipToPrevious: any) => {
    return async (e: any): Promise<void> => {
      const command = new SkipToPreviousCommand(this.ltPlayer, e);
      this.restrictAccess(ogSkipToPrevious, command);
    };
  };

  // these pass their args along like play does. handing over the bare function queued nothing when it ran
  private addToQueueHandler = (ogAddToQueue: any) => {
    return async (items: Spicetify.ContextTrack[], ...rest: any[]): Promise<void> => {
      const command = new AddToQueueCommand(this.ltPlayer, items);
      this.restrictAccess(() => ogAddToQueue(items, ...rest), command);
    };
  };

  private removeFromQueueHandler = (ogRemoveFromQueue: any) => {
    return async (items: Spicetify.ContextTrack[], ...rest: any[]): Promise<void> => {
      const command = new RemoveFromQueueCommand(this.ltPlayer, items);
      this.restrictAccess(() => ogRemoveFromQueue(items, ...rest), command);
    };
  };

  private clearQueueHandler = (ogClearQueue: any) => {
    return async (...args: any[]): Promise<void> => {
      const command = new ClearQueueCommand(this.ltPlayer);
      this.restrictAccess(() => ogClearQueue(...args), command);
    };
  };


  private historyChangeHandler = ({ pathname }: { pathname?: string }) => {
    let pathParts = pathname?.split('/', 3).filter((i) => i);
    if (
      (pathParts?.length || 0) >= 2 &&
      pathParts![0].toLowerCase() == 'listentogether'
    ) {
      this.ltPlayer.ui.quickConnect(decodeURIComponent(pathParts![1]));
      Spicetify.Platform.History.goBack();
    }
  };

  private async restrictAccess(ogFunc: any, command: Command) {
    if (!this.ltPlayer.client.connected && !this.ltPlayer.client.connecting) {
      console.log('Not connected');
      ogFunc();
    } else if (command.hasPermission()) {
      console.log('Has permission');
      await command.execute(ogFunc);
    } else {
      console.log('No permission');
      command.specialAction();
    }
  }
}
