import React from 'react';
import ReactDOM from 'react-dom';
import LTPlayer from '../ltPlayer';
import BottomInfo from './bottomInfo';
import { Popup } from './popup';
import iconSvg from './ListenTogetherIcon';
import pJson from '../../package.json';
import { cleanRoomCode } from '../transport/peer';

import '../css/ui.scss';
export default class UI {
  bottomInfoContainer: Element | null = null;

  constructor(public ltPlayer: LTPlayer) {
    new Spicetify.Topbar.Button('Listen Together', iconSvg, () =>
      this.openMenu(),
    );

    let loop = setInterval(() => {
      let playingBar = document
        .getElementsByClassName('main-nowPlayingBar-nowPlayingBar')
        .item(0);
      if (playingBar) {
        clearInterval(loop);
        this.bottomInfoContainer = document.createElement('div');
        this.bottomInfoContainer.id = 'listenTogether-bottomInfo';
        // Add top margin of 10px to the bottom info container
        playingBar.appendChild(this.bottomInfoContainer);
        this.renderBottomInfo(<BottomInfo server="" />);
      }
    }, 100);
  }

  songRequestPopup(
    trackName: string,
    fromListener: string,
    permitted: () => void,
  ) {
    Popup.create(
      'Listen Together',
      (btn) => {
        if (btn === 'Play') permitted();
        Popup.close();
      },
      ['Play'],
      [<Popup.Text text={`${fromListener} wants to play "${trackName}".`} />],
    );
  }

  openMenu() {
    const client = this.ltPlayer.client;
    const code = client.roomCode;
    const common = [
      <Popup.Button
        key="offset"
        text={'Sync offset'}
        onClick={() => this.syncOffsetPopup()}
      />,
      <Popup.Button key="about" text={'About'} onClick={() => this.onClickAbout()} />,
    ];

    if (!client.connected && !client.connecting) {
      Popup.create('Listen Together', () => Popup.close(), [], [
        <Popup.Button key="host" text={'Host a room'} onClick={() => this.onClickHostRoom()} />,
        <Popup.Button key="join" text={'Join a room'} onClick={() => this.joinRoomPopup()} />,
        <Popup.Button
          key="server"
          text={'Join a server'}
          onClick={() => this.onClickJoinAServer()}
        />,
        ...common,
      ]);
      return;
    }

    Popup.create('Listen Together', () => Popup.close(), [], [
      <Popup.Button
        key="leave"
        text={code ? 'Leave the room' : 'Leave the server'}
        onClick={() => {
          client.disconnect(false);
          Popup.close();
        }}
      />,
      ...(code
        ? [
            <Popup.Button
              key="copy"
              text={`Copy room code (${code})`}
              onClick={() => this.copyRoomCode(code)}
            />,
          ]
        : []),
      // whoever made the room is always host, nothing to request or drop
      ...(client.mode?.kind !== 'host'
        ? [
            <Popup.Button
              key="hostctl"
              text={this.ltPlayer.isHost ? 'Stop hosting' : 'Request host'}
              onClick={() => this.onClickRequestHost()}
              disabled={!client.connected}
            />,
          ]
        : []),
      ...common,
    ]);
  }

  /** settings name if they picked one, otherwise their spotify display name. no typing needed to host */
  private async defaultName() {
    const saved = this.ltPlayer.settingsManager.settings.name;
    if (saved && saved !== 'Anonymous') return saved;
    try {
      const user = await (Spicetify.Platform as any).UserAPI.getUser();
      if (user?.displayName) return String(user.displayName);
    } catch {}
    return 'Anonymous';
  }

  private async onClickHostRoom() {
    const settings = this.ltPlayer.settingsManager;
    settings.settings.name = await this.defaultName();
    settings.saveSettings();
    const code = this.ltPlayer.client.hostRoom();
    this.roomCodePopup(code);
  }

