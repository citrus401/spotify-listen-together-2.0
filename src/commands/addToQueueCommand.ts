import { Command } from '../interfaces';
import LTPlayer from '../ltPlayer';

export class AddToQueueCommand implements Command {
  constructor(
    private ltPlayer: LTPlayer,
    private items: Spicetify.ContextTrack[],
  ) {}

  async execute(ogAddToQueue: Function) {
    // your own room: it's your queue, so it just happens and the room shares it from there
    if (this.ltPlayer.ownsRoom) return ogAddToQueue();
    this.ltPlayer.addToQueue(this.items);
  }

  hasPermission() {
    return this.ltPlayer.isHost;
  }

  notifyRestriction() {
    Spicetify.showNotification(`Only ${this.ltPlayer.whoCanControl} can update the queue!`);
  }

  specialAction() {
    this.notifyRestriction();
  }
}
