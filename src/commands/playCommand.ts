import { Command } from '../interfaces';
import LTPlayer from '../ltPlayer';
import { isListenableTrackType, getTrackType } from '../utils/spotifyUtils';

export class PlayCommand implements Command {
  constructor(
    private ltPlayer: LTPlayer,
    private uri: Spicetify.ContextTrack,
    private context: any,
    private options: any,
  ) {}

  async execute(ogPlay: Function) {
    // our own forced plays are the room moving us, not you picking
    if (this.options?.ltForced !== true) this.ltPlayer.songPickedAt = Date.now();
    this.ltPlayer.muteBeforePlay();
    ogPlay(this.uri, this.context, this.options);
  }

  hasPermission() {
    return this.ltPlayer.isHost || this.options?.ltForced === true;
  }

  notifyRestriction() {
    Spicetify.showNotification(`Only ${this.ltPlayer.whoCanControl} can change songs!`);
  }

  specialAction() {
    this.notifyRestriction();
    if (this.options?.repeat === undefined) {
      if (typeof this.uri?.uri === 'string') {
        if (isListenableTrackType(getTrackType(this.uri.uri)))
          this.ltPlayer.requestSong(this.uri.uri);
        else if (
          typeof this.options?.skipTo?.uri === 'string' &&
          isListenableTrackType(getTrackType(this.options.skipTo.uri))
        )
          this.ltPlayer.requestSong(this.options.skipTo.uri);
      }
    }
  }
}