  roomCodePopup(code: string) {
    Popup.create(
      'Listen Together',
      (btn) => {
        if (btn === 'Copy code') this.copyRoomCode(code);
        Popup.close();
      },
      ['Copy code', 'Done'],
      [
        <Popup.Text key="t" text="Your room is up. Send this code to your friends:" centered />,
        <Popup.Text key="c" text={code} centered big />,
        <Popup.Text
          key="n"
          text="They join straight to your Spotify, so keep it open while you listen."
          centered
        />,
      ],
    );
  }

  copyRoomCode(code: string) {
    // both missing from the spicetify typings, they exist at runtime though
    const clipboard = (Spicetify.Platform as any).ClipboardAPI;
    Promise.resolve(
      clipboard?.copy ? clipboard.copy(code) : navigator.clipboard.writeText(code),
    )
      .then(() => this.bottomMessage(`Room code ${code} copied.`))
      .catch(() => this.bottomMessage(`Couldn't copy, the code is ${code}.`));
  }

  private async joinRoomPopup() {
    let code = '';
    let name = await this.defaultName();
    Popup.create(
      'Listen Together',
      (btn) => {
        Popup.close();
        if (btn !== 'Join' || !cleanRoomCode(code)) return;
        this.ltPlayer.settingsManager.settings.name = name || 'Anonymous';
        this.ltPlayer.settingsManager.saveSettings();
        this.ltPlayer.client.joinRoom(code);
      },
      ['Join'],
      [
        <Popup.Textbox
          key="code"
          name="Room code"
          example="K7QX2M"
          onInput={(text) => (code = text)}
        />,
        <Popup.Textbox
          key="name"
          name="Your name"
          defaultValue={name}
          onInput={(text) => (name = text)}
        />,
      ],
    );
  }

  hostRequestPopup(name: string, allow: () => void) {
    Popup.create(
      'Listen Together',
      (btn) => {
        if (btn === 'Allow') allow();
        Popup.close();
      },
      ['Allow'],
      [<Popup.Text key="t" text={`${name} wants host controls (play, pause, skip, seek).`} />],
    );
  }

  windowMessage(message: string) {
    Popup.create(
      'Listen Together',
      () => Popup.close(),
      ['OK'],
      [<Popup.Text text={message} />],
    );
  }

  bottomMessage(message: string) {
    Spicetify.showNotification(message);
  }

  disconnectedPopup() {
    const mode = this.ltPlayer.client.mode;
    Popup.create(
      'Listen Together',
      (btn) => {
        if (btn === 'Reconnect') {
          this.ltPlayer.client.reconnect();
        }
        Popup.close();
      },
      ['Reconnect'],
      [
        <Popup.Text
          key="t"
          text={
            mode?.kind === 'join'
              ? 'Lost the room. The host might have closed it or their connection dropped.'
              : 'Disconnected from the server.'
          }
        />,
      ],
    );
  }

  quickConnect(address: string) {
    const client = this.ltPlayer.client;
    if (client.connected || client.connecting || !address) return;
    // listentogether/K7QX2M links join a room, anything that looks like an address is a server
    if (!/[.:/]/.test(address) && cleanRoomCode(address).length === 6) {
      client.joinRoom(address);
      return;
    }
    this.ltPlayer.settingsManager.settings.server = address;
    this.ltPlayer.settingsManager.saveSettings();
    if (!this.ltPlayer.settingsManager.settings.name) {
      this.onClickJoinAServer();
    } else {
      this.ltPlayer.client.connect();
    }
  }

  private onClickJoinAServer() {
    if (this.ltPlayer.client.connected || this.ltPlayer.client.connecting) {
      this.ltPlayer.client.disconnect();
    } else {
      this.joinServerPopup((btn, address, name, autoConnect) => {
        if (btn === 'Host a server') {
          // heroku killed the free tier in 2022, so this goes to the self host instructions instead
          window.location.href =
            'https://github.com/JanitorialMess/spotify-listen-together-server#readme';
        } else {
          Popup.close();
          if (!!address && !!name) {
            this.ltPlayer.settingsManager.settings.server = address;
            this.ltPlayer.settingsManager.settings.name = name;
            this.ltPlayer.settingsManager.settings.autoConnect = autoConnect;
            this.ltPlayer.settingsManager.saveSettings();
            this.ltPlayer.client.connect();
          }
        }
      });
    }
  }

