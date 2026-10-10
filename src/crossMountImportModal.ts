import { App, Modal, Setting } from "obsidian";
import type { GitService } from "./gitService";
import type { ImportMapping, ImportRecord } from "./crossMountImport";

export class CrossMountImportModal extends Modal {
  private closed = false;
  constructor(app: App, private readonly service: GitService) { super(app); }

  onOpen(): void {
    this.closed = false;
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Copy/import between shares" });
    this.contentEl.createEl("p", { text: "Import copies explicitly selected files. Destination members and administrators can read them, including their new history. Links are unchanged and may need manual repair. Attachments must be selected separately; links are never followed. Source deletion is a separate confirmation after verified destination acceptance. Copy plus delete is not atomic." });
    const message = this.contentEl.createEl("p");
    const run = async (work: () => Promise<void>) => {
      try { await work(); }
      catch (error) { if (!this.closed) message.setText(error instanceof Error ? error.message : String(error)); }
    };
    let input = "";
    new Setting(this.contentEl).setName("Explicit file mappings")
      .setDesc("One vault-relative source -> destination per line, e.g. Personal/note.md -> Harmony/note.md. Include each attachment explicitly. Destination must be an active writable share folder.")
      .addTextArea((text) => text.setPlaceholder("Personal/note.md -> Harmony/note.md").onChange((value) => { input = value; }));
    new Setting(this.contentEl).addButton((button) => button.setButtonText("Preview selected files").onClick(() => run(async () => {
      const mappings = input.split("\n").filter((line) => line.trim()).map((line) => {
        const parts = line.split(" -> ");
        if (parts.length !== 2) throw new Error("Use source -> destination on each line");
        return { source: parts[0].trim(), destination: parts[1].trim() };
      });
      this.showPreview(await this.service.previewImport(mappings));
    })));
    for (const move of this.service.detectedImportMoves()) {
      this.contentEl.createEl("h3", { text: `Detected move: ${move.from} -> ${move.to}` });
      this.contentEl.createEl("p", { text: "The filesystem move already happened. Missing original local files have not been retained there. Select current files to import; original remote deletions remain blocked. Local-only destinations require local reconciliation in Manage mounts and cannot authorize remote-source deletion here." });
      const selected = new Set<ImportMapping>();
      for (const mapping of move.mappings) new Setting(this.contentEl).setName(mapping.current!)
        .setDesc(`Original: ${mapping.source}`)
        .addToggle((toggle) => toggle.setValue(false).onChange((value) => { if (value) selected.add(mapping); else selected.delete(mapping); }));
      new Setting(this.contentEl).addButton((button) => button.setButtonText("Preview selected moved files")
        .onClick(() => run(async () => this.showPreview(await this.service.previewImport([...selected], move.id)))));
    }
    const records = this.service.importRecords();
    for (const record of records) {
      this.contentEl.createEl("h3", { text: `Import ${record.id}` });
      for (const file of record.files) this.contentEl.createEl("p", { text:
        `${file.source.label}: ${file.source.localPath} -> ${file.destination.label}: ${file.destination.localPath}. ` +
        `Current evidence: ${file.currentPath}; original local source ${file.sourceLocal ? "present at preview" : "already absent"}. ` +
        `${file.deleted ? "Source deletion verified" : file.accepted ? "Destination verified; source deletion not completed" : "Destination not yet verified"}. ` +
        `Recovery: ${file.backupFolder ?? "not created"}.` });
      if (record.error) this.contentEl.createEl("p", { text: record.error });
      if (record.closed) {
        this.contentEl.createEl("p", { text: "Ended without source deletion. Exact endpoints are preserved for explicit local reconciliation in Manage mounts; detected move barriers remain." });
        continue;
      }
      if (records.some((entry) => entry.replacesId === record.id)) {
        this.contentEl.createEl("p", { text: "Replaced by a newer approved journal. Recovery evidence and any other destination barriers remain." });
        continue;
      }
      new Setting(this.contentEl).addButton((button) => button.setButtonText("Inspect and resume import")
        .onClick(() => run(async () => { await this.service.resumeImport(record.id); if (!this.closed) this.onOpen(); })));
      if (record.files.some((file) => !file.deleted)) {
        new Setting(this.contentEl).addButton((button) => button.setButtonText("Preserve remaining copies; reconcile separately")
          .onClick(() => run(async () => {
            if (!window.confirm("End this import without any further deletion? Preserve the named source/current/destination endpoints as upload-blocked local reconciliation records. Original files may already be absent after a move or deletion attempt. Recovery copies and detected-move barriers remain. Submitted remote writes are inspected, not undone.")) return;
            await this.service.preserveImportEndpoints(record.id); if (!this.closed) this.onOpen();
          })));
      }
      if (record.files.every((file) => !file.localDeleteIntent)) {
        let destinations = record.files.map((file) => file.destination.localPath).join("\n");
        new Setting(this.contentEl).setName("Recapture destinations")
          .setDesc("One absent destination per original source, in the displayed order. Old evidence is retained; reconfirm all captured bytes. Existing remote collisions must be reconciled separately or use new paths.")
          .addTextArea((text) => text.setValue(destinations).onChange((value) => { destinations = value; }));
        new Setting(this.contentEl).addButton((button) => button.setButtonText("Recapture and preview again").onClick(() => run(async () => {
          const paths = destinations.split("\n").filter((line) => line.trim()).map((line) => line.trim());
          if (paths.length !== record.files.length) throw new Error("Provide one destination per original source");
          this.showPreview(await this.service.previewImport(record.files.map((file, index) => ({
            source: file.source.localPath, current: file.currentPath, destination: paths[index]
          })), record.moveId, record.id));
        })));
      }
      if (record.files.every((file) => file.accepted) && record.files.some((file) => !file.deleted)) {
        new Setting(this.contentEl).addButton((button) => button.setButtonText("Separately confirm source deletion")
          .onClick(() => run(async () => {
            if (!window.confirm(`Delete ONLY these original sources after fresh destination verification?\n${record.files.filter((file) => !file.deleted).map((file) => `${file.source.label}: ${file.source.localPath}${file.sourceLocal ? "" : " (already absent locally; remote deletion still needs consent)"}`).join("\n")}\nRead-only sources cannot be deleted. New edits stop deletion. Recovery copies remain. Submitted remote writes cannot be rolled back by this dialog.`)) return;
            await this.service.deleteImportSources(record.id); if (!this.closed) this.onOpen();
          })));
      }
    }
    this.contentEl.createEl("p", { text: "A stale plan, collision or ambiguous outcome requires explicit reconciliation in Manage mounts. Keep recovery copies. Import never replaces an existing remote destination; reconcile separately, then preview and confirm again." });
  }

