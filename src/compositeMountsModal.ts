import { App, Modal, Setting } from "obsidian";
import type { GitService } from "./gitService";

/** Selection and initial replacement consent are separate actions, per mount. */
export class CompositeMountsModal extends Modal {
  private closed = false;
  constructor(app: App, private readonly service: GitService) { super(app); }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Composite mounts" });
    this.contentEl.createEl("p", { text: "Map server shares to separate local folders. Files outside those folders, vault configuration and recovery copies stay local-only. Composite uploads are disabled." });
    const message = this.contentEl.createEl("p");
    try {
      const mounts = this.service.compositeMounts();
      for (const mount of mounts) {
        new Setting(this.contentEl).setName(`${mount.localPrefix}/ - ${mount.label}`)
          .setDesc(`${mount.shareId}; ${mount.capability}; ${mount.initialized ? "download-only" : "initial reconciliation required"}. ${mount.download.reconciliation.length} local record(s), ${mount.barriers.length} move barrier(s). Last attempt: ${mount.lastAttemptAt ?? "never"}. Last completed: ${mount.download.lastDownloadedAt ?? "never"}. ${mount.lastError ?? ""}`)
          .addButton((button) => button.setButtonText(mount.initialized ? "Retry downloads" : "Back up and download")
            .onClick(async () => {
              if (!mount.initialized && !window.confirm(`Verify a fresh backup of ${mount.localPrefix}/ and reconcile it with ${mount.label} (${mount.shareId})? Only this folder is affected. Intervening edits are retained. Uploads remain disabled.`)) return;
              button.setDisabled(true);
              try { await this.service.initializeCompositeMount(mount.mountId); if (!this.closed) await this.onOpen(); }
              catch (error) { message.setText(errorText(error)); button.setDisabled(false); }
            }));
        for (const record of mount.download.reconciliation) this.contentEl.createEl("p", {
          text: `${mount.localPrefix}/${record.path}: ${record.reason}. Local contents retained; upload blocked.`
        });
        for (const barrier of mount.barriers) this.contentEl.createEl("p", {
          text: `${mount.localPrefix}/${barrier.path}: detected move requires explicit reconciliation; automatic application blocked.`
        });
      }
      if (!mounts.length) this.contentEl.createEl("p", {
        text: "Fresh setup requires a new empty vault without previous synchronization or recovery state. Existing vaults require explicit conversion. Selection alone does not download files."
      });
      let prefix = mounts.length ? "Harmony" : "Personal";
      new Setting(this.contentEl).setName("Local folder prefix").setDesc("Nonempty, nonoverlapping folder; no configuration or recovery paths.")
        .addText((text) => text.setValue(prefix).onChange((value) => { prefix = value; }));
      const shares = await this.service.discoverShares();
      if (this.closed) return;
      for (const share of shares.filter((share) => !mounts.some((mount) => mount.shareId === share.shareId))) {
        new Setting(this.contentEl).setName(share.label).setDesc(`${share.shareId} (${share.capability})`)
          .addButton((button) => button.setButtonText("Add mount").onClick(async () => {
            button.setDisabled(true);
            try { await this.service.addCompositeMount(share.shareId, prefix); if (!this.closed) await this.onOpen(); }
            catch (error) { message.setText(errorText(error)); button.setDisabled(false); }
          }));
      }
    } catch (error) { message.setText(errorText(error)); }
  }

  onClose(): void { this.closed = true; this.contentEl.empty(); }
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
