import { App, Modal, Setting } from "obsidian";
import { GitService } from "./gitService";
import type { IosGitSyncSettings } from "./settings";

/** Explicit initial download consent; ordinary synchronization cannot overwrite an uninitialized vault. */
export class ShareSelectionModal extends Modal {
  private closed = false;
  constructor(app: App, private readonly service: GitService, private readonly settings: IosGitSyncSettings) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Choose server share" });
    contentEl.createEl("p", { text: "Selection retains v1 state. Initial share download requires a verified backup before replacing files. V2 uploads remain disabled." });
    const status = contentEl.createEl("p", { text: "Loading authorized shares..." });
    const active = this.settings.activeShare;
    if (active) {
      status.setText(`${active.label} (${active.shareId}): ${active.capability}, download-only. ${active.download.reconciliation.length} reconciliation barrier(s). Use the conflict command to review local records. Use a separate local vault for another share.`);
      return;
    }
    const pending = this.settings.pendingShareSelection;
    if (pending) {
      new Setting(contentEl).setName(`Pending: ${pending.label}`)
        .setDesc(`${pending.shareId} (${pending.capability}) - reconciliation required${pending.download ? "; resume recovery, cancellation is unavailable after download starts" : ""}`)
        .addButton((button) => button.setButtonText("Cancel pending selection").setDisabled(Boolean(pending.download)).onClick(async () => {
          try { await this.service.cancelShareSelection(); this.close(); }
          catch (error) { status.setText(errorMessage(error)); }
        }))
        .addButton((button) => button.setButtonText(pending.download ? "Resume initial download" : "Back up and download share").onClick(async () => {
          if (!pending.download && !window.confirm("Back up this local vault, then reconcile it with the selected share? Files changed after backup will be preserved for local reconciliation. V1 state is retained, but returning to v1 after file changes requires manual recovery.")) return;
          button.setDisabled(true);
          try { await this.service.initializeShareDownload(); this.close(); }
          catch (error) { status.setText(errorMessage(error)); button.setDisabled(false); }
        }));
    }
    try {
      const shares = await this.service.discoverShares();
      if (this.closed) return;
      status.setText(shares.length ? "Choose a share by its stable ID." : "No accessible published shares.");
      for (const share of shares) {
        new Setting(contentEl).setName(share.label).setDesc(`${share.shareId} (${share.capability})`)
          .addButton((button) => button.setButtonText("Select").setDisabled(Boolean(pending?.download)).onClick(async () => {
            button.setDisabled(true);
            try {
              await this.service.stageShareSelection(share.shareId);
              status.setText("Selection saved. Open Choose share again to explicitly back up and download. Uploads remain disabled.");
              this.close();
            } catch (error) { status.setText(errorMessage(error)); button.setDisabled(false); }
          }));
      }
    } catch (error) { if (!this.closed) status.setText(errorMessage(error)); }
  }

  onClose(): void { this.closed = true; this.contentEl.empty(); }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