  private showPreview(record: ImportRecord): void {
    if (this.closed) return;
    const preview = this.contentEl.createDiv();
    preview.createEl("h3", { text: "Captured import preview" });
    for (const file of record.files) preview.createEl("p", { text:
      `${file.source.label}: ${file.source.localPath} -> ${file.destination.label}: ${file.destination.localPath}. ` +
      `Current bytes: ${file.currentPath}; ${file.captured.size} bytes; SHA-256 ${file.captured.sha256}. ` +
      `Original local source ${file.sourceLocal ? "present" : "already absent"}. ` +
      `${file.destinationLocal && file.currentPath !== file.destination.localPath ? "LOCAL COLLISION: separate backup/replacement consent required." : "No local replacement required."}` });
    const collision = record.files.some((file) => file.destinationLocal && file.currentPath !== file.destination.localPath);
    let replace = false;
    if (collision) new Setting(preview).setName("Separate local replacement consent")
      .setDesc("Back up and verify existing local destination bytes before replacing them. This does not permit remote replacement.")
      .addToggle((toggle) => toggle.setValue(false).onChange((value) => { replace = value; }));
    const errorEl = preview.createEl("p");
    new Setting(preview).addButton((button) => button.setButtonText("Approve copy/import only").onClick(async () => {
      if (collision && !replace) { errorEl.setText("Confirm local backup/replacement separately first."); return; }
      if (!window.confirm("Copy these exact captured files into the named destination shares? Their members can read the contents and new history. Links remain unchanged. This approves no source deletion.")) return;
      button.setDisabled(true);
      try { await this.service.approveImport(record, replace); if (!this.closed) this.onOpen(); }
      catch (error) { errorEl.setText(error instanceof Error ? error.message : String(error)); button.setDisabled(false); }
    }));
  }

  onClose(): void { this.closed = true; this.contentEl.empty(); }
}