  private onClickRequestHost() {
    if (this.ltPlayer.client.connected) {
      if (this.ltPlayer.isHost) {
        this.ltPlayer.client.socket?.emit('cancelHost');
        Popup.close();
      } else if (this.ltPlayer.client.mode?.kind === 'join') {
        // rooms have no password, the owner gets a popup instead
        this.ltPlayer.client.socket?.emit('requestHost');
        this.bottomMessage('Asked the host for controls.');
        Popup.close();
      } else {
        this.requestHostPopup((password) => {
          if (!!password) {
            this.ltPlayer.client.socket?.emit('requestHost', password);
            this.ltPlayer.settingsManager.settings.password = password;
            this.ltPlayer.settingsManager.saveSettings();
          }
          Popup.close();
        });
      }
    } else {
      this.windowMessage('Please connect to a server before requesting host.');
    }
  }

  private syncOffsetPopup() {
    Popup.create(
      'Listen Together',
      (btn) => {
        if (btn === 'Reset') this.ltPlayer.setSyncOffset(0);
        Popup.close();
      },
      ['Reset', 'Done'],
      [
        <Popup.Text text="Sync offset" />,
        <Popup.Text text="Hearing the song later than everyone else? Slide right. Earlier? Slide left. Only changes it for you." />,
        <Popup.Slider
          label="Offset"
          min={-1000}
          max={1000}
          step={10}
          unit=" ms"
          defaultValue={this.ltPlayer.syncOffset}
          onCommit={(value) => this.ltPlayer.setSyncOffset(value)}
        />,
      ],
    );
  }

  private onClickAbout() {
    Popup.create(
      'Listen Together',
      () => {
        Popup.close();
      },
      [],
      [
        <Popup.Text
          text={`Listen Together v${pJson.version} created by FlafyDev`}
          centered={false}
        />,
        <Popup.Button
          text={'Github'}
          onClick={() =>
            (window.location.href =
              'https://github.com/FlafyDev/spotify-listen-together')
          }
        />,
      ],
    );
  }

  private joinServerPopup(
    callback: (
      btn: string | null,
      address: string,
      name: string,
      autoConnect: boolean,
    ) => void,
  ) {
    let address = '';
    let name = '';
    let autoConnect = false;
    Popup.create(
      'Listen Together',
      (btn) => callback(btn, address, name, autoConnect),
      ['Join', 'Host a server'],
      [
        <Popup.Textbox
          name="Server address"
          example="https://www.server.com/"
          defaultValue={this.ltPlayer.settingsManager.settings.server}
          onInput={(text) => {
            address = text;
          }}
        />,
        <Popup.Textbox
          name="Your name"
          example="Joe"
          defaultValue={this.ltPlayer.settingsManager.settings.name}
          onInput={(text) => {
            name = text;
          }}
        />,
        <Popup.Checkbox
          label="Autoconnect"
          defaultChecked={this.ltPlayer.settingsManager.settings.autoConnect}
          onChange={(checked) => {
            autoConnect = checked;
          }}
        />,
      ],
    );
  }

  private requestHostPopup(callback: (password: string) => void) {
    let password = '';
    Popup.create(
      'Listen Together',
      () => callback(password),
      ['Request'],
      [
        <Popup.Text text="Request host" />,
        <Popup.Textbox
          name="Password"
          defaultValue={this.ltPlayer.settingsManager.settings.password}
          onInput={(text) => (password = text)}
        />,
      ],
    );
  }

  convertJSXToString(jsxElement: JSX.Element): string {
    const element = React.createElement(React.Fragment, null, jsxElement);
    const container = document.createElement('div');
    ReactDOM.render(element, container);
    const htmlString = container.innerHTML;
    ReactDOM.unmountComponentAtNode(container);
    return htmlString;
  }

  renderBottomInfo(bottomInfo: JSX.Element) {
    if (this.bottomInfoContainer) {
      const htmlString = this.convertJSXToString(bottomInfo);
      this.bottomInfoContainer.innerHTML = htmlString;
    }
  }
}
