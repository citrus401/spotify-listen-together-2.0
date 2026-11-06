import { io } from 'socket.io-client';
import LTPlayer from './ltPlayer';
import React from 'react';
import BottomInfo from './ui/bottomInfo';
import {
  forcePlayTrack,
  getTrackType,
  isListenableTrackType,
} from './utils/spotifyUtils';
import { Transport } from './transport/transport';
import { PeerHost, PeerJoin, cleanRoomCode } from './transport/peer';

/** server = the old node server, host = this spotify is the room, join = someone else's spotify is */
export type Mode =
  | { kind: 'server'; address: string }
  | { kind: 'host'; code: string }
  | { kind: 'join'; code: string };

export default class Client {
  connecting = false;
  connected = false;
  socket: Transport | null = null;
  mode: Mode | null = null;

  constructor(public ltPlayer: LTPlayer) {
    // free server hosts nap when idle, poking it keeps it awake. rooms don't need this
    setInterval(async () => {
      if (this.connected && this.mode?.kind === 'server') {
        try {
          await fetch(this.mode.address);
        } catch {}
      }
    }, 5 * 60_000);
  }

  get roomCode() {
    return this.mode && this.mode.kind !== 'server' ? this.mode.code : null;
  }

  private get label() {
    if (!this.mode) return '';
    if (this.mode.kind === 'server') return this.mode.address;
    if (this.mode.kind === 'host') return `your room ${this.mode.code}`;
    return `room ${this.mode.code}`;
  }

  connect(server?: string) {
    if (!server) server = this.ltPlayer.settingsManager.settings.server;
    // this used to clear the player with play(''). spotify 1.3 throws on that, reloads your last song
    // and autoplays the next one, so you'd sit in the room playing your own stuff. onLogin pausing is enough,
    // the server sends new listeners the room's song anyway
    const socket = io(server, {
      secure: true,
      reconnection: true,
      reconnectionAttempts: 10,
      timeout: 5000,
      randomizationFactor: 0.5,
    });
    this.start({ kind: 'server', address: server }, socket as unknown as Transport);
  }

  /** reuse a code when reconnecting so friends don't need a new one */
  hostRoom(code?: string) {
    const host = new PeerHost(this.ltPlayer.version, code);
    this.start({ kind: 'host', code: host.code }, host.self);
    return host.code;
  }

  joinRoom(code: string) {
    const clean = cleanRoomCode(code);
    this.start({ kind: 'join', code: clean }, new PeerJoin(clean));
  }

  reconnect() {
    const mode = this.mode;
    if (!mode) return this.connect();
    if (mode.kind === 'server') this.connect(mode.address);
    else if (mode.kind === 'host') this.hostRoom(mode.code);
    else this.joinRoom(mode.code);
  }

