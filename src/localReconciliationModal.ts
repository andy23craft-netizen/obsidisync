import { App, Modal, Setting } from "obsidian";
import { GitService } from "./gitService";

/** Local preservation records are not server merge conflicts. Every action here is local-only. */
export class LocalReconciliationModal extends Modal {
  constructor(app: App, private readonly service: GitService) { super(app); }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Local reconciliation" });
    this.contentEl.createEl("p", { text: "Uploads are disabled. Keeping local bytes retains an upload barrier across restart and permission restoration. Using remote backs up current bytes first, then checks for intervening edits." });
    const records = this.service.localReconciliations();
    const status = this.contentEl.createEl("p", { text: records.length ? `${records.length} file(s) require attention.` : "No local reconciliation barriers." });
    for (const record of records) {
      new Setting(this.contentEl).setName(record.path)
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
    }
  }

  onClose(): void { this.contentEl.empty(); }
}
