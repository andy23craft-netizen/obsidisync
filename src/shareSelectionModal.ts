import { App, Modal, Setting } from "obsidian";
import { GitService } from "./gitService";
import type { IosGitSyncSettings } from "./settings";

/** Selection only. Reconciliation and all v2 file operations remain disabled. */
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
    contentEl.createEl("p", { text: "Selection retains your existing files and v1 sync state. File synchronization pauses until explicit reconciliation is implemented." });
    const pending = this.settings.pendingShareSelection;
    if (pending) {
      new Setting(contentEl).setName(`Pending: ${pending.label}`)
        .setDesc(`${pending.shareId} (${pending.capability}) - reconciliation required`)
        .addButton((button) => button.setButtonText("Cancel pending selection").onClick(async () => {
          try { await this.service.cancelShareSelection(); this.close(); }
          catch (error) { status.setText(errorMessage(error)); }
        }));
    }
    const status = contentEl.createEl("p", { text: "Loading authorized shares..." });
    try {
      const shares = await this.service.discoverShares();
      if (this.closed) return;
      status.setText(shares.length ? "Choose a share by its stable ID." : "No accessible published shares.");
      for (const share of shares) {
        new Setting(contentEl).setName(share.label).setDesc(`${share.shareId} (${share.capability})`)
          .addButton((button) => button.setButtonText("Select").onClick(async () => {
            button.setDisabled(true);
            try {
              await this.service.stageShareSelection(share.shareId);
              status.setText("Selection saved. Reconciliation is required; v2 file synchronization remains disabled.");
              this.close();
            } catch (error) { status.setText(errorMessage(error)); button.setDisabled(false); }
          }));
      }
    } catch (error) { if (!this.closed) status.setText(errorMessage(error)); }
  }

  onClose(): void { this.closed = true; this.contentEl.empty(); }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
