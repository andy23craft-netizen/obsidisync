import type { ManifestEntry, ShareEntry } from "./protocol";
import type { IosGitSyncSettings } from "./settings";
import type { ShareDownloadState } from "./shareReconciliation";

export interface LegacyManagementContext {
  serverUrl: string;
  userSlug: string;
  vaultSlug: string;
}

export interface ClientIdentity {
  serverUrl: string;
  user: string;
  subject: string;
}

export interface LegacySyncBinding extends LegacyManagementContext {
  subject?: string;
}

export interface PendingShareSelection extends ShareEntry {
  serverUrl: string;
  identity: ClientIdentity;
  /** Configuration boundary only; never used to infer membership or a session issuer. */
  authentication: string;
  status: "reconciliation-required";
  observedHead: string | null;
  /** No share baseline exists until explicit reconciliation completes in a later ticket. */
  syncState: { serverHead: null; localManifest: ManifestEntry[]; initialSyncDone: false };
  download?: ShareDownloadState;
}

export function serverIdentity(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function captureLegacyContext(settings: IosGitSyncSettings): void {
  if (settings.composite !== undefined || settings.activeShare || settings.pendingShareSelection) return;
  if (!settings.serverUrl || !settings.userSlug || !settings.vaultSlug) return;
  const context = {
    serverUrl: serverIdentity(settings.serverUrl), userSlug: settings.userSlug, vaultSlug: settings.vaultSlug
  };
  if (!settings.legacyManagementContext) settings.legacyManagementContext = { ...context };
  if (!settings.legacySyncBinding) {
    settings.legacySyncBinding = { ...context,
      subject: settings.authenticatedIdentity?.serverUrl === context.serverUrl
        ? settings.authenticatedIdentity.subject : undefined };
  }
}

export function syncDestinationBlocker(settings: IosGitSyncSettings): string | null {
  if (settings.composite !== undefined) return "Composite mount mode is active; legacy file operations are disabled.";
  if (settings.activeShare) return "Share download mode is active. V2 write synchronization is not enabled; v1 state is retained.";
  if (settings.pendingShareSelection) {
    return "Share selection requires reconciliation. V2 file synchronization is not enabled until you explicitly back up and download in Choose share. Cancel an unstarted selection to retain v1 operation.";
  }
  const binding = settings.legacySyncBinding;
  if (!binding) return null;
  const identity = settings.authenticatedIdentity;
  if (binding.serverUrl !== serverIdentity(settings.serverUrl) || binding.userSlug !== settings.userSlug ||
      binding.vaultSlug !== settings.vaultSlug || (binding.subject && identity?.subject !== binding.subject) ||
      (identity && (identity.serverUrl !== binding.serverUrl || identity.user !== binding.userSlug))) {
    return "Sync destination or account changed. Existing sync state is retained; explicit reconciliation is required.";
  }
  return null;
}
