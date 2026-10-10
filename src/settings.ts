import { App, Notice, PluginSettingTab, Setting, TextComponent } from "obsidian";
import ObsidiSyncPlugin from "./main";
import { devicePasswordsAvailabilityMessage } from "./devicePasswords";
import { ManifestEntry } from "./protocol";
import type { ClientIdentity, LegacyManagementContext, LegacySyncBinding, PendingShareSelection } from "./shareSelection";
import { syncDestinationBlocker } from "./shareSelection";
import type { ActiveShare } from "./shareReconciliation";
import type { CompositeState } from "./composite";
import type { BindingArchive, ConversionJournal } from "./localLifecycle";

export interface IosGitSyncSettings {
  settingsRevision?: number;
  conversion?: ConversionJournal;
  conversionGate?: string;
  conversionActivation?: { id: string; revision: number };
  disabledBinding?: { archiveId: string };
  bindingArchives?: { version: 1; entries: BindingArchive[] };
  composite?: CompositeState;
  authenticatedIdentity?: ClientIdentity;
  legacyManagementContext?: LegacyManagementContext;
  legacySyncBinding?: LegacySyncBinding;
  pendingShareSelection?: PendingShareSelection | null;
  activeShare?: ActiveShare | null;
  serverUrl: string;
  oidcIssuer: string;
  oidcClientId: string;
  oidcScope: string;
  oidcAudience: string;
  oidcAccessToken: string;
  oidcRefreshToken: string;
  oidcAccessTokenExpiresAt: string | null;
  lastLoginError: string | null;
  lastLoginAttemptAt: string | null;
  userSlug: string;
  vaultSlug: string;
  remoteUrl: string;
  branch: string;
  authorName: string;
  authorEmail: string;
  deviceName: string;
  initialSyncDone: boolean;
  syncOnStartup: boolean;
  syncIntervalMinutes: number;
  clientId: string;
  serverHead: string | null;
  lastSyncedAt: string | null;
  lastSyncAttemptAt: string | null;
  lastSyncCompletedAt: string | null;
  lastSyncError: string | null;
  lastSyncChangeCount: number;
  syncStatus: "idle" | "running" | "queued" | "error";
  serverVersion: string | null;
  serverApiVersion: number | null;
  serverFeatures: string[];
  lastServerCheckAt: string | null;
  localManifest: ManifestEntry[];
  historySnapshots: HistorySnapshotEntry[];
  historyVersions: HistoryVersionEntry[];
}

export interface HistorySnapshotEntry {
  snapshotPath: string;
  sourcePath: string;
  hash: string;
  ownership?: import("./gitService").HistoryOwnership;
}

export interface HistoryVersionEntry {
  sourcePath: string;
  hash: string;
  name?: string;
  squashedIntoHash?: string;
}

export const DEFAULT_SETTINGS: IosGitSyncSettings = {
  serverUrl: "",
  oidcIssuer: "",
  oidcClientId: "",
  oidcScope: "openid profile email",
  oidcAudience: "",
  oidcAccessToken: "",
  oidcRefreshToken: "",
  oidcAccessTokenExpiresAt: null,
  lastLoginError: null,
  lastLoginAttemptAt: null,
  userSlug: "",
  vaultSlug: "",
  remoteUrl: "",
  branch: "main",
  authorName: "Obsidian Mobile",
  authorEmail: "obsidian-mobile@example.invalid",
  deviceName: "",
  initialSyncDone: false,
  syncOnStartup: true,
  syncIntervalMinutes: 10,
  clientId: "",
  serverHead: null,
  lastSyncedAt: null,
  lastSyncAttemptAt: null,
  lastSyncCompletedAt: null,
  lastSyncError: null,
  lastSyncChangeCount: 0,
  syncStatus: "idle",
  serverVersion: null,
  serverApiVersion: null,
  serverFeatures: [],
  lastServerCheckAt: null,
  localManifest: [],
  historySnapshots: [],
  historyVersions: []
};

export class IosGitSyncSettingTab extends PluginSettingTab {
  plugin: ObsidiSyncPlugin;
  private serverRefreshRequest = 0;
  private loginStatusUnsubscribe: (() => void) | null = null;

