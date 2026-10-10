import { App, Modal, Notice, Setting } from "obsidian";
import { DEFAULT_DEVICE_FOLDER, describeDevicePassword, deviceUrl, normalizeDeviceFolder, webdavUrl,
  shareCredentialPaths } from "./devicePasswords";
import { GitService } from "./gitService";
import type { CreatedDevicePassword, CreatedShareCredential } from "./protocol";

/** Independent inventories. Secrets exist only in this open modal, never in plugin settings. */
export class DevicePasswordsModal extends Modal {
  private closed = false;
  private contextKey = "";
  private mountId?: string;
  private secrets: Array<{ value: string }> = [];

  constructor(app: App, private readonly gitService: GitService, private readonly serverUrl: string) {
    super(app);
    this.contextKey = gitService.credentialContextKey();
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Device passwords" });
    this.contentEl.createEl("p", { text: "Grants are independently revocable. Removing or disabling their creator does not " +
      "revoke them. Retired shares deny access. Ask the host operator to inventory or revoke grants if management is unavailable." });
    if (this.gitService.loginStatus().state !== "logged-in") {
      this.contentEl.createEl("p", { text: "Log in to ObsidiSync before managing device passwords." });
      return;
    }
    const legacy = this.contentEl.createDiv();
    const native = this.contentEl.createDiv();
    await this.renderLegacy(legacy);
    if (!this.closed && this.gitService.hasComposite()) {
      new Setting(this.contentEl).setName("Share-native grant destination").addDropdown((dropdown) => {
        dropdown.addOption("", "Choose a mount");
        for (const mount of this.gitService.compositeMounts()) dropdown.addOption(mount.mountId,
          `${mount.localPrefix}/ - ${mount.label} (${mount.shareId})`);
        dropdown.onChange(async (mountId) => {
          try { this.assertContext(); this.clearSecrets(); this.mountId = mountId || undefined; await this.renderShare(native); }
          catch (error) { native.setText(errorMessage(error)); }
        });
      });
      native.createEl("p", { text: "Choose a mount explicitly. Detaching it never revokes independent grants." });
    } else if (!this.closed) await this.renderShare(native);
  }

  onClose(): void {
    this.closed = true;
    this.clearSecrets();
    this.contentEl.empty();
  }

  private clearSecrets(): void { for (const secret of this.secrets) secret.value = ""; this.secrets = []; }

  private async renderLegacy(container: HTMLElement): Promise<void> {
    if (this.closed) return;
    container.empty();
    container.createEl("h3", { text: "Legacy DAV / Saber grants" });
    try {
      this.assertContext();
      const context = this.gitService.legacyCredentialContext();
      container.createEl("p", { text: `Original namespace: ${context.userSlug}/${context.vaultSlug}. ` +
        "Access is checked for this namespace independently of the selected share. Existing passwords and URLs are retained." });
      const unavailable = await this.gitService.devicePasswordsUnavailableReason();
      if (unavailable) throw new Error(unavailable);
      const inventory = await this.gitService.legacyCredentialInventory();
      if (this.closed) return;
      this.assertContext();
      container.createEl("p", { text: "Existing Saber clients keep their original Nextcloud login, encryption and PDF settings. " +
        "Saber provisioning uses the existing browser login in this original mapped namespace. Historical #tablet exports " +
        "may scan that entire original vault, beyond the DAV folder restriction, but cannot enter other shares." });
      if (!inventory.managementAllowed) container.createEl("p", { text: "Inventory is visible, but the server has not " +
        "authorized grant management. Create/revoke controls are unavailable; ask the host operator." });
      const created = container.createDiv();
      if (inventory.managementAllowed) this.creationForm(container, false, true, async (label, folder) => {
        const result = await this.gitService.createDevicePassword(label, folder);
        this.assertContext();
        if (!this.closed) this.renderCreated(created, result, context.serverUrl);
      });
      if (!inventory.entries.length) container.createEl("p", { text: "No legacy grants." });
      for (const entry of inventory.entries) {
        const row = new Setting(container).setName(entry.label).setDesc(describeDevicePassword(entry, context.serverUrl));
        this.copyButton(row, "Copy URL", deviceUrl(entry, context.serverUrl));
        if (inventory.managementAllowed) this.revokeButton(row, () => this.gitService.revokeDevicePassword(entry.id),
          () => this.renderLegacy(container));
      }
    } catch (error) {
      if (!this.closed) container.createEl("p", { text: `Legacy management unavailable: ${errorMessage(error)} ` +
        "Original context is retained. Namespace authorization or native compatibility cutoff may prevent management; " +
        "existing DAV/Saber grants can remain usable. Ask the host operator." });
    }
  }

