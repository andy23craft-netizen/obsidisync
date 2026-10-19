import { App, Modal, Setting } from "obsidian";
import { GitService } from "./gitService";
import { ConflictResolverModal } from "./conflictResolverModal";

/** Local preservation records stay distinct from server merge conflicts. */
export class LocalReconciliationModal extends Modal {
  private readonly guard: () => void;
  constructor(app: App, private readonly service: GitService, private readonly mountId?: string) {
    super(app); this.guard = mountId ? service.compositeActionGuard(mountId) : () => {};
  }

  onOpen(): void {
    this.guard();
    this.contentEl.empty();
    if (this.modalEl) {
      this.modalEl.style.width = "min(96vw, 900px)";
      this.modalEl.style.maxWidth = "96vw";
      this.modalEl.style.maxHeight = "90vh";
    }
    if (this.contentEl.style) {
      this.contentEl.style.maxHeight = "80vh";
      this.contentEl.style.overflowY = "auto";
      this.contentEl.style.overflowX = "hidden";
    }
    this.contentEl.createEl("h2", { text: this.mountId ? `Local reconciliation: ${this.service.compositeMounts().find((mount) => mount.mountId === this.mountId)?.localPrefix}/` : "Local reconciliation" });
    this.contentEl.createEl("p", { text: "New files sync automatically while writable sync is enabled. These retained files need a recovery choice. Remote replacement makes a backup first." });
    const records = this.service.localReconciliations(this.mountId);
    const status = this.contentEl.createEl("p", { text: records.length ? `${records.length} file(s) require attention.` : "No local reconciliation barriers." });
    if (records.length && this.service.canWriteSelectedShare(this.mountId)) {
      new Setting(this.contentEl).setName(`Upload all ${records.length} local choices`)
        .setDesc("Back up current files, include local deletions, then submit them together. Server conflicts remain for separate review.")
        .addButton((button) => button.setButtonText("Back up and upload all").setCta().onClick(async () => {
          if (!window.confirm(`Back up and upload the current local choice for all ${records.length} listed files or deletions?`)) return;
          button.setDisabled(true);
          try { this.guard(); await this.service.uploadAllLocalReconciliations(this.mountId); this.onOpen(); }
          catch (error) { status.setText(String(error)); button.setDisabled(false); }
        }));
    }
    if (records.length) {
      const confirmedPaths = records.map((record) => record.path);
      new Setting(this.contentEl).setName(`Download all ${records.length} remote choices`)
        .setDesc("Back up every current local file first, then replace the listed choices with refreshed remote versions, including deletions. Newer choices are left for a separate confirmation.")
        .addButton((button) => button.setButtonText("Back up and download all").setWarning().onClick(async () => {
          if (!window.confirm(`Back up current local files and download remote versions or deletions for all ${confirmedPaths.length} listed choices? The backup must succeed before any replacement.`)) return;
          button.setDisabled(true);
          try {
            this.guard();
            const result = await this.service.downloadAllLocalReconciliations(this.mountId, confirmedPaths);
            this.onOpen();
            this.contentEl.createEl("p", { text: `Applied ${result.applied}; skipped ${result.skipped}; failed ${result.failed}.${result.backupFolder ? ` Backup: ${result.backupFolder}` : ""}` });
          } catch (error) { status.setText(String(error)); button.setDisabled(false); }
        }));
    }
    for (const record of records) {
      const setting = new Setting(this.contentEl).setName(record.path)
        .setDesc(`Reason: ${record.reason}. Remote target: ${record.remote.op} at ${record.remoteHead ?? "empty share"}.${record.backupFolder ? ` Backup: ${record.backupFolder}` : ""}`);
      if (setting.settingEl) {
        setting.settingEl.style.display = "block";
        setting.settingEl.style.padding = "8px 0";
      }
      if (setting.infoEl) setting.infoEl.style.width = "100%";
      if (setting.nameEl) {
        setting.nameEl.style.whiteSpace = "normal";
        setting.nameEl.style.overflowWrap = "anywhere";
      }
      if (setting.descEl) {
        setting.descEl.style.whiteSpace = "normal";
        setting.descEl.style.overflowWrap = "anywhere";
      }
      if (setting.controlEl) {
        setting.controlEl.style.width = "100%";
        setting.controlEl.style.display = "flex";
        setting.controlEl.style.flexWrap = "wrap";
        setting.controlEl.style.gap = "6px";
        setting.controlEl.style.marginTop = "6px";
      }
      setting.addButton((button) => button.setButtonText("Keep local (upload blocked)").onClick(async () => {
          try { this.guard(); await this.service.keepLocalReconciliation(record.path, this.mountId); this.onOpen(); }
          catch (error) { status.setText(String(error)); }
        }))
        .addButton((button) => button.setButtonText("Back up and use remote").onClick(async () => {
          if (!window.confirm(`Back up and replace local ${record.path} with the current remote version (or deletion)?`)) return;
          button.setDisabled(true);
          try { this.guard(); await this.service.useRemoteReconciliation(record.path, this.mountId); this.onOpen(); }
          catch (error) { status.setText(String(error)); button.setDisabled(false); }
        }));
      if (this.service.canWriteSelectedShare(this.mountId)) setting.addButton((button) => button.setButtonText("Back up and upload local choice").onClick(async () => {
        if (!window.confirm(`Back up and explicitly upload current ${record.path} (or its local deletion) against the refreshed remote version?`)) return;
        button.setDisabled(true);
        try { this.guard(); await this.service.uploadLocalReconciliation(record.path, this.mountId); this.onOpen(); }
        catch (error) { status.setText(String(error)); button.setDisabled(false); }
      }));
    }
    if (this.service.canWriteSelectedShare(this.mountId)) new Setting(this.contentEl).setName("Server merge conflicts")
      .addButton((button) => button.setButtonText("Open server conflicts").onClick(() => {
        new ConflictResolverModal(this.app, this.service, [], undefined, this.mountId).open();
      }));
  }

  onClose(): void { this.contentEl.empty(); }
}
