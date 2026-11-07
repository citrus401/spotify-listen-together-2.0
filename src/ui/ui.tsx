import React from 'react';
import ReactDOM from 'react-dom';
import LTPlayer from '../ltPlayer';
import iconSvg from './ListenTogetherIcon';
import pJson from '../../package.json';
import { cleanRoomCode } from '../transport/peer';
import { applyUpdate, BuildInfo, checkForUpdates, runningBuild } from '../utils/updater';
import { Panel, PanelApi, PanelState, RoomChip, stopClick, UpdateMode } from './panel';
import { Listener, Store } from './store';

import '../css/ui.scss';
import '../css/panel.scss';

type DialogButton = { label: string; kind?: 'primary' | 'secondary' | 'ghost'; onClick?: () => void };

export default class UI implements PanelApi {
  store = new Store();
  private chipEl: HTMLElement | null = null;

  constructor(public ltPlayer: LTPlayer) {
    new Spicetify.Topbar.Button('Listen Together', iconSvg, () => this.openPanel());
    this.mountChip();
  }

  /*
    the chip lives in the player bar's right side, left of lyrics/queue. spotify re-renders that bar
    sometimes and our node can get dropped, so this just puts it back
  */
  private mountChip() {
    const mount = () => {
      const extra = document.querySelector('.main-nowPlayingBar-extraControls');
      if (!extra) return;
      if (!this.chipEl) {
        this.chipEl = document.createElement('div');
        this.chipEl.id = 'listenTogether-chip';
        ReactDOM.render(<RoomChip api={this} />, this.chipEl);
      }
      if (this.chipEl.parentElement !== extra) extra.insertBefore(this.chipEl, extra.firstChild);
    };
    mount();
    setInterval(mount, 1000);
  }

  /* ---------- state for the chip and the panel ---------- */

  changed() {
    this.store.changed();
  }

  setListeners(listeners: Listener[] | null) {
    this.store.listeners = Array.isArray(listeners) ? listeners : [];
    this.changed();
  }

  state(): PanelState {
    const client = this.ltPlayer.client;
    const s = this.ltPlayer.settingsManager.settings;
    const mode = client.mode;
    return {
      status: client.connected ? 'connected' : client.connecting ? 'connecting' : 'idle',
      kind: mode?.kind ?? null,
      code: mode ? (mode.kind === 'server' ? mode.address : mode.code) : '',
      isHost: this.ltPlayer.isHost,
      selfId: client.selfId,
      name: s.name,
      offset: s.syncOffset,
      updateMode: s.updateMode,
      version: pJson.version,
      build: runningBuild(),
      serverAddress: s.server,
      autoConnect: s.autoConnect,
    };
  }

  /* ---------- panel actions ---------- */

  openPanel() {
    Spicetify.PopupModal.display({ title: 'Listen Together', content: (<Panel api={this} />) as any });
  }

  /** settings name if they picked one, otherwise their spotify display name. no typing needed to host */
  private async ensureName() {
    const settings = this.ltPlayer.settingsManager;
    const saved = settings.settings.name;
    if (saved && saved !== 'Anonymous') return;
    try {
      const user = await (Spicetify.Platform as any).UserAPI.getUser();
      if (user?.displayName) {
        settings.settings.name = String(user.displayName).slice(0, 40);
        settings.saveSettings();
      }
    } catch {}
  }

  async hostRoom() {
    await this.ensureName();
    this.ltPlayer.client.hostRoom();
    this.changed();
  }

  async joinRoom(code: string) {
    await this.ensureName();
    this.ltPlayer.client.joinRoom(code);
    this.changed();
  }

  async joinServer(address: string, autoConnect: boolean) {
    await this.ensureName();
    const settings = this.ltPlayer.settingsManager;
    settings.settings.server = address;
    settings.settings.autoConnect = autoConnect;
    settings.saveSettings();
    this.ltPlayer.client.connect(address);
    this.changed();
  }

  leave() {
    this.ltPlayer.client.disconnect(false);
    this.changed();
  }

  requestHost(password?: string) {
    const socket = this.ltPlayer.client.socket;
    if (password) {
      socket?.emit('requestHost', password);
      this.ltPlayer.settingsManager.settings.password = password;
      this.ltPlayer.settingsManager.saveSettings();
    } else {
      // rooms have no password, the owner gets asked instead
      socket?.emit('requestHost');
      this.bottomMessage('Asked the host for controls.');
    }
  }