  private start(mode: Mode, transport: Transport) {
    this.mode = mode;
    this.socket = transport;
    this.connecting = true;
    this.connected = false;
    this.ltPlayer.ui.renderBottomInfo(<BottomInfo server={this.label} loading={true} />);

    // a transport we already dropped can still fire stuff (socket.io retries), ignore anything not current
    const on = (event: string, handler: (...args: any[]) => void) =>
      transport.on(event, (...args: any[]) => {
        if (this.socket === transport) handler(...args);
      });

    on('connect', () => {
      this.ltPlayer.ui.renderBottomInfo(<BottomInfo server={this.label} />);
      this.connecting = false;
      this.connected = true;
      this.ltPlayer.isHost = false;
      // the callback is socket.io's version check, rooms answer with versionMismatch instead
      transport.emit(
        'login',
        this.ltPlayer.settingsManager.settings.name,
        this.ltPlayer.version,
        (versionRequirements: string) => this.versionMismatch(versionRequirements),
      );

      // Initialize ltPlayer (patching, etc.)
      this.ltPlayer.init();
      this.ltPlayer.onLogin();

      // host passwords are a server thing, in a room the owner just gets asked
      const password = this.ltPlayer.settingsManager.settings.password;
      if (mode.kind === 'server' && password != '') {
        transport.emit('requestHost', password);
      }
    });

    transport.onAny((ev: string, ...args: any[]) => {
      if (this.socket !== transport) return;
      const formattedArgs = args.map((arg) => {
        if (typeof arg === 'object' && arg !== null) {
          return JSON.stringify(arg, null, 2);
        } else if (typeof arg === 'string') {
          return `"${arg}"`;
        } else if (typeof arg === 'function') {
          return arg.toString();
        } else {
          return String(arg);
        }
      });

      const argsString = formattedArgs.join(', ');
      console.log(`Receiving event "${ev}" with args: ${argsString}`);
    });

    on('changeSong', (trackUri: string) => {
      if (isListenableTrackType(getTrackType(trackUri)))
        this.ltPlayer.onChangeSong(trackUri);
    });

    on('updateSong', (pause: boolean, milliseconds: number) => {
      if (isListenableTrackType())
        this.ltPlayer.onUpdateSong(pause, milliseconds);
    });

    on('syncPosition', (trackUri: string, milliseconds: number) => {
      if (isListenableTrackType())
        this.ltPlayer.onSyncPosition(trackUri, milliseconds);
    });

    on('bottomMessage', (message: string) => {
      this.ltPlayer.ui.bottomMessage(message);
    });

    on('windowMessage', (message: string) => {
      this.ltPlayer.ui.windowMessage(message);
    });

    on('listeners', (clients: any) => {
      this.ltPlayer.ui.renderBottomInfo(
        <BottomInfo server={this.label} listeners={clients} />,
      );
    });

    on('isHost', (isHost: boolean) => {
      if (isHost != this.ltPlayer.isHost) {
        this.ltPlayer.isHost = isHost;
        if (isHost) {
          this.ltPlayer.ui.bottomMessage('You are now a host.');
        } else {
          this.ltPlayer.ui.bottomMessage('You are no longer a host.');
        }
      }
    });

    on('songRequested', (trackUri: string, trackName: string, fromListener: string) => {
      this.ltPlayer.ui.songRequestPopup(trackName, fromListener, () => {
        forcePlayTrack(trackUri);
      });
    });

    on('hostRequested', (name: string, memberId: string) => {
      this.ltPlayer.ui.hostRequestPopup(name, () => transport.emit('grantHost', memberId));
    });

    // Synchronize the queue on join
    on('queueUpdate', (queue: Spicetify.ContextTrack[]) => {
      console.dir(`Queue updated: ${queue || 'empty'}`, { depth: null });
      this.ltPlayer.onQueueUpdate(queue);
    });

    on('addToQueue', (items: Spicetify.ContextTrack[]) => {
      this.ltPlayer.onAddToQueue(items);
    });

    on('removeFromQueue', (items: Spicetify.ContextTrack[]) => {
      this.ltPlayer.onRemoveFromQueue(items);
    });

    on('clearQueue', () => {
      this.ltPlayer.onClearQueue();
    });

    on('versionMismatch', (version: string) => this.versionMismatch(`${version} (major.minor)`));

    on('roomError', (message: string) => {
      this.disconnect(false);
      this.ltPlayer.ui.windowMessage(message);
    });

    on('connect_error', () => {
      console.log('Connection error.');
    });

    on('disconnect', (reason: string) => {
      console.log(`Disconnected: ${reason}`);
      if (mode.kind === 'server' && reason === 'io server disconnect') {
        this.connect(mode.address);
      } else if (mode.kind !== 'server' || reason === 'io client disconnect') {
        // socket.io retries the rest itself, a room has nobody to retry to
        this.disconnect();
      }
    });

    on('error', () => {
      console.log('Error connecting to the server.');
      this.disconnect(false);
      this.ltPlayer.ui.windowMessage(`Couldn't connect to "${this.label}".`);
    });
  }

  private versionMismatch(requirements: string) {
    this.disconnect(false);
    setTimeout(
      () =>
        this.ltPlayer.ui.windowMessage(
          `Your Spotify Listen Together's version isn't compatible with this one. It needs: "${requirements}".`,
        ),
      1,
    );
  }

  /** popup = the "disconnected, reconnect?" one. off when you left on purpose or there's a better message */
  disconnect(popup = true) {
    const socket = this.socket;
    if (!socket) return;
    // nulled first so the disconnect event this triggers gets ignored instead of landing back here
    this.socket = null;
    this.connected = false;
    this.ltPlayer.isHost = false;
    this.connecting = false;
    socket.disconnect();
    this.ltPlayer.unload();
    this.ltPlayer.ui.renderBottomInfo(<BottomInfo server={''} />);
    if (popup) this.ltPlayer.ui.disconnectedPopup();
  }
}
