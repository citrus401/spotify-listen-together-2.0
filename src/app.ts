async function main() {
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
