import { App, Modal, Setting } from "obsidian";
import type { GitService } from "./gitService";
import { LocalReconciliationModal } from "./localReconciliationModal";
import { ConflictResolverModal } from "./conflictResolverModal";

/** Selection and initial replacement consent are separate actions, per mount. */
export class CompositeMountsModal extends Modal {
  private closed = false;
  constructor(app: App, private readonly service: GitService) { super(app); }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Composite mounts" });
    this.contentEl.createEl("p", { text: "Map server shares to separate local folders. Files outside those folders, vault configuration and recovery copies stay local-only. Enable writes separately for each mount." });
    const message = this.contentEl.createEl("p");
    try {
      const mounts = this.service.compositeMounts();
      for (const mount of mounts) {
        const guard = this.service.compositeActionGuard(mount.mountId);
        const run = async (work: () => Promise<void>) => {
          try { guard(); await work(); if (!this.closed) await this.onOpen(); }
          catch (error) { message.setText(errorText(error)); }
        };
        new Setting(this.contentEl).setName(`${mount.localPrefix}/ - ${mount.label}`)
          .setDesc(`${mount.shareId}; ${mount.capability}; ${mount.initialized ? mount.status : "initial reconciliation required"}. ${mount.download.reconciliation.length} local record(s), ${mount.barriers.length} move barrier(s). Last attempt: ${mount.lastAttemptAt ?? "never"}. Last completed: ${mount.download.lastDownloadedAt ?? "never"}. ${mount.lastError ?? ""}`)
          .addButton((button) => button.setButtonText(mount.initialized ? "Retry downloads" : "Back up and download")
            .onClick(async () => {
              if (!mount.initialized && !window.confirm(`Verify a fresh backup of ${mount.localPrefix}/ and reconcile it with ${mount.label} (${mount.shareId})? Only this folder is affected. Intervening edits are retained. Uploads remain disabled.`)) return;
              button.setDisabled(true);
              try { guard(); await this.service.initializeCompositeMount(mount.mountId); if (!this.closed) await this.onOpen(); }
              catch (error) { message.setText(errorText(error)); button.setDisabled(false); }
            }));
        if (mount.capability === "read-write") {
          if (!mount.initialized && !mount.download.initial.backupManifest) new Setting(this.contentEl)
            .setName(`Initial upload: ${mount.localPrefix}/ -> ${mount.label} (${mount.shareId})`)
            .setDesc("Replaces this share with the backed-up folder, deleting remote-only files. Other mounts are unaffected.")
            .addButton((button) => button.setButtonText("Back up and replace share").onClick(async () => {
              if (!window.confirm(`Replace ONLY ${mount.label} (${mount.shareId}) with ${mount.localPrefix}/, including deletion of remote-only files? A verified local backup is required. This enables writes for this mount.`)) return;
              await run(() => this.service.initializeShareUpload(mount.mountId));
            }));
          if (mount.initialized && mount.status === "download-only") new Setting(this.contentEl)
            .setName(`Writable synchronization: ${mount.localPrefix}/`)
            .addButton((button) => button.setButtonText("Enable writes").onClick(async () => {
              if (!window.confirm(`Enable writes from ${mount.localPrefix}/ to ${mount.label} (${mount.shareId})? Retained edits still require separate reconciliation.`)) return;
              await run(() => this.service.enableShareWrites(mount.mountId));
            }));
        }
        if (mount.initialized) new Setting(this.contentEl).setName(`Reconcile ${mount.localPrefix}/`)
          .addButton((button) => button.setButtonText("Local reconciliation").onClick(() => {
            try { guard(); new LocalReconciliationModal(this.app, this.service, mount.mountId).open(); }
            catch (error) { message.setText(errorText(error)); }
          }))
          .addButton((button) => button.setButtonText("Server conflicts").onClick(() => {
            try { guard(); new ConflictResolverModal(this.app, this.service, [], undefined, mount.mountId).open(); }
            catch (error) { message.setText(errorText(error)); }
          }));
        for (const record of mount.download.reconciliation) this.contentEl.createEl("p", {
          text: `${mount.localPrefix}/${record.path}: ${record.reason}. Local contents retained; upload blocked.`
        });
        for (const barrier of mount.barriers) {
          const move = this.service.compositeMoveDescription(barrier.moveId);
          const setting = new Setting(this.contentEl).setName(`${mount.localPrefix}/${barrier.path || "(whole mount)"}`)
            .setDesc(`${move}. This decision affects only this endpoint; the other endpoint stays blocked.`);
          for (const [label, choice] of [["Keep local (upload blocked)", "keep-local"], ["Back up and use remote", "use-remote"],
            ...(this.service.canWriteSelectedShare(mount.mountId) ? [["Back up and upload endpoint", "upload-local"]] : [])]) {
            setting.addButton((button) => button.setButtonText(label).onClick(async () => {
              const outcome = choice === "upload-local" ? "Upload includes current local deletions."
                : choice === "use-remote" ? "Current remote contents or deletions replace this endpoint after backup."
                : "Local contents are retained and uploads stay blocked.";
              if (!window.confirm(`${move}. ${label} for ONLY ${mount.localPrefix}/${barrier.path || "(whole mount)"}? ${outcome} The other endpoint is not approved.`)) return;
              await run(() => this.service.reconcileCompositeMove(mount.mountId, barrier.moveId, barrier.path,
                choice as "keep-local" | "use-remote" | "upload-local"));
            }));
          }
        }
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
