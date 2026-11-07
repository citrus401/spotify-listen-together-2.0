import React from 'react';
import { Icons } from './icons';
import { Listener, Store, useStore } from './store';

/*
  the whole listen together ui: the chip in the player bar and the panel it opens.
  no spicetify or ltPlayer in here, everything goes through PanelApi, so it can also be rendered with fake
  data (that's how the readme pictures get made)
*/

export type Status = 'idle' | 'connecting' | 'connected';
export type UpdateMode = 'ask' | 'auto' | 'off';

export interface PanelState {
  status: Status;
  kind: 'host' | 'join' | 'server' | null;
  /** room code, or the server address */
  code: string;
  isHost: boolean;
  selfId?: string;
  name: string;
  offset: number;
  updateMode: UpdateMode;
  version: string;
  build: number;
  serverAddress: string;
  autoConnect: boolean;
}

export interface PanelApi {
  store: Store;
  state(): PanelState;
  openPanel(): void;
  hostRoom(): void;
  joinRoom(code: string): void;
  joinServer(address: string, autoConnect: boolean): void;
  leave(): void;
  requestHost(password?: string): void;
  stopHosting(): void;
  copy(text: string): Promise<boolean>;
  setName(name: string): void;
  setOffset(ms: number): void;
  setUpdateMode(mode: UpdateMode): void;
  checkUpdates(): void;
  openUrl(url: string): void;
}

const REPO_URL = 'https://github.com/citrus401/spotify-listen-together-2.0';
const ORIGINAL_URL = 'https://github.com/FlafyDev/spotify-listen-together';
const KOFI_URL = 'https://ko-fi.com/citrus401';
const CODE_CHARS = /[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]/g;

/* ---------- small pieces ---------- */

// spotify's own playlist-cover colors, picked per name so the same person always gets the same one
const AVATAR_COLORS = ['#e8115b', '#1e3264', '#8d67ab', '#148a08', '#509bf5', '#ba5d07', '#27856a', '#e91429'];

