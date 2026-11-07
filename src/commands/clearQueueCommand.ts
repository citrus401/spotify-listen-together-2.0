import { Command } from '../interfaces';
import LTPlayer from '../ltPlayer';

export class ClearQueueCommand implements Command {
  constructor(private ltPlayer: LTPlayer) {}

  async execute(ogClearQueue: Function) {
    if (this.ltPlayer.ownsRoom) return ogClearQueue();
    this.ltPlayer.clearQueue();
  }

  hasPermission() {
    return this.ltPlayer.isHost;
  }

  notifyRestriction() {
    Spicetify.showNotification(`Only ${this.ltPlayer.whoCanControl} can clear the queue!`);
  }

  specialAction() {
    this.notifyRestriction();
  }
}
