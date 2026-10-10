import { App, Modal, Setting } from "obsidian";
import type { ConversionPreview, GitService } from "./gitService";

/** Conversion consent is separate from later initial download/upload reconciliation. */
export class ConversionModal extends Modal {
  private closed = false;
  constructor(app: App, private readonly service: GitService) { super(app); }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Conversion and recovery" });
    const state = this.service.lifecycleState();
    const message = this.contentEl.createEl("p");
    const run = async (work: () => Promise<void>) => {
      try { await work(); if (!this.closed) await this.onOpen(); }
      catch (error) { message.setText(error instanceof Error ? error.message : String(error)); }
    };
    this.contentEl.createEl("p", { text: "If a settings save fails, reload the plugin before recovery. Backups contain credentials: keep .obsidian-git-sync local and protect copies. Previously synchronized files cannot be remotely erased. Detachment does not revoke server credentials or delete remote files." });
    if (state.conversionGate) {
      const journal = state.conversion!;
      this.contentEl.createEl("p", { text: `Conversion ${journal.id}: ${journal.phase}. All synchronization is stopped. Verified backup: ${journal.backupFolder}.` });
      for (const mapping of journal.mappings) this.contentEl.createEl("p", { text: `${mapping.source} -> ${mapping.destination} (${mapping.sha256})` });
      new Setting(this.contentEl).setName("Recover before activation")
        .addButton((button) => button.setButtonText("Resume and activate").onClick(() => run(() => this.service.recoverConversion())))
        .addButton((button) => button.setButtonText("Reverse to original binding").onClick(async () => {
          if (window.confirm("Restore only verified original bytes and configuration? Changed copies are retained and block reversal.")) {
            await run(() => this.service.recoverConversion(true));
          }
        }));
      return;
    }
    this.contentEl.createEl("p", { text: `${state.bindingArchives?.entries.length ?? 0} detached binding archive(s) retained locally. Archives are never replayed. New mounts require fresh authorization and initial reconciliation. After activation, use detachment and a new conversion to change prefixes; backups cannot blindly restore an active mount.` });
    if (!state.composite && !state.disabledBinding) new Setting(this.contentEl).setName("Original binding")
      .setDesc(`${state.activeShare?.shareId ?? `${state.userSlug}/${state.vaultSlug}`} on ${state.serverUrl}`)
      .addButton((button) => button.setButtonText("Detach and keep files").onClick(async () => {
        if (window.confirm("Detach this binding, even if access loss might be temporary? Retain all local files and archive settings, conflicts and journals as unresolved. A dispatched write may have committed remotely. No credential is revoked and no remote file is deleted.")) {
          await run(() => this.service.detachBinding());
        }
      }));
    for (const mount of state.composite?.mounts ?? []) new Setting(this.contentEl).setName(`${mount.localPrefix}/ - ${mount.label} (${mount.shareId})`)
      .setDesc("Detach before removal, retargeting or prefix changes. Siblings and server grants are retained.")
      .addButton((button) => button.setButtonText("Detach and keep files").onClick(async () => {
        if (window.confirm(`Detach ${mount.localPrefix}/ (${mount.shareId})? Keep files and archive unresolved work. A dispatched write may have committed. No remote deletion or credential revocation occurs.`)) {
          await run(() => this.service.detachBinding(mount.mountId));
        }
      }));
    this.contentEl.createEl("p", { text: "Choose authorized targets and explicit local file mappings. Leave file mappings empty to re-add retained folders at the same prefix with fresh state. Active mount files must be detached first. Configuration and recovery files stay local-only. Unmapped files remain in place; files inside a new prefix require its initial reconciliation." });
    let shares;
    try { shares = await this.service.discoverShares(); }
    catch (error) { message.setText(error instanceof Error ? error.message : String(error)); return; }
    if (this.closed) return;
    const targets: Array<{ shareId: string; localPrefix: string }> = [];
    const mappings: Array<{ source: string; destination: string }> = [];
    let preview: ConversionPreview | undefined;
    const invalidate = () => { preview = undefined; };
    const targetRows = this.contentEl.createDiv();
    const addTarget = () => {
      invalidate();
      const target = { shareId: "", localPrefix: "" }; targets.push(target);
      new Setting(targetRows).setName("Target share and local folder")
        .setDesc("Stable IDs distinguish shares. Leave both fields empty to omit this row.")
        .addDropdown((dropdown) => {
          dropdown.addOption("", "Choose a share");
          for (const share of shares) dropdown.addOption(share.shareId, `${share.label} (${share.shareId}; ${share.capability})`);
          dropdown.onChange((value) => { target.shareId = value; invalidate(); });
        })
        .addText((text) => text.setPlaceholder("Personal").onChange((value) => { target.localPrefix = value; invalidate(); }));
    };
    addTarget();
    new Setting(this.contentEl).addButton((button) => button.setButtonText("Add target").onClick(addTarget));
    const mappingRows = this.contentEl.createDiv();
    const addMapping = () => {
      invalidate();
      const mapping = { source: "", destination: "" }; mappings.push(mapping);
      new Setting(mappingRows).setName("Source file -> destination file")
        .setDesc("Include every intended note and attachment explicitly. Empty rows are omitted.")
        .addText((text) => text.setPlaceholder("note.md").onChange((value) => { mapping.source = value; invalidate(); }))
        .addText((text) => text.setPlaceholder("Personal/note.md").onChange((value) => { mapping.destination = value; invalidate(); }));
    };
    addMapping();
    new Setting(this.contentEl).addButton((button) => button.setButtonText("Add file mapping").onClick(addMapping));
    const evidence = this.contentEl.createDiv();
    new Setting(this.contentEl).setName("Preview before changing files")
      .addButton((button) => button.setButtonText("Preview").onClick(async () => {
        try {
          preview = await this.service.previewConversion(targets.filter((target) => target.shareId || target.localPrefix),
            mappings.filter((mapping) => mapping.source || mapping.destination));
          if (this.closed) return;
          evidence.empty();
          evidence.createEl("p", { text: `Source: ${state.serverUrl}; ${state.activeShare?.shareId ?? state.disabledBinding?.archiveId ?? `${state.userSlug}/${state.vaultSlug}`}; account ${state.authenticatedIdentity?.subject ?? state.userSlug}. Files and credential-bearing settings will be verified under .obsidian-git-sync/backups/ before relocation.` });
          for (const mount of preview.proposed.mounts) evidence.createEl("p", { text: `${mount.localPrefix}/ -> ${mount.label} (${mount.shareId}), ${mount.mountId}; ${mount.initialized ? "existing sibling" : "new, download-only; initial reconciliation required"}` });
          for (const file of preview.mappings) evidence.createEl("p", { text: `${file.source} -> ${file.destination}; ${file.size} bytes; ${file.sha256}; destination absent` });
          evidence.createEl("p", { text: `Excluded files (retained): ${preview.exclusions.join(", ") || "none"}. Collisions: none. Changes invalidate this preview.` });
        } catch (error) { preview = undefined; message.setText(error instanceof Error ? error.message : String(error)); }
      }))
      .addButton((button) => button.setButtonText("Back up, relocate and activate").onClick(async () => {
        if (!preview) { message.setText("Create and review a current preview first."); return; }
        if (window.confirm("Approve the exact displayed mappings and share IDs? Verify backups, relocate files and activate new download-only mounts. This does not upload or initialize targets. Synchronization stops until conversion finishes or is reversed.")) {
          const approved = preview; preview = undefined;
          await run(() => this.service.convertBinding(approved));
        }
      }));
  }

  onClose(): void { this.closed = true; this.contentEl.empty(); }
}
