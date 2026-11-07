import { Command } from '../interfaces';
import LTPlayer from '../ltPlayer';

export class ResumeCommand implements Command {
  constructor(private ltPlayer: LTPlayer) {}

  async execute(ogResume: Function) {
    // rooms: don't do it here and now, the room schedules it so everyone does it at the same moment
    if (this.ltPlayer.liveRoom) {
      this.ltPlayer.requestUpdateSong(false, this.ltPlayer.progress());
      return;
    }
    await ogResume();
    this.ltPlayer.requestUpdateSong(false, Spicetify.Player.getProgress());
  }

  hasPermission() {
    return this.ltPlayer.isHost;
  }

  notifyRestriction() {
    Spicetify.showNotification('Only the hosts can resume songs!');
  }

  specialAction() {
    this.notifyRestriction();
  }
}
