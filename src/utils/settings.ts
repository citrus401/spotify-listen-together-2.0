interface StorageService {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

class Settings {
  settingsVersion: string;
  server: string;
  name: string;
  login: string;
  password: string;
  autoConnect: boolean;
  /** ms, + = play ahead of the room, - = behind. per person, never sent to the server */
  syncOffset: number;
  /** ask = just tells you, auto = grabs it and uses it next start, off = never checks */
  updateMode: 'ask' | 'auto' | 'off';
  /** newest build the user said yes to, loaded at startup if it's newer than the installed file */
  acceptedBuild: number;

  constructor({
    settingsVersion = '1',
    server = '',
    name = 'Anonymous',
    login = '',
    password = '',
    autoConnect = false,
    syncOffset = 0,
    updateMode = 'ask',
    acceptedBuild = 0,
  }: Partial<Settings> = {}) {
    this.settingsVersion = settingsVersion;
    this.server = server;
    this.name = name;
    this.login = login;
    this.password = password;
    this.autoConnect = autoConnect;
    this.syncOffset = Number.isFinite(syncOffset) ? syncOffset : 0;
    this.updateMode = ['ask', 'auto', 'off'].includes(updateMode) ? updateMode : 'ask';
    this.acceptedBuild = Number.isInteger(acceptedBuild) ? acceptedBuild : 0;
  }
}

export default class SettingsManager {
  settings: Settings;
  storageService: StorageService;

  constructor(storageService: StorageService) {
    this.storageService = storageService;

    const defaults = new Settings();
    const storedSettingsString = this.storageService.get('listenTogether');

    if (storedSettingsString !== null) {
      try {
        const storedSettings = JSON.parse(storedSettingsString);
        if (storedSettings.settingsVersion === defaults.settingsVersion) {
          this.settings = new Settings(storedSettings);
        } else {
          this.settings = defaults;
        }
      } catch (error) {
        console.error('Failed to parse stored settings:', error);
        this.settings = defaults;
      }
    } else {
      this.settings = defaults;
    }

    this.saveSettings();
  }

  saveSettings() {
    this.storageService.set('listenTogether', JSON.stringify(this.settings));
  }
}