function colorFor(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

export function Avatar({ name, src, size = 32 }: { name: string; src?: string; size?: number }) {
  const [broken, setBroken] = React.useState(false);
  const style = { width: size, height: size, minWidth: size };
  if (src && !broken)
    return <img className="lt-avatar" style={style} src={src} alt="" onError={() => setBroken(true)} />;
  return (
    <span
      className="lt-avatar lt-avatar--initial"
      style={{ ...style, background: colorFor(name), fontSize: Math.round(size * 0.44) }}
    >
      {(name.trim()[0] || '?').toUpperCase()}
    </span>
  );
}

function Badge({ tone = 'muted', children }: { tone?: 'green' | 'muted' | 'amber'; children: React.ReactNode }) {
  return <span className={`lt-badge lt-badge--${tone}`}>{children}</span>;
}

function Spinner() {
  return <span className="lt-spinner" aria-hidden="true" />;
}

function ViewHead({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="lt-viewhead">
      <button className="lt-iconbtn" onClick={onBack} aria-label="Back">
        <Icons.back />
      </button>
      <span>{title}</span>
    </div>
  );
}

function CopyButton({ text, api, label }: { text: string; api: PanelApi; label?: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      className={`lt-iconbtn ${copied ? 'lt-iconbtn--done' : ''}`}
      title={copied ? 'Copied' : label || 'Copy'}
      onClick={async () => {
        if (await api.copy(text)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      }}
    >
      {copied ? <Icons.check /> : <Icons.copy />}
    </button>
  );
}

/* ---------- the player bar chip ---------- */

export function RoomChip({ api }: { api: PanelApi }) {
  useStore(api.store);
  const st = api.state();
  const ref = React.useRef<HTMLButtonElement>(null);
  const labelRef = React.useRef<HTMLSpanElement>(null);
  const tip = st.status === 'connecting' ? 'Connecting' : st.kind === 'server' ? 'Server' : 'Room';
  useNativeTooltip(ref, st.status === 'idle' ? null : tip);
  useHiddenCodeWidth(ref, labelRef);
  if (st.status === 'idle') return null;

  const people = api.store.listeners;
  const label = st.status === 'connecting' ? 'Connecting' : st.kind === 'server' ? 'Server' : st.code;
  return (
    <button ref={ref} className={`lt-chip lt-chip--${st.status}`} onClick={() => api.openPanel()} aria-label={`Listen Together ${tip}`}>
      <span className="lt-dot" />
      {/* the code, slides out on hover */}
      <span ref={labelRef} className="lt-chip__label">
        {label}
      </span>
      {st.status === 'connected' && people.length > 0 && (
        <span className="lt-chip__people">
          <span className="lt-stack">
            {people.slice(0, 3).map((p, i) => (
              <Avatar key={p.id || `${p.name}${i}`} name={p.name} src={p.avatar} size={20} />
            ))}
          </span>
          <span className="lt-chip__count">{people.length}</span>
        </span>
      )}
    </button>
  );
}

/*
  the code is always laid out, the chip just clips it off at rest (see panel.scss). anything that changes
  layout in spotify's player bar costs a full restyle, so hovering only touches clip-path, transform and
  opacity. this tells the css how much to clip
*/
function useHiddenCodeWidth(ref: React.RefObject<HTMLElement>, labelRef: React.RefObject<HTMLElement>) {
  React.useLayoutEffect(() => {
    const chip = ref.current;
    const label = labelRef.current;
    // 0 = not in the page yet, nothing to measure
    if (!chip || !label || !label.offsetWidth) return;
    const hide = `${label.offsetWidth + 8}px`;
    if (chip.style.getPropertyValue('--lt-hide') === hide) return;
    // a new code is a new resting size, not a hover, so no sliding
    chip.classList.add('lt-chip--still');
    chip.style.setProperty('--lt-hide', hide);
    void getComputedStyle(chip).clipPath;
    chip.classList.remove('lt-chip--still');
  });
}

/*
  spotify's own tooltip (the dark bubble "Queue" gets), through the same Spicetify.Tippy spicetify's player
  bar buttons use. looked up off window so this file still renders outside spotify
*/
function useNativeTooltip(ref: React.RefObject<HTMLElement>, content: string | null) {
  const tippy = React.useRef<any>(null);
  React.useEffect(() => {
    const S = (window as any).Spicetify;
    // leaving a room unmounts the button, so the next one needs its own tippy
    if (tippy.current && tippy.current.reference !== ref.current) {
      tippy.current.destroy();
      tippy.current = null;
    }
    if (!ref.current || !content || !S?.Tippy) return;
    if (!tippy.current) tippy.current = S.Tippy(ref.current, { ...S.TippyProps, content });
    else tippy.current.setContent(content);
  });
  React.useEffect(
    () => () => {
      tippy.current?.destroy();
      tippy.current = null;
    },
    [],
  );
}

/* ---------- the panel ---------- */

type View = 'main' | 'settings' | 'server';

export function Panel({ api, view: initialView = 'main' }: { api: PanelApi; view?: View }) {
  useStore(api.store);
  const [view, setView] = React.useState<View>(initialView);
  const st = api.state();

  let body: React.ReactNode;
  if (view === 'settings') body = <SettingsView api={api} st={st} onBack={() => setView('main')} />;
  else if (view === 'server' && st.status === 'idle')
    body = <ServerView api={api} st={st} onBack={() => setView('main')} />;
  else if (st.status === 'connecting') body = <ConnectingView api={api} st={st} />;
  else if (st.status === 'connected')
    body = <RoomView api={api} st={st} onSettings={() => setView('settings')} />;
  else
    body = (
      <HomeView api={api} onServer={() => setView('server')} onSettings={() => setView('settings')} />
    );

  return (
    <div className="lt-panel" onClick={stopClick}>
      {body}
    </div>
  );
}

/*
  spicetify closes the popup on any click whose target isn't inside it. switching views swaps out the
  button you just clicked before the click gets there, so it looked like a click outside and the whole
  thing closed. clicks inside stop here
*/
export const stopClick = (e: React.MouseEvent) => e.stopPropagation();

function HomeView({ api, onServer, onSettings }: { api: PanelApi; onServer: () => void; onSettings: () => void }) {
  const [code, setCode] = React.useState('');
  const ready = code.length === 6;
  const join = () => ready && api.joinRoom(code);
  return (
    <>
      <p className="lt-lede">Listen to Spotify in sync with your friends.</p>

      <button className="lt-btn lt-btn--primary lt-btn--block lt-btn--lg" onClick={() => api.hostRoom()}>
        <Icons.broadcast size={18} />
        Host a room
      </button>

      <div className="lt-divider">
        <span>or join one</span>
      </div>

      <form
        className="lt-join"
        onSubmit={(e) => {
          e.preventDefault();
          join();
        }}
      >
        <input
          className="lt-input lt-input--code"
          placeholder="ROOM CODE"
          value={code}
          maxLength={6}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setCode(e.currentTarget.value.toUpperCase().replace(CODE_CHARS, '').slice(0, 6))}
        />
        <button className="lt-btn lt-btn--secondary" type="submit" disabled={!ready}>
          Join
        </button>
      </form>

      <div className="lt-footer">
        <button className="lt-link" onClick={onServer}>
          <Icons.server />
          Join a server
        </button>
        <button className="lt-link" onClick={onSettings}>
          <Icons.cog />
          Settings
        </button>
      </div>
    </>
  );
}

function ConnectingView({ api, st }: { api: PanelApi; st: PanelState }) {
  const what =
    st.kind === 'host' ? 'Starting your room' : st.kind === 'join' ? `Joining room ${st.code}` : 'Connecting to the server';
  return (
    <div className="lt-connecting">
      <Spinner />
      <p className="lt-connecting__title">{what}…</p>
      <p className="lt-muted">Finding each other can take a few seconds.</p>
      <button className="lt-btn lt-btn--ghost" onClick={() => api.leave()}>
        Cancel
      </button>
    </div>
  );
}

function sortPeople(people: Listener[]) {
  const rank = (p: Listener) => (p.owner ? 0 : p.isHost ? 1 : 2);
  return [...people].sort((a, b) => rank(a) - rank(b));
}

function RoomView({ api, st, onSettings }: { api: PanelApi; st: PanelState; onSettings: () => void }) {
  const [askingPassword, setAskingPassword] = React.useState(false);
  const [password, setPassword] = React.useState('');
  const people = sortPeople(api.store.listeners);
  const isServer = st.kind === 'server';
  const owner = st.kind === 'host';
  const ownerName = people.find((p) => p.owner)?.name;
  const isMe = (p: Listener) => (st.selfId && p.id ? p.id === st.selfId : p.name === st.name);

  return (
    <>
      <div className="lt-card">
        <div className="lt-card__top">
          <span className="lt-eyebrow">{isServer ? 'Server' : owner ? 'Your room' : 'Room'}</span>
          <span className="lt-live">
            <span className="lt-dot" />
            Live
          </span>
        </div>
        <div className="lt-card__code">
          {isServer ? (
            <span className="lt-code lt-code--server" title={st.code}>
              {st.code.replace(/^https?:\/\//, '')}
            </span>
          ) : (
            <span className="lt-code">{st.code}</span>
          )}
          <CopyButton text={st.code} api={api} label={isServer ? 'Copy address' : 'Copy code'} />
        </div>
        <p className="lt-muted lt-card__hint">
          {isServer
            ? 'Everyone joins this address with Join a server.'
            : owner
              ? 'Friends join with this code. Keep Spotify open while you listen.'
              : ownerName
                ? `Hosted by ${ownerName}.`
                : 'Connected.'}
        </p>
      </div>

      <div className="lt-section">
        <span>Listening</span>
        <span className="lt-section__count">{people.length}</span>
      </div>
      <ul className="lt-people">
        {people.map((p, i) => (
          <li key={p.id || `${p.name}${i}`} className="lt-person">
            <Avatar name={p.name} src={p.avatar} size={32} />
            <span className="lt-person__name">{p.name}</span>
            <span className="lt-person__badges">
              {p.watchingAD && <Badge tone="amber">On an ad</Badge>}
              {p.isHost && (
                <Badge tone="green">
                  <Icons.crown size={12} />
                  Host
                </Badge>
              )}
              {isMe(p) && <Badge>You</Badge>}
            </span>
          </li>
        ))}
      </ul>

      {askingPassword && (
        <form
          className="lt-join lt-join--tight"
          onSubmit={(e) => {
            e.preventDefault();
            if (!password) return;
            api.requestHost(password);
            setAskingPassword(false);
            setPassword('');
          }}
        >
          <input
            className="lt-input"
            type="password"
            placeholder="Server's host password"
            value={password}
            autoFocus
            onChange={(e) => setPassword(e.currentTarget.value)}
          />
          <button className="lt-btn lt-btn--secondary" type="submit" disabled={!password}>
            Request
          </button>
        </form>
      )}

      <div className="lt-actions lt-actions--room">
        <button className="lt-link" onClick={onSettings}>
          <Icons.cog />
          Settings
        </button>
        <span className="lt-actions__spacer" />
        {!owner && !st.isHost && !askingPassword && (
          <button
            className="lt-btn lt-btn--secondary"
            onClick={() => (isServer ? setAskingPassword(true) : api.requestHost())}
          >
            <Icons.crown />
            Request host
          </button>
        )}
        {!owner && st.isHost && (
          <button className="lt-btn lt-btn--secondary" onClick={() => api.stopHosting()}>
            Stop hosting
          </button>
        )}
        <button className="lt-btn lt-btn--danger" onClick={() => api.leave()}>
          <Icons.leave />
          {owner ? 'End room' : 'Leave'}
        </button>
      </div>
    </>
  );
}

function ServerView({ api, st, onBack }: { api: PanelApi; st: PanelState; onBack: () => void }) {
  const [address, setAddress] = React.useState(st.serverAddress);
  const [auto, setAuto] = React.useState(st.autoConnect);
  return (
    <>
      <ViewHead title="Join a server" onBack={onBack} />
      <p className="lt-muted">
        For networks where rooms can't connect directly. Everyone joins the same address.
      </p>
      <form
        className="lt-stack-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (address.trim()) api.joinServer(address.trim(), auto);
        }}
      >
        <label className="lt-label">
          Server address
          <input
            className="lt-input"
            placeholder="https://your-server.example"
            value={address}
            spellCheck={false}
            onChange={(e) => setAddress(e.currentTarget.value)}
          />
        </label>
        <label className="lt-toggle">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.currentTarget.checked)} />
          <span className="lt-toggle__track" />
          Connect automatically when Spotify starts
        </label>
        <div className="lt-actions">
          <button
            type="button"
            className="lt-link"
            onClick={() => api.openUrl(`${REPO_URL}#using-a-server-instead`)}
          >
            How to run one
          </button>
          <span className="lt-actions__spacer" />
          <button className="lt-btn lt-btn--primary" type="submit" disabled={!address.trim()}>
            Join
          </button>
        </div>
      </form>
    </>
  );
}

