import { Command } from '../interfaces';
import LTPlayer from '../ltPlayer';
import { getTrackProgress } from '../utils/spotifyUtils';

export class PauseCommand implements Command {
  constructor(private ltPlayer: LTPlayer) {}

  async execute(ogPause: Function) {
    // rooms: don't do it here and now, the room schedules it so everyone does it at the same moment
    if (this.ltPlayer.liveRoom) {
      this.ltPlayer.requestUpdateSong(true, getTrackProgress());
      return;
    }
    await ogPause();
    this.ltPlayer.requestUpdateSong(true, Spicetify.Player.getProgress());
  }

  hasPermission() {
    return this.ltPlayer.isHost;
  }

  notifyRestriction() {
    Spicetify.showNotification('Only the hosts can pause songs!');
  }

  specialAction() {
    this.notifyRestriction();
  }
}
