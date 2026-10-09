import { App, Modal, Setting } from "obsidian";
import { GitService } from "./gitService";
import { ConflictResolverModal } from "./conflictResolverModal";

/** Local preservation records stay distinct from server merge conflicts. */
export class LocalReconciliationModal extends Modal {
  constructor(app: App, private readonly service: GitService) { super(app); }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Local reconciliation" });
    this.contentEl.createEl("p", { text: "Keeping local bytes retains an upload barrier across restart and permission restoration. Using remote backs up current bytes first. Writable access offers a separate explicit upload decision." });
    const records = this.service.localReconciliations();
    const status = this.contentEl.createEl("p", { text: records.length ? `${records.length} file(s) require attention.` : "No local reconciliation barriers." });
    for (const record of records) {
      const setting = new Setting(this.contentEl).setName(record.path)
        .setDesc(`${record.reason}. Remote: ${record.remote.op} at ${record.remoteHead ?? "empty share"}.${record.backupFolder ? ` Backup: ${record.backupFolder}` : ""}`)
        .addButton((button) => button.setButtonText("Keep local (upload blocked)").onClick(async () => {
          try { await this.service.keepLocalReconciliation(record.path); this.onOpen(); }
          catch (error) { status.setText(String(error)); }
        }))
        .addButton((button) => button.setButtonText("Back up and use remote").onClick(async () => {
          if (!window.confirm(`Back up and replace local ${record.path} with the current remote version (or deletion)?`)) return;
          button.setDisabled(true);
          try { await this.service.useRemoteReconciliation(record.path); this.onOpen(); }
          catch (error) { status.setText(String(error)); button.setDisabled(false); }
        }));
      if (this.service.canWriteSelectedShare()) setting.addButton((button) => button.setButtonText("Back up and upload local choice").onClick(async () => {
        if (!window.confirm(`Back up and explicitly upload current ${record.path} (or its local deletion) against the refreshed remote version?`)) return;
        button.setDisabled(true);
        try { await this.service.uploadLocalReconciliation(record.path); this.onOpen(); }
        catch (error) { status.setText(String(error)); button.setDisabled(false); }
      }));
    }
    if (this.service.canWriteSelectedShare()) new Setting(this.contentEl).setName("Server merge conflicts")
      .addButton((button) => button.setButtonText("Open server conflicts").onClick(() => {
        new ConflictResolverModal(this.app, this.service).open();
      }));
  }

  onClose(): void { this.contentEl.empty(); }
}