  constructor(app: App, plugin: ObsidiSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    this.loginStatusUnsubscribe?.();
    this.loginStatusUnsubscribe = null;
    containerEl.empty();

    const serverUrlSetting = new Setting(containerEl)
      .setName(syncServerUrlName(this.plugin.settings))
      .setDesc("Your self-hosted server, for example https://sync.example.com.")
      .addText((text) =>
        text
          .setPlaceholder("https://sync.example.com")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );
    this.refreshServerVersionOnLoad(serverUrlSetting);

    const loginSetting = new Setting(containerEl)
      .setName("Login")
      .setDesc(loginDescription(this.plugin.settings))
      .addButton((button) =>
        button.setCta().setButtonText(this.plugin.settings.oidcAccessToken ? "Log in again" : "Log in").onClick(() => {
          this.plugin.openLoginModal();
        })
      );

    new Setting(containerEl)
      .setName("Vault name")
      .setDesc("Server vault name. Defaults to this Obsidian vault name.")
      .addText((text) =>
        text.setPlaceholder("personal").setValue(this.plugin.settings.vaultSlug).onChange(async (value) => {
          this.plugin.settings.vaultSlug = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Server share selection")
      .setDesc("Choose a share, then explicitly back up and download. V2 uploads remain disabled.")
      .addButton((button) => button.setButtonText("Choose share").onClick(() => this.plugin.openShareSelectionModal()));

    new Setting(containerEl).setName("Composite mounts")
      .setDesc("Independent share folders, histories and separately enabled writes. Fresh setup needs an empty vault; existing vaults require conversion. Device passwords explicitly select a mount and retain the separate original legacy inventory.")
      .addButton((button) => button.setButtonText("Manage mounts").onClick(() => this.plugin.openCompositeMountsModal()));
    new Setting(containerEl).setName("Conversion and detachment")
      .setDesc("Preview a journaled conversion, recover an interrupted conversion, or detach a binding while retaining files and unresolved evidence.")
      .addButton((button) => button.setButtonText("Conversion and recovery").onClick(() => this.plugin.openConversionModal()));

    if (this.plugin.settings.pendingShareSelection) {
      new Setting(containerEl).setName("Pending share")
        .setDesc(`${this.plugin.settings.pendingShareSelection.label}: reconciliation required; existing v1 state retained.`);
    }
    const active = this.plugin.settings.activeShare;
    if (active) {
      new Setting(containerEl).setName(`Selected share: ${active.status}`)
        .setDesc(`${active.label} (${active.shareId}), capability: ${active.capability}. ${active.download.reconciliation.length} local reconciliation barrier(s). Blocked edits require explicit reconciliation even after write permission returns. Review using Resolve conflicts.`);
    }

    new Setting(containerEl)
      .setName("Author name")
      .addText((text) =>
        text.setValue(this.plugin.settings.authorName).onChange(async (value) => {
          this.plugin.settings.authorName = value.trim() || DEFAULT_SETTINGS.authorName;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Author email")
      .addText((text) =>
        text.setValue(this.plugin.settings.authorEmail).onChange(async (value) => {
          this.plugin.settings.authorEmail = value.trim() || DEFAULT_SETTINGS.authorEmail;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Computer name")
      .setDesc("Shown as the source computer in sync history. Set a different name on each computer.")
      .addText((text) =>
        text.setPlaceholder("Keller MacBook").setValue(this.plugin.settings.deviceName).onChange(async (value) => {
          this.plugin.settings.deviceName = value.trim();
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Device access" });

    new Setting(containerEl)
      .setName("Device passwords (WebDAV)")
      .setDesc(
        devicePasswordsAvailabilityMessage(this.plugin.settings) ??
          "Manage retained legacy DAV/Saber grants separately from staged/active grants for the selected share. New share grants require offline activation."
      )
      .addButton((button) =>
        button.setButtonText("Manage").onClick(() => {
          this.plugin.openDevicePasswordsModal();
        })
      );

    containerEl.createEl("h3", { text: "Sync" });

    new Setting(containerEl)
      .setName("Sync status")
      .setDesc(syncStatusDescription(this.plugin.settings));

    if (this.plugin.settings.lastSyncError) {
      new Setting(containerEl)
        .setName("Last sync error")
        .setDesc(this.plugin.settings.lastSyncError);
    }

    new Setting(containerEl)
      .setName("Last successful sync")
      .setDesc(this.plugin.settings.lastSyncCompletedAt ? new Date(this.plugin.settings.lastSyncCompletedAt).toLocaleString() : "Never");

    new Setting(containerEl)
      .setName("Server")
      .setDesc(
        this.plugin.settings.serverVersion
          ? `Version ${this.plugin.settings.serverVersion}, API ${this.plugin.settings.serverApiVersion ?? "unknown"}`
          : "Not checked yet."
      )
      .addButton((button) =>
        button.setButtonText("Check").onClick(() => {
          this.plugin.checkConnection();
        })
      );

    new Setting(containerEl)
      .setName("Sync on startup")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
          this.plugin.settings.syncOnStartup = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Sync interval")
      .setDesc("Minutes. Set to 0 to disable scheduled sync.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.syncIntervalMinutes)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          this.plugin.settings.syncIntervalMinutes = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
          await this.plugin.saveSettings();
          this.plugin.resetSyncTimer();
        })
      );

    containerEl.createEl("h3", { text: "Advanced" });

    let accessTokenText: TextComponent | null = null;
    let refreshTokenText: TextComponent | null = null;

    new Setting(containerEl)
      .setName("Access token")
      .setDesc("Manual fallback for static-token development servers or recovery. After changing a token, use Server Check to verify its identity.")
      .addText((text) => {
        accessTokenText = text;
        text.inputEl.type = "password";
        text.setValue(this.plugin.settings.oidcAccessToken).onChange(async (value) => {
          if (value !== this.plugin.settings.oidcAccessToken) this.plugin.settings.authenticatedIdentity = undefined;
          this.plugin.settings.oidcAccessToken = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Refresh token")
      .setDesc("Stored after OIDC login when the provider returns one. Used to refresh expired access tokens.")
      .addText((text) => {
        refreshTokenText = text;
        text.inputEl.type = "password";
        text.setValue(this.plugin.settings.oidcRefreshToken).onChange(async (value) => {
          this.plugin.settings.oidcRefreshToken = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("User namespace")
      .setDesc("Normally set by login. Must match the authenticated server user.")
      .addText((text) =>
        text.setPlaceholder("alice").setValue(this.plugin.settings.userSlug).onChange(async (value) => {
          this.plugin.settings.userSlug = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Reset registration")
      .setDesc("Forget the last synced commit and manifest. Local files are not changed. The next sync asks again how to reconcile this vault with the server.")
      .addButton((button) =>
        button.setButtonText("Reset").onClick(async () => {
          const blocked = syncDestinationBlocker(this.plugin.settings);
          if (blocked) { new Notice(blocked); return; }
          this.plugin.settings.serverHead = null;
          this.plugin.settings.localManifest = [];
          this.plugin.settings.initialSyncDone = false;
          await this.plugin.saveSettings();
        })
      );

    this.loginStatusUnsubscribe = this.plugin.onLoginStatusChange(() => {
      loginSetting.setDesc(loginDescription(this.plugin.settings));
      accessTokenText?.setValue(this.plugin.settings.oidcAccessToken);
      refreshTokenText?.setValue(this.plugin.settings.oidcRefreshToken);
    });
  }

  hide(): void {
    this.loginStatusUnsubscribe?.();
    this.loginStatusUnsubscribe = null;
  }

  private refreshServerVersionOnLoad(setting: Setting): void {
    if (!this.plugin.settings.serverUrl || !this.plugin.settings.oidcAccessToken) return;

    const request = ++this.serverRefreshRequest;
    void this.plugin
      .refreshConnectionStatus()
      .then(() => {
        if (request !== this.serverRefreshRequest) return;
        setting.setName(syncServerUrlName(this.plugin.settings));
      })
      .catch(() => {
        if (request !== this.serverRefreshRequest) return;
        setting.setName(syncServerUrlName(this.plugin.settings));
      });
  }
}

function syncServerUrlName(settings: IosGitSyncSettings): string {
  return settings.serverVersion ? `Sync server URL - server ${settings.serverVersion}` : "Sync server URL";
}

function loginDescription(settings: IosGitSyncSettings): string {
  if (settings.lastLoginError) return `Login needs attention: ${settings.lastLoginError}`;
  return settings.oidcAccessToken
    ? `Logged in as ${settings.userSlug || "configured user"}.`
    : "Fetch login settings from the sync server and store the access token automatically.";
}

function syncStatusDescription(settings: IosGitSyncSettings): string {
  if (settings.syncStatus === "running") return "Sync is running.";
  if (settings.syncStatus === "queued") return "Another sync will run after the current one finishes.";
  if (settings.syncStatus === "error") return "Last sync failed.";
  return `Idle. Last attempt: ${settings.lastSyncAttemptAt ? new Date(settings.lastSyncAttemptAt).toLocaleString() : "Never"}.`;
}
