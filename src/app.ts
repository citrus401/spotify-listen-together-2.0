async function main() {
  /*
    an update runs on top of the installed file, and that file already put its css in. spicetify-creator only
    adds css when there's no style with this id yet, so the update kept the installed version's look (build 6
    ran with build 5's css). this runs before that check does, so removing it here lets ours go in.
    has to stay above the first await
  */
  if ((window as any).__listenTogetherBuild) document.getElementById('listenTogether')?.remove();

  if (
    !Spicetify.CosmosAsync ||
    !Spicetify.Platform ||
    !Spicetify.LocalStorage ||
    !Spicetify.React
  ) {
    setTimeout(main, 1000);
    return;
  }

  // a newer build you said yes to runs instead of this file, see utils/updater
  const { default: SettingsManager } = await import('./utils/settings');
  const updater = await import('./utils/updater');
  if (await updater.loadAcceptedBuild(new SettingsManager(Spicetify.LocalStorage))) return;

  // Lazy import because we have to wait for the API to load
  const LTPlayer = await import('./ltPlayer');
  const ltPlayer = new LTPlayer.default();
  const settings = ltPlayer.settingsManager.settings;
  (window as any).__listenTogetherReady = true;
  // handy from devtools, and how the readme screenshots get made
  (window as any).__listenTogether = ltPlayer;
  updater.startUpdateChecks(ltPlayer.settingsManager, ltPlayer.ui);

  if (
    settings.autoConnect &&
    !ltPlayer.client.connected &&
    !ltPlayer.client.connecting
  ) {
    if (settings.server) {
      console.log(`Autoconnecting to ${settings.server}`);
      ltPlayer.client.connect();
    }
  }
}

export default main;