  stopHosting() {
    this.ltPlayer.client.socket?.emit('cancelHost');
  }

  async copy(text: string) {
    // missing from the spicetify typings, exists at runtime though
    const clipboard = (Spicetify.Platform as any).ClipboardAPI;
    try {
      await (clipboard?.copy ? clipboard.copy(text) : navigator.clipboard.writeText(text));
      return true;
    } catch {
      this.bottomMessage(`Couldn't copy, it's ${text}`);
      return false;
    }
  }

  setName(name: string) {
    const settings = this.ltPlayer.settingsManager;
    settings.settings.name = name;
    settings.saveSettings();
    this.ltPlayer.client.sendProfile();
    this.changed();
  }

  setOffset(ms: number) {
    this.ltPlayer.setSyncOffset(ms);
    this.changed();
  }

  setUpdateMode(mode: UpdateMode) {
    this.ltPlayer.settingsManager.settings.updateMode = mode;
    this.ltPlayer.settingsManager.saveSettings();
    this.changed();
  }

  checkUpdates() {
    checkForUpdates(this.ltPlayer.settingsManager, this, true);
  }

  openUrl(url: string) {
    window.location.href = url;
  }

  /* ---------- small dialogs (requests, messages) in the same style ---------- */

  private dialog(text: string, buttons: DialogButton[]) {
    Spicetify.PopupModal.display({
      title: 'Listen Together',
      content: (
        <div className="lt-panel" onClick={stopClick}>
          <p>{text}</p>
          <div className="lt-actions">
            <span className="lt-actions__spacer" />
            {buttons.map((b) => (
              <button
                key={b.label}
                className={`lt-btn lt-btn--${b.kind || 'secondary'}`}
                onClick={() => {
                  Spicetify.PopupModal.hide();
                  b.onClick?.();
                }}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>
      ) as any,
    });
  }

  songRequestPopup(trackName: string, fromListener: string, permitted: () => void) {
    this.dialog(`${fromListener} wants to play "${trackName}".`, [
      { label: 'Not now', kind: 'ghost' },
      { label: 'Play it', kind: 'primary', onClick: permitted },
    ]);
  }

  hostRequestPopup(name: string, allow: () => void) {
    this.dialog(`${name} wants host controls (play, pause, skip, seek).`, [
      { label: 'Not now', kind: 'ghost' },
      { label: 'Allow', kind: 'primary', onClick: allow },
    ]);
  }

  updatePopup(info: BuildInfo, running: number) {
    const settings = this.ltPlayer.settingsManager;
    const inRoom = this.ltPlayer.client.connected;
    this.dialog(
      `Update available: v${info.version}, build ${info.build} (you're on build ${running || 'dev'}). ` +
        (inRoom
          ? "Updating reloads Spotify for a second, which drops you from the room. Rejoin after, same code."
          : 'Updating reloads Spotify for a second.'),
      [
        { label: 'Later', kind: 'ghost' },
        {
          label: 'Always auto-update',
          onClick: () => {
            settings.settings.updateMode = 'auto';
            applyUpdate(settings, info.build);
          },
        },
        { label: 'Update now', kind: 'primary', onClick: () => applyUpdate(settings, info.build) },
      ],
    );
  }

  windowMessage(message: string) {
    this.dialog(message, [{ label: 'OK', kind: 'primary' }]);
  }

  bottomMessage(message: string) {
    Spicetify.showNotification(message);
  }

  disconnectedPopup() {
    const mode = this.ltPlayer.client.mode;
    this.dialog(
      mode?.kind === 'join'
        ? 'Lost the room. The host might have closed it, or their connection dropped.'
        : 'Disconnected from the server.',
      [
        { label: 'Close', kind: 'ghost' },
        { label: 'Reconnect', kind: 'primary', onClick: () => this.ltPlayer.client.reconnect() },
      ],
    );
  }

  quickConnect(address: string) {
    const client = this.ltPlayer.client;
    if (client.connected || client.connecting || !address) return;
    // listentogether/K7QX2M links join a room, anything that looks like an address is a server
    if (!/[.:/]/.test(address) && cleanRoomCode(address).length === 6) {
      this.joinRoom(address);
      return;
    }
    this.ltPlayer.settingsManager.settings.server = address;
    this.ltPlayer.settingsManager.saveSettings();
    this.ltPlayer.client.connect();
  }
}