function SettingsView({ api, st, onBack }: { api: PanelApi; st: PanelState; onBack: () => void }) {
  const [name, setName] = React.useState(st.name);
  const [offset, setOffset] = React.useState(st.offset);
  const saveName = () => name.trim() && name.trim() !== st.name && api.setName(name.trim());
  const commitOffset = (v: number) => v !== st.offset && api.setOffset(v);
  const modes: [UpdateMode, string][] = [
    ['ask', 'Just tell me'],
    ['auto', 'Automatic'],
    ['off', 'Off'],
  ];

  return (
    <>
      <ViewHead title="Settings" onBack={onBack} />

      <div className="lt-setting">
        <label className="lt-label" htmlFor="lt-name">
          Your name
        </label>
        <input
          id="lt-name"
          className="lt-input"
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.currentTarget.value)}
          onBlur={saveName}
          onKeyDown={(e) => e.key === 'Enter' && saveName()}
        />
      </div>

      <div className="lt-setting">
        <div className="lt-setting__row">
          <span className="lt-label">Sync offset</span>
          <span className="lt-value">
            {offset > 0 ? '+' : ''}
            {offset} ms
          </span>
        </div>
        <input
          className="lt-range"
          type="range"
          min={-1000}
          max={1000}
          step={10}
          value={offset}
          style={{ ['--fill' as any]: `${((offset + 1000) / 2000) * 100}%` }}
          onChange={(e) => setOffset(Number(e.currentTarget.value))}
          onPointerUp={() => commitOffset(offset)}
          onKeyUp={() => commitOffset(offset)}
        />
        <div className="lt-setting__row">
          <span className="lt-muted lt-small">Hearing it late? Slide right. Early? Left. Only affects you.</span>
          {offset !== 0 && (
            <button
              className="lt-link lt-small"
              onClick={() => {
                setOffset(0);
                commitOffset(0);
              }}
            >
              Reset
            </button>
          )}
        </div>
      </div>

      <div className="lt-setting">
        <div className="lt-setting__row">
          <span className="lt-label">Updates</span>
          <button className="lt-link lt-small" onClick={() => api.checkUpdates()}>
            Check now
          </button>
        </div>
        <div className="lt-segmented" role="radiogroup">
          {modes.map(([m, label]) => (
            <button
              key={m}
              role="radio"
              aria-checked={st.updateMode === m}
              className={st.updateMode === m ? 'is-active' : ''}
              onClick={() => api.setUpdateMode(m)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="lt-about">
        <div className="lt-about__title">
          Listen Together <span className="lt-muted">v{st.version} · build {st.build || 'dev'}</span>
        </div>
        <p className="lt-muted lt-small">
          Made by citrus401. Based on Listen Together by FlafyDev, who made the original extension and server, and
          the fork by JanitorialMess.
        </p>
        <div className="lt-about__links">
          <button className="lt-link" onClick={() => api.openUrl(REPO_URL)}>
            <Icons.github />
            GitHub
          </button>
          <button className="lt-link" onClick={() => api.openUrl(ORIGINAL_URL)}>
            Original by FlafyDev
          </button>
          <button className="lt-link lt-link--accent" onClick={() => api.openUrl(KOFI_URL)}>
            <Icons.heart />
            Ko-fi
          </button>
        </div>
      </div>
    </>
  );
}
