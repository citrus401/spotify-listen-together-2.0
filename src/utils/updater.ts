import buildInfo from '../build.json';
import pJson from '../../package.json';
import SettingsManager from './settings';

/*
  updates off of pushes. github builds every push to main into the build branch (see .github/workflows),
  this checks that and loads the newest build when spotify starts. an extension can't rewrite its own
  file on disk, so the installed one just pulls the newer build in and steps aside.
  build.json is 0/dev locally, the workflow stamps the real number in
*/

export const REPO = 'citrus401/spotify-listen-together-2.0';
const RAW = `https://raw.githubusercontent.com/${REPO}/build`;
const CHECK_EVERY = 6 * 60 * 60 * 1000;
// a loaded build gets this long to say it's alive, otherwise we drop back to the installed one
const READY_TIMEOUT = 20000;

export type UpdateMode = 'ask' | 'auto' | 'off';
export type BuildInfo = { version: string; build: number; sha: string; date?: string };

export const INSTALLED_BUILD: number = buildInfo.build;

/** the build that's actually running, a loaded update or the installed file */
export function runningBuild(): number {
  return (window as any).__listenTogetherBuild || INSTALLED_BUILD;
}

/**
 * true = a newer build the user said yes to is now running instead, so this copy should do nothing.
 * false = run like normal (no update, it's off, offline, or the new build didn't start)
 */
export async function loadAcceptedBuild(settings: SettingsManager): Promise<boolean> {
  // we're the loaded one, don't go loading ourselves again
  if ((window as any).__listenTogetherBuild) return false;
  const s = settings.settings;
  const wanted = s.acceptedBuild;
  if (s.updateMode === 'off' || !(wanted > INSTALLED_BUILD)) return false;

  // our css, the update brings its own (app.ts does this too, for installs older than this code)
  const ourCss = document.getElementById('listenTogether');
  try {
    const res = await fetch(`${RAW}/builds/${wanted}.js`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const code = await res.text();
    if (code.length < 10000) throw new Error('that file is way too small to be the extension');

    ourCss?.remove();
    // inline script, the same thing marketplace does in here
    const script = document.createElement('script');
    script.textContent = `window.__listenTogetherBuild = ${Number(wanted)};\n${code}`;
    document.body.appendChild(script);
    if ((window as any).__listenTogetherBuild !== wanted)
      throw new Error("spotify wouldn't run it");
  } catch (e) {
    console.warn(`[listenTogether] couldn't load build ${wanted}, using the installed one`, e);
    // installed one keeps running, so it needs its look back
    if (ourCss && !document.getElementById('listenTogether')) document.head.appendChild(ourCss);
    return false;
  }

  // safety net: a broken build would leave people with no extension at all. if it never says it's ready,
  // forget it and reload once so the installed one starts clean (a half started build could have patched
  // stuff already). acceptedBuild = 0 means the reload doesn't try it again
  const started = Date.now();
  while (!(window as any).__listenTogetherReady) {
    if (Date.now() - started > READY_TIMEOUT) {
      console.warn(`[listenTogether] build ${wanted} never started, back to the installed one`);
      s.acceptedBuild = 0;
      settings.saveSettings();
      location.reload();
      return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return true;
}

export async function fetchLatest(): Promise<BuildInfo | null> {
  try {
    const res = await fetch(`${RAW}/version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const info = await res.json();
    if (typeof info?.build !== 'number' || typeof info?.version !== 'string') return null;
    return info;
  } catch {
    return null;
  }
}

export interface UpdateUI {
  bottomMessage(message: string): void;
  updatePopup(info: BuildInfo, running: number): void;
}

/** manual = from the menu, so it also says "up to date" / "couldn't check" instead of staying quiet */
export async function checkForUpdates(settings: SettingsManager, ui: UpdateUI, manual = false) {
  const s = settings.settings;
  if (s.updateMode === 'off' && !manual) return;

  const info = await fetchLatest();
  if (!info) {
    if (manual) ui.bottomMessage("Couldn't check for updates (offline, or the repo isn't public yet).");
    return;
  }
  const running = runningBuild();
  if (info.build <= running) {
    if (manual) ui.bottomMessage(`Listen Together is up to date (v${pJson.version}, build ${running}).`);
    return;
  }
  // already said yes to this one, it loads next start
  if (s.acceptedBuild >= info.build && !manual) return;

  if (s.updateMode === 'auto' && !manual) {
    s.acceptedBuild = info.build;
    settings.saveSettings();
    ui.bottomMessage(`Listen Together v${info.version} downloaded, it's used next time Spotify starts.`);
    return;
  }
  ui.updatePopup(info, running);
}

export function startUpdateChecks(settings: SettingsManager, ui: UpdateUI) {
  // give spotify a moment to finish starting before hitting the network
  setTimeout(() => checkForUpdates(settings, ui), 10000);
  setInterval(() => checkForUpdates(settings, ui), CHECK_EVERY);
}

/** say yes to a build and reload spotify's ui so it's running right away */
export function applyUpdate(settings: SettingsManager, build: number) {
  settings.settings.acceptedBuild = build;
  settings.saveSettings();
  location.reload();
}
