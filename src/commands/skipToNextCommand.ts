import { Command } from '../interfaces';
import LTPlayer from '../ltPlayer';

export class SkipToNextCommand implements Command {
  constructor(private ltPlayer: LTPlayer, private e: any) {}

  async execute(ogSkipToNext: Function) {
    this.ltPlayer.songPickedAt = Date.now();
    ogSkipToNext(this.e);
  }

  hasPermission() {
    return this.ltPlayer.isHost;
  }

  notifyRestriction() {
    Spicetify.showNotification(`Only ${this.ltPlayer.whoCanControl} can change songs!`);
  }

  specialAction() {
    this.notifyRestriction();
  }
}
