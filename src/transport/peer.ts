import { joinRoom, selfId } from 'trystero';
import RoomHost, { Reference } from '../room/roomHost';
import { EventHub, stripFunctions } from './transport';

/*
  peer to peer rooms. the host's spotify runs RoomHost, everyone else connects straight to it over webrtc.
  nostr relays only do the intro, after that nothing goes through anyone's server
*/

const APP_ID = 'spotify-listen-together';
// no 0/O/1/I/L so nobody misreads a code over voice chat
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PING_INTERVAL = 1000;
const FIND_HOST_TIMEOUT = 20000;
// clock matching, same idea as internet time sync. a few quick ones on join so it's usable fast
const CLOCK_BURST = 6;
const CLOCK_INTERVAL = 2000;
const CLOCK_SAMPLES = 20;

type Message = { e: string; a: any[] };

export function makeRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

/** people paste codes with spaces, dashes, lowercase, whatever */
export function cleanRoomCode(code: string) {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function openRoom(code: string, onJoinError?: (details: any) => void) {
  // code is the password too, so the relays only ever see encrypted handshakes
  const room = joinRoom({ appId: APP_ID, password: code }, code, { onJoinError });
  const [send, onMessage] = makeAction<Message>(room, 'lt');
  const [sendHi, onHi] = makeAction<{ host: true }>(room, 'hi');
  return { room, send, onMessage, sendHi, onHi };
}

// tiny wrapper so both sides read the same, trystero's action api changed shape between versions
function makeAction<T>(room: any, id: string) {
  const action = room.makeAction(id);
  const send = (data: T, peerId: string) => action.send(data, { target: peerId });
  const on = (cb: (data: T, peerId: string) => void) => {
    action.onMessage = (data: T, meta: { peerId: string }) => cb(data, meta.peerId);
  };
  return [send, on] as const;
}

/** the room owner's side. owns the RoomHost and also gives the owner's own client a transport */
export class PeerHost {
  readonly code: string;
  readonly self = new EventHub();
  private roomHost: RoomHost;
  private p2p: ReturnType<typeof openRoom>;
  private pingTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(version: string, code?: string, reference?: Reference) {
    this.code = code || makeRoomCode();
    this.p2p = openRoom(this.code, (details) =>
      console.warn("[listenTogether] a friend couldn't connect", details?.error),
    );

    this.roomHost = new RoomHost(
      {
        send: (memberId, event, ...args) => {
          if (memberId === selfId) {
            // async so the owner's handlers never run inside RoomHost.handle
            setTimeout(() => this.self.dispatch(event, ...args), 0);
          } else {
            this.p2p.send({ e: event, a: stripFunctions(args) }, memberId);
          }
        },
      },
      selfId,
      version,
      reference,
    );

    this.self.emit = (event, ...args) => {
      setTimeout(() => this.roomHost.handle(selfId, event, stripFunctions(args)), 0);
    };
    this.self.disconnect = () => this.close();
    this.self.hostTime = () => Date.now();

    this.p2p.room.onPeerJoin = (peerId: string) => {
      this.roomHost.addMember(peerId);
      this.p2p.sendHi({ host: true }, peerId);
      const ping = async () => {
        try {
          this.roomHost.setLatency(peerId, (await this.p2p.room.ping(peerId)) / 2);
        } catch {}
      };
      ping();
      this.pingTimers.set(peerId, setInterval(ping, PING_INTERVAL));
    };

    this.p2p.room.onPeerLeave = (peerId: string) => {
      clearInterval(this.pingTimers.get(peerId));
      this.pingTimers.delete(peerId);
      this.roomHost.memberLeft(peerId);
    };

    this.p2p.onMessage((msg, peerId) => {
      if (!msg || typeof msg.e !== 'string' || !Array.isArray(msg.a)) return;
      // answered right here instead of going through the room, every ms of delay is error
      if (msg.e === '__clk') {
        this.p2p.send({ e: '__clk', a: [msg.a[0], Date.now()] }, peerId);
        return;
      }
      this.roomHost.handle(peerId, msg.e, msg.a);
    });

    this.roomHost.addMember(selfId);
    setTimeout(() => this.self.dispatch('connect'), 0);
  }

  close() {
    this.pingTimers.forEach((t) => clearInterval(t));
    this.pingTimers.clear();
    this.roomHost.close();
    this.p2p.room.leave();
    this.self.dispatch('disconnect', 'io client disconnect');
  }
}

/** a friend's side. finds whoever says hi as the host and only listens to them */
export class PeerJoin extends EventHub {
  private p2p: ReturnType<typeof openRoom>;
  private hostId: string | null = null;
  private closed = false;
  private sawJoinError = false;
  private findTimer: ReturnType<typeof setTimeout>;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private clockSamples: { rtt: number; offset: number }[] = [];

  constructor(readonly code: string) {
    super();
    this.p2p = openRoom(code, (details) => {
      console.warn('[listenTogether] join error', details?.error);
      // can't tell yet if that was the host or another friend, so it just changes the timeout message
      this.sawJoinError = true;
    });

    this.p2p.onHi((data, peerId) => {
      if (!data?.host || this.hostId) return;
      this.hostId = peerId;
      clearTimeout(this.findTimer);
      this.startClock();
      this.dispatch('connect');
    });

    this.p2p.onMessage((msg, peerId) => {
      // other friends connect to us too (trystero meshes everyone), only the host gets to talk
      if (peerId !== this.hostId || !msg || typeof msg.e !== 'string') return;
      if (msg.e === '__clk') return this.onClock(msg.a);
      this.dispatch(msg.e, ...(Array.isArray(msg.a) ? msg.a : []));
    });

    this.p2p.room.onPeerLeave = (peerId: string) => {
      if (peerId === this.hostId) this.drop('host left');
    };

    this.findTimer = setTimeout(() => {
      if (this.hostId) return;
      this.fail(
        this.sawJoinError
          ? "Found the room but couldn't connect directly. Some networks block that, joining through a server works there instead."
          : `Couldn't find room ${code}. Check the code, and that the host still has it open.`,
      );
    }, FIND_HOST_TIMEOUT);
  }

  emit(event: string, ...args: any[]) {
    if (this.hostId) this.p2p.send({ e: event, a: stripFunctions(args) }, this.hostId);
  }

  /*
    the sample with the fastest round trip is the one where the network delay was most even both ways,
    so its offset is the most trustworthy. slow samples are mostly jitter
  */
  hostTime = () => {
    if (this.clockSamples.length < 3) return null;
    const best = this.clockSamples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    return Date.now() + best.offset;
  };

  private startClock() {
    const ping = () => {
      if (this.hostId && !this.closed)
        this.p2p.send({ e: '__clk', a: [Date.now()] }, this.hostId);
    };
    for (let i = 0; i < CLOCK_BURST; i++) setTimeout(ping, i * 150);
    this.clockTimer = setInterval(ping, CLOCK_INTERVAL);
  }

  private onClock(args: any) {
    const [sentAt, hostNow] = Array.isArray(args) ? args : [];
    if (typeof sentAt !== 'number' || typeof hostNow !== 'number') return;
    const rtt = Date.now() - sentAt;
    if (rtt < 0 || rtt > 5000) return;
    this.clockSamples.push({ rtt, offset: hostNow - (sentAt + rtt / 2) });
    if (this.clockSamples.length > CLOCK_SAMPLES) this.clockSamples.shift();
  }

  private stopClock() {
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = null;
  }

  disconnect() {
    this.drop('io client disconnect');
  }

  private fail(message: string) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.findTimer);
    this.stopClock();
    this.p2p.room.leave();
    this.dispatch('roomError', message);
  }

  private drop(reason: string) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.findTimer);
    this.stopClock();
    this.p2p.room.leave();
    this.dispatch('disconnect', reason);
  }
}