  private async renderShare(container: HTMLElement): Promise<void> {
    if (this.closed) return;
    container.empty();
    container.createEl("h3", { text: "Share-native DAV grants" });
    try {
      this.assertContext();
      const mountId = this.mountId;
      if (this.gitService.hasComposite() && !mountId) { container.createEl("p", { text: "Choose a mount." }); return; }
      const key = this.gitService.credentialContextKey(mountId);
      const guard = () => {
        this.assertContext();
        if (this.mountId !== mountId || key !== this.gitService.credentialContextKey(mountId)) throw new Error("Grant mount changed; reopen this dialog");
      };
      const inventory = await this.gitService.shareCredentialInventory(mountId);
      if (this.closed) return;
      guard();
      const writable = inventory.capability === "read-write";
      container.createEl("p", { text: `Share ID / Basic and OCS username: ${inventory.shareId}. ` +
        "New grants are staged until explicit offline host-operator activation. Activation preserves the ID and secret. " +
        "These grants do not enable Saber scanning, rendering or pushing. A device bearer secret has the same grant scope; " +
        "it is not a native synchronization session." });
      if (!writable) container.createEl("p", { text: "Read-only membership can issue read grants. Revocation requires " +
        "write membership or the host operator." });
      const created = container.createDiv();
      this.creationForm(container, true, writable, async (label, folder, capability) => {
        guard();
        const result = await this.gitService.createShareCredential(label, folder, capability, mountId);
        guard();
        if (!this.closed) this.renderCreated(created, result, this.serverUrl);
      });
      if (!inventory.entries.length) container.createEl("p", { text: "No share-native grants." });
      for (const entry of inventory.entries) {
        const paths = shareCredentialPaths(entry.shareId, entry.folder);
        const row = new Setting(container).setName(entry.label)
          .setDesc(`${entry.id} | ${entry.lifecycle} | ${entry.capability} | folder ${entry.folder}`);
        this.copyButton(row, "Copy DAV URL", webdavUrl(this.serverUrl, paths.webdavPath));
        this.copyButton(row, "Copy Nextcloud URL", webdavUrl(this.serverUrl, paths.nextcloudPath));
        if (writable) this.revokeButton(row, async () => { guard(); await this.gitService.revokeShareCredential(entry.id, mountId); },
          async () => { guard(); await this.renderShare(container); });
      }
    } catch (error) {
      if (!this.closed) container.createEl("p", { text: `Share-native management unavailable: ${errorMessage(error)}` });
    }
  }

  private creationForm(container: HTMLElement, native: boolean, writable: boolean,
      create: (label: string, folder: string, capability: "read" | "read-write") => Promise<void>): void {
    let label = "";
    let folder = DEFAULT_DEVICE_FOLDER;
    const status = container.createEl("p", { text: "" });
    new Setting(container).setName("Device name").addText(text => text.onChange(value => { label = value.trim(); }));
    new Setting(container).setName("Folder").addText(text => text.setValue(folder).onChange(value => { folder = value; }));
    const capabilities: ("read" | "read-write")[] = native ? (writable ? ["read", "read-write"] : ["read"]) : ["read-write"];
    const buttons: { setDisabled(value: boolean): unknown }[] = [];
    for (const capability of capabilities) new Setting(container).addButton(button => {
      buttons.push(button);
      button.setButtonText(native ? `Create staged ${capability} grant` : "Create password").onClick(async () => {
        try {
          if (!label) throw new Error("Enter a device name");
          const normalized = normalizeDeviceFolder(folder);
          this.assertContext();
          buttons.forEach(item => item.setDisabled(true));
          await create(label, normalized, capability);
          status.setText("Created. Copy the one-time secret now, then reopen this modal to refresh inventory.");
        } catch (error) {
          status.setText(`Creation did not complete: ${errorMessage(error)}. If the response was lost, refresh inventory ` +
            "before issuing another grant; secrets cannot be recovered. No automatic creation retry is performed.");
        } finally {
          buttons.forEach(item => item.setDisabled(false));
        }
      });
    });
  }

  private renderCreated(container: HTMLElement, created: CreatedDevicePassword | CreatedShareCredential, serverUrl: string): void {
    container.empty();
    container.createEl("h3", { text: `Created grant ${created.id}` });
    container.createEl("p", { text: "The password is shown only once. Copy it before closing this modal." });
    if ("shareId" in created) {
      container.createEl("p", { text: "STAGED: ask the host operator to run credential share activate with this ID offline. " +
        "Do not reissue the secret to activate it. No automatic activation occurs." });
      this.renderCopyRow(container, "Nextcloud / OCS URL", webdavUrl(serverUrl, created.nextcloudPath));
    }
    this.renderCopyRow(container, "WebDAV URL", webdavUrl(serverUrl, created.webdavPath));
    this.renderCopyRow(container, "Username", created.username);
    this.renderCopyRow(container, "Password", created.password);
  }

  private renderCopyRow(container: HTMLElement, name: string, value: string): void {
    const secret = { value }; this.secrets.push(secret);
    this.copyButton(new Setting(container).setName(name).setDesc(value), "Copy", () => secret.value);
  }

  private copyButton(row: Setting, label: string, value: string | (() => string)): void {
    row.addButton(button => button.setButtonText(label).onClick(async () => {
      this.assertContext();
      await navigator.clipboard.writeText(typeof value === "function" ? value() : value);
      new Notice("Copied");
    }));
  }

  private revokeButton(row: Setting, revoke: () => Promise<void>, refresh: () => Promise<void>): void {
    row.addButton(button => button.setWarning().setButtonText("Revoke").onClick(async () => {
      button.setDisabled(true);
      try { this.assertContext(); await revoke(); if (!this.closed) await refresh(); }
      catch (error) { new Notice(`Revocation failed: ${errorMessage(error)}`); button.setDisabled(false); }
    }));
  }

  private assertContext(): void {
    if (this.closed || this.contextKey !== this.gitService.credentialContextKey()) {
      throw new Error("Account or credential destination changed. Close and reopen this modal.");
    }
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
