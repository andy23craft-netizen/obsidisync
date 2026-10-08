//! Explicit offline staged-copy publication. A durable journal excludes startup until finalization.
use crate::accounts::AccountStore;
use crate::publication::{Mapping, Publication, AUTHORITY, PENDING};
use crate::{auth_storage, paths};
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::path::{Path, PathBuf};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    pub version: u32,
    pub set_id: String,
    pub backup: PathBuf,
    pub mappings: Vec<Mapping>,
    pub excluded: Vec<Excluded>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Excluded {
    pub user: String,
    pub vault: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u32,
    plan: Plan,
    digest: String,
    previous: Option<Publication>,
    sources: BTreeMap<String, String>,
    auth_fingerprint: String,
    installed: Vec<String>,
    committed: bool,
}

fn fingerprint(path: &Path) -> Result<String> {
    let mut hasher = Sha256::new();
    fingerprint_into(path, Path::new(""), &mut hasher)?;
    Ok(format!("{:x}", hasher.finalize()))
}
fn fingerprint_into(root: &Path, relative: &Path, hasher: &mut Sha256) -> Result<()> {
    let path = if relative.as_os_str().is_empty() {
        root.to_path_buf()
    } else {
        root.join(relative)
    };
    let info = fs::symlink_metadata(&path)?;
    if info.file_type().is_symlink() || (!info.is_dir() && !info.is_file()) {
        bail!("unsafe migration storage entry");
    }
    let name = relative.as_os_str().as_encoded_bytes();
    hasher.update((name.len() as u64).to_be_bytes());
    hasher.update(name);
    hasher.update(if info.is_dir() { b"d" } else { b"f" });
    if info.is_file() {
        hasher.update(info.len().to_be_bytes());
        use std::io::Read;
        let mut file = File::open(path)?;
        let mut buf = [0u8; 65536];
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
    } else {
        let mut entries = fs::read_dir(path)?.collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            fingerprint_into(root, &relative.join(entry.file_name()), hasher)?;
        }
    }
    Ok(())
}
fn source(root: &Path, user: &str, vault: &str) -> Result<PathBuf> {
    paths::validate_slug(user, "user")?;
    paths::validate_slug(vault, "vault")?;
    for path in [
        root.join("users"),
        root.join("users").join(user),
        root.join("users").join(user).join("vaults"),
    ] {
        crate::publication::reject_symlink(&path)?;
    }
    Ok(root.join("users").join(user).join("vaults").join(vault))
}
pub fn inventory(root: &Path) -> Result<Vec<Excluded>> {
    let mut result = vec![];
    let users = root.join("users");
    if !users.exists() {
        return Ok(result);
    }
    crate::publication::reject_symlink(&users)?;
    for user in fs::read_dir(users)? {
        let user = user?;
        crate::publication::reject_symlink(&user.path())?;
        if !user.file_type()?.is_dir() {
            bail!("invalid legacy inventory entry");
        }
        let name = user.file_name().to_string_lossy().into_owned();
        let vaults = user.path().join("vaults");
        if !vaults.exists() {
            continue;
        }
        crate::publication::reject_symlink(&vaults)?;
        for vault in fs::read_dir(vaults)? {
            let vault = vault?;
            crate::publication::reject_symlink(&vault.path())?;
            if !vault.file_type()?.is_dir() {
                bail!("invalid legacy inventory entry");
            }
            result.push(Excluded {
                user: name.clone(),
                vault: vault.file_name().to_string_lossy().into_owned(),
            });
        }
    }
    Ok(result)
}
fn auth_fingerprint(root: &Path) -> Result<String> {
    let mut result = BTreeMap::new();
    let auth = root.join("auth");
    crate::publication::reject_symlink(&auth)?;
    if !auth.exists() {
        return Ok(format!("{:x}", Sha256::digest(b"empty")));
    }
    for entry in fs::read_dir(&auth)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "share-publication.json"
            || name == "share-migration-pending.json"
            || name.ends_with(".tmp")
        {
            continue;
        }
        result.insert(name, fingerprint(&entry.path())?);
    }
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&result)?)
    ))
}

fn tree_bytes(path: &Path) -> Result<u64> {
    let info = fs::symlink_metadata(path)?;
    if info.file_type().is_symlink() {
        bail!("unsafe migration link");
    }
    if info.is_file() {
        return Ok(info.len());
    }
    let mut total = 0u64;
    for entry in fs::read_dir(path)? {
        total = total
            .checked_add(tree_bytes(&entry?.path())?)
            .ok_or_else(|| anyhow!("migration size overflow"))?;
    }
    Ok(total)
}
fn capacity(root: &Path, required: u64) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::MetadataExt;
        let device = fs::metadata(root)?.dev();
        for path in [root.join("shares"), root.join("migrations")] {
            crate::publication::reject_symlink(&path)?;
            if path.exists() && fs::metadata(path)?.dev() != device {
                bail!("staging and share roots must be on the data filesystem");
            }
        }
        let path = std::ffi::CString::new(root.as_os_str().as_bytes())?;
        let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        // SAFETY: a valid NUL-terminated pathname and correctly sized writable output.
        if unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 {
            bail!("cannot determine migration capacity");
        }
        // SAFETY: statvfs initialized the output on success.
        let stat = unsafe { stat.assume_init() };
        let available = (stat.f_bavail as u128) * (stat.f_frsize as u128);
        if available < (required as u128) + (16 * 1024 * 1024) {
            bail!("insufficient staging capacity including recovery reserve");
        }
    }
    Ok(())
}
pub fn read_plan(path: &Path) -> Result<(Plan, String)> {
    let bytes = fs::read(path)?;
    let plan: Plan =
        serde_json::from_slice(&bytes).map_err(|_| anyhow!("invalid migration manifest"))?;
    Ok((plan, format!("{:x}", Sha256::digest(&bytes))))
}
pub async fn dry_run(root: &Path, plan: &Plan) -> Result<()> {
    if root.join(PENDING).exists() {
        bail!("migration pending; inspect/recover offline");
    }
    if plan.version != 1 {
        bail!("unsupported migration manifest");
    }
    paths::validate_slug(&plan.set_id, "migration set")?;
    let data = fs::canonicalize(root)?;
    let backup = fs::canonicalize(&plan.backup)?;
    crate::publication::reject_symlink(&plan.backup)?;
    if backup.starts_with(&data) || data.starts_with(&backup) {
        bail!("backup must be a separate protected directory outside the data tree");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(&backup)?.permissions().mode() & 0o077 != 0 {
            bail!("backup directory must deny group/other access");
        }
    }
    let accounts = AccountStore::load(root)?;
    let previous = Publication::read_for_recovery(root)?;
    if let Some(p) = &previous {
        p.validate(root)?;
        for id in &p.published {
            let published_root = root.join("shares").join(id);
            if fingerprint(&published_root)? != fingerprint(&plan.backup.join("shares").join(id))? {
                bail!("backup does not match previously published storage");
            }
            validate_unit(&published_root).await?;
        }
    }
    let mut seen = HashSet::new();
    let mut targets = HashSet::new();
    let mut required_bytes = 0u64;
    for m in &plan.mappings {
        if crate::auth::normalize_user_claim(&m.user)? != m.user {
            bail!("noncanonical legacy authentication namespace requires explicit offline reconciliation");
        }
        if !seen.insert((m.user.clone(), m.vault.clone()))
            || !targets.insert(&m.share_id)
            || root.join("shares").join(&m.share_id).exists()
            || previous.as_ref().is_some_and(|p| {
                p.mappings
                    .iter()
                    .any(|old| old.user == m.user && old.vault == m.vault)
            })
        {
            bail!("migration mapping/target collision");
        }
        crate::accounts::validate_id(&m.share_id, "s_")?;
        if !accounts.shares.iter().any(|s| s.id == m.share_id) || m.principals.is_empty() {
            bail!("missing durable share/authorized principals");
        }
        for principal in &m.principals {
            accounts.validate_principal(principal)?;
            if accounts.capability(&m.share_id, principal).is_none() {
                bail!("mapping lacks share membership");
            }
        }
        let src = source(root, &m.user, &m.vault)?;
        let backup = source(&plan.backup, &m.user, &m.vault)?;
        if fingerprint(&src)? != fingerprint(&backup)? {
            bail!("backup does not match source");
        }
        validate_unit(&src).await?;
        required_bytes = required_bytes
            .checked_add(tree_bytes(&src)?)
            .ok_or_else(|| anyhow!("migration size overflow"))?;
    }
    for excluded in &plan.excluded {
        if previous.as_ref().is_some_and(|p| {
            p.mappings
                .iter()
                .any(|old| old.user == excluded.user && old.vault == excluded.vault)
        }) {
            bail!("already published source cannot be excluded by a later migration");
        }
        if !seen.insert((excluded.user.clone(), excluded.vault.clone())) {
            bail!("duplicate excluded source");
        }
        let src = source(root, &excluded.user, &excluded.vault)?;
        if fingerprint(&src)?
            != fingerprint(&source(&plan.backup, &excluded.user, &excluded.vault)?)?
        {
            bail!("excluded source backup mismatch");
        }
    }
    for entry in inventory(root)? {
        if previous.as_ref().is_some_and(|p| {
            p.mappings
                .iter()
                .any(|m| m.user == entry.user && m.vault == entry.vault)
        }) {
            continue;
        }
        if !seen.contains(&(entry.user, entry.vault)) {
            bail!("inventory requires explicit mapping or exclusion for every source");
        }
    }
    if auth_fingerprint(root)? != auth_fingerprint(&plan.backup)? {
        bail!("authentication backup does not match");
    }
    if serde_json::to_vec(&previous)?
        != serde_json::to_vec(&Publication::read_for_recovery(&plan.backup)?)?
    {
        bail!("publication backup does not match");
    }
    capacity(root, required_bytes)?;
    if root.join("migrations").join(&plan.set_id).exists() {
        bail!("staging set collision");
    }
    Ok(())
}
async fn validate_unit(root: &Path) -> Result<()> {
    fingerprint(root)?;
    let state: crate::vault::VaultState =
        serde_json::from_slice(&fs::read(root.join("state.json"))?)?;
    paths::validate_git_branch(&state.branch)?;
    paths::validate_git_identity(&state.author_name, "author")?;
    paths::validate_git_identity(&state.author_email, "author")?;
    if !state.remote_url.is_empty() {
        crate::remote::RemotePolicy::from_env().validate(&state.remote_url)?;
    }
    let repo = root.join("repo");
    if !repo.join(".git").is_dir()
        || repo.join(".git/objects/info/alternates").exists()
        || repo.join(".git/commondir").exists()
    {
        bail!("external Git storage is not migratable");
    }
    if root.join("inkvault-publication.json").exists() {
        bail!("recover pending InkVault publication before migration");
    }
    crate::git::git(Some(&repo), &["fsck", "--full"], &[0]).await?;
    let current = crate::binary_store::read_manifest(&repo).await?;
    for binary in current.files.values() {
        let bytes = crate::binary_store::read_binary_object(&root.join("binary"), binary).await?;
        if crate::binary_store::sha256_hex(&bytes) != binary.sha256
            || bytes.len() as u64 != binary.size
        {
            bail!("working binary mismatch");
        }
    }
    let output = crate::git::git(Some(&repo), &["rev-list", "--all"], &[0]).await?;
    for revision in String::from_utf8(output.stdout)?.lines() {
        let spec = format!("{revision}:{}", crate::binary_store::BINARY_MANIFEST_PATH);
        let result = crate::git::git(Some(&repo), &["show", &spec], &[0, 128]).await?;
        if result.code != 0 {
            continue;
        }
        let manifest: crate::binary_store::BinaryManifest = serde_json::from_slice(&result.stdout)?;
        crate::binary_store::validate_manifest(&manifest)?;
        for binary in manifest.files.values() {
            let bytes =
                crate::binary_store::read_binary_object(&root.join("binary"), binary).await?;
            if crate::binary_store::sha256_hex(&bytes) != binary.sha256
                || bytes.len() as u64 != binary.size
            {
                bail!("historical binary mismatch");
            }
        }
    }
    crate::version_registry::read_devices(&root.join("devices.json")).await?;
    crate::version_registry::read_version_metadata(&root.join("version-metadata.json")).await?;
    if root.join("pending-conflicts.json").exists() {
        let pending: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("pending-conflicts.json"))?)?;
        match pending {
            serde_json::Value::Array(entries) => {
                for value in entries {
                    paths::validate_vault_path(
                        value
                            .as_str()
                            .ok_or_else(|| anyhow!("invalid conflict state"))?,
                    )?;
                }
            }
            serde_json::Value::Object(entries) => {
                for (path, owner) in entries {
                    paths::validate_vault_path(&path)?;
                    if !owner.is_null() && !owner.is_string() {
                        bail!("invalid conflict owner");
                    }
                }
            }
            _ => bail!("invalid conflict state"),
        }
    }
    if root.join("saber-push.json").exists() {
        crate::saber::push::validate_state(&root.join("saber-push.json"))?;
    }
    if root.join("uploads").exists() {
        for entry in fs::read_dir(root.join("uploads"))? {
            let path = entry?.path();
            if path.extension().is_some_and(|e| e == "json") {
                crate::vault::validate_migration_upload(&path)?;
            }
        }
    }
    Ok(())
}
#[cfg(test)]
fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    copy_tree_checked(from, to, &|_| Ok(()))
}
fn copy_tree_checked(
    from: &Path,
    to: &Path,
    checkpoint: &dyn Fn(&str) -> Result<()>,
) -> Result<()> {
    let info = fs::symlink_metadata(from)?;
    if info.file_type().is_symlink() {
        bail!("unsafe migration link");
    }
    if info.is_dir() {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_tree_checked(&entry.path(), &to.join(entry.file_name()), checkpoint)?;
        }
        fs::set_permissions(to, info.permissions())?;
        File::open(to)?.sync_all()?;
    } else if info.is_file() {
        fs::copy(from, to)?;
        fs::set_permissions(to, info.permissions())?;
        File::open(to)?.sync_all()?;
        checkpoint("copy-file")?;
    } else {
        bail!("unsupported migration entry");
    }
    Ok(())
}
pub async fn apply(root: &Path, plan: Plan, digest: String, confirmation: &str) -> Result<()> {
    apply_checked(root, plan, digest, confirmation, &|_| Ok(())).await
}
async fn apply_checked(
    root: &Path,
    plan: Plan,
    digest: String,
    confirmation: &str,
    checkpoint: &(dyn Fn(&str) -> Result<()> + Sync),
) -> Result<()> {
    if digest != confirmation {
        bail!("reviewed manifest confirmation mismatch");
    }
    dry_run(root, &plan).await?;
    let mut sources = BTreeMap::new();
    for m in &plan.mappings {
        sources.insert(
            m.share_id.clone(),
            fingerprint(&source(root, &m.user, &m.vault)?)?,
        );
    }
    let journal = Journal {
        version: 1,
        plan,
        digest,
        previous: Publication::read_for_recovery(root)?,
        sources,
        auth_fingerprint: auth_fingerprint(root)?,
        installed: vec![],
        committed: false,
    };
    auth_storage::write(&root.join(PENDING), &journal)?;
    checkpoint("journal-written")?;
    resume_checked(root, checkpoint).await
}
pub async fn resume(root: &Path) -> Result<()> {
    resume_checked(root, &|_| Ok(())).await
}
fn reviewed_publication(journal: &Journal) -> Publication {
    let mut next = journal.previous.clone().unwrap_or_default();
    next.generation += 1;
    next.set_id = journal.plan.set_id.clone();
    next.published.extend(
        journal
            .plan
            .mappings
            .iter()
            .map(|mapping| mapping.share_id.clone()),
    );
    next.mappings.extend(journal.plan.mappings.clone());
    next
}
async fn resume_checked(
    root: &Path,
    checkpoint: &(dyn Fn(&str) -> Result<()> + Sync),
) -> Result<()> {
    let mut journal: Journal =
        auth_storage::read(&root.join(PENDING))?.ok_or_else(|| anyhow!("no pending migration"))?;
    if journal.version != 1 || journal.auth_fingerprint != auth_fingerprint(root)? {
        bail!("migration authorization changed; restore/reconcile offline");
    }
    let current = Publication::read_for_recovery(root)?;
    if current
        .as_ref()
        .is_some_and(|p| p.set_id == journal.plan.set_id)
    {
        let current = current.unwrap();
        if serde_json::to_vec(&current)? != serde_json::to_vec(&reviewed_publication(&journal))? {
            bail!("committed publication differs from reviewed migration set");
        }
        current.validate(root)?;
        for mapping in &journal.plan.mappings {
            let destination = root.join("shares").join(&mapping.share_id);
            if journal.sources.get(&mapping.share_id) != Some(&fingerprint(&destination)?) {
                bail!("committed migration storage changed; recover protected backup offline");
            }
            validate_unit(&destination).await?;
        }
        finish(root)?;
        return Ok(());
    }
    if serde_json::to_vec(&current)? != serde_json::to_vec(&journal.previous)? {
        bail!("publication generation changed");
    }
    for m in &journal.plan.mappings {
        let src = source(root, &m.user, &m.vault)?;
        let expected = journal
            .sources
            .get(&m.share_id)
            .ok_or_else(|| anyhow!("invalid journal source"))?;
        if &fingerprint(&src)? != expected {
            bail!("migration source changed");
        }
        let destination = root.join("shares").join(&m.share_id);
        if destination.exists() {
            if &fingerprint(&destination)? != expected {
                bail!("installed root mismatch; recover offline");
            }
        } else {
            let staged = root
                .join("migrations")
                .join(&journal.plan.set_id)
                .join("staged")
                .join(&m.share_id);
            if !staged.exists() {
                copy_tree_checked(&src, &staged, checkpoint)?;
            }
            checkpoint("copy-complete")?;
            if &fingerprint(&staged)? != expected {
                bail!("partial staging; inspect/abandon offline");
            }
            validate_unit(&staged).await?;
            fs::create_dir_all(root.join("shares"))?;
            fs::rename(&staged, &destination)?;
            checkpoint("root-installed")?;
            File::open(root.join("shares"))?.sync_all()?;
            File::open(staged.parent().unwrap())?.sync_all()?;
            checkpoint("root-synced")?;
        }
        if !journal.installed.contains(&m.share_id) {
            journal.installed.push(m.share_id.clone());
        }
        auth_storage::write(&root.join(PENDING), &journal)?;
        checkpoint("progress-written")?;
    }
    if journal.auth_fingerprint != auth_fingerprint(root)? {
        bail!("migration authorization changed before publication");
    }
    for mapping in &journal.plan.mappings {
        let destination = root.join("shares").join(&mapping.share_id);
        if journal.sources.get(&mapping.share_id) != Some(&fingerprint(&destination)?) {
            bail!("installed root changed before publication");
        }
        validate_unit(&destination).await?;
    }
    let next = reviewed_publication(&journal);
    checkpoint("before-publication")?;
    next.validate(root)?;
    auth_storage::write_with_checkpoints(&root.join(AUTHORITY), &next, |point| {
        checkpoint(if point == "before-rename" {
            "manifest-before-rename"
        } else {
            "manifest-after-rename"
        })
    })?;
    checkpoint("publication-written")?;
    journal.committed = true;
    auth_storage::write(&root.join(PENDING), &journal)?;
    checkpoint("completion-written")?;
    finish(root)?;
    checkpoint("journal-removed")
}
fn finish(root: &Path) -> Result<()> {
    fs::remove_file(root.join(PENDING))?;
    File::open(root.join("auth"))?.sync_all()?;
    Ok(())
}
pub fn inspect(root: &Path) -> Result<serde_json::Value> {
    let j: Journal =
        auth_storage::read(&root.join(PENDING))?.ok_or_else(|| anyhow!("no pending migration"))?;
    Ok(
        serde_json::json!({"setId":j.plan.set_id,"reviewDigest":j.digest,"installedCount":j.installed.len(),"committed":j.committed}),
    )
}
/// Only pre-publication journal-owned targets may be abandoned. The manifest remains
/// the sole commit decision; an installed target is never served while this journal exists.
pub fn abandon(root: &Path, confirmation: &str) -> Result<()> {
    let j: Journal =
        auth_storage::read(&root.join(PENDING))?.ok_or_else(|| anyhow!("no pending migration"))?;
    if j.digest != confirmation {
        bail!("reviewed manifest confirmation mismatch");
    }
    let current = Publication::read_for_recovery(root)?;
    if serde_json::to_vec(&current)? != serde_json::to_vec(&j.previous)? {
        bail!(
            "publication may have committed; validate/resume or recover a protected backup offline"
        );
    }
    paths::validate_slug(&j.plan.set_id, "migration set")?;
    for mapping in &j.plan.mappings {
        crate::accounts::validate_id(&mapping.share_id, "s_")?;
        if j.previous
            .as_ref()
            .is_some_and(|p| p.published.contains(&mapping.share_id))
        {
            bail!("journal references existing publication; manual recovery required");
        }
        let destination = root.join("shares").join(&mapping.share_id);
        crate::publication::reject_symlink(&destination)?;
        if destination.exists() {
            fs::remove_dir_all(destination)?;
        }
    }
    if root.join("shares").exists() {
        File::open(root.join("shares"))?.sync_all()?;
    }
    let stage = root.join("migrations").join(&j.plan.set_id);
    crate::publication::reject_symlink(&stage)?;
    if stage.exists() {
        fs::remove_dir_all(stage)?;
        File::open(root.join("migrations"))?.sync_all()?;
    }
    finish(root)
}
pub fn initialize(root: &Path) -> Result<()> {
    if root.join(AUTHORITY).exists()
        || root.join(PENDING).exists()
        || !inventory(root)?.is_empty()
        || (root.join("shares").exists() && fs::read_dir(root.join("shares"))?.next().is_some())
    {
        bail!("nonempty data requires explicit migration/recovery");
    }
    Publication::default().save(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{Capability, Membership, Principal};
    use crate::protocol::RegisterRequest;
    use crate::vault::VaultService;

    async fn fixture(root: &Path, backup: &Path) -> Plan {
        let mut accounts = AccountStore::default();
        let id = accounts.create_share("Synthetic fixture").unwrap();
        let principal = Principal::Oidc {
            issuer: "https://fixture.example.invalid".into(),
            subject: "synthetic".into(),
        };
        accounts.shares[0].members.push(Membership {
            principal: principal.clone(),
            capability: Capability::ReadWrite,
        });
        accounts.save(root).unwrap();
        VaultService::legacy_for_fixture(root.into())
            .register(
                "fixture",
                "notes",
                RegisterRequest {
                    remote_url: String::new(),
                    branch: "main".into(),
                    author_name: "Synthetic".into(),
                    author_email: "fixture@example.invalid".into(),
                },
            )
            .await
            .unwrap();
        copy_tree(root, backup).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(backup, fs::Permissions::from_mode(0o700)).unwrap();
        }
        Plan {
            version: 1,
            set_id: "synthetic-set".into(),
            backup: backup.into(),
            mappings: vec![Mapping {
                user: "fixture".into(),
                vault: "notes".into(),
                share_id: id,
                principals: vec![principal],
                native_enabled: true,
                dav_enabled: true,
            }],
            excluded: vec![],
        }
    }

    #[tokio::test]
    async fn every_interruption_blocks_mixed_startup_and_recovers_or_abandons_owned_staging() {
        for point in [
            "journal-written",
            "copy-file",
            "copy-complete",
            "root-installed",
            "root-synced",
            "progress-written",
            "before-publication",
            "manifest-before-rename",
            "manifest-after-rename",
            "publication-written",
            "completion-written",
            "journal-removed",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join("data");
            let backup = dir.path().join("backup");
            let plan = fixture(&root, &backup).await;
            let source = source(&root, "fixture", "notes").unwrap();
            let before = fingerprint(&source).unwrap();
            let checkpoint = |actual: &str| {
                if actual == point {
                    bail!("synthetic interruption");
                }
                Ok(())
            };
            assert!(
                apply_checked(
                    &root,
                    plan.clone(),
                    "reviewed".into(),
                    "reviewed",
                    &checkpoint
                )
                .await
                .is_err(),
                "{point}"
            );
            assert_eq!(fingerprint(&source).unwrap(), before, "{point}");
            if point == "journal-removed" {
                Publication::load(&root).unwrap().validate(&root).unwrap();
                continue;
            }
            assert!(
                Publication::load(&root).is_err(),
                "pending journal must block startup: {point}"
            );
            if point == "copy-file" {
                assert!(
                    resume(&root).await.is_err(),
                    "partial copy requires explicit abandonment"
                );
                assert!(abandon(&root, "wrong").is_err());
                abandon(&root, "reviewed").unwrap();
                assert!(!root.join(PENDING).exists());
                assert!(!root
                    .join("shares")
                    .join(&plan.mappings[0].share_id)
                    .exists());
                assert_eq!(fingerprint(&source).unwrap(), before);
                continue;
            }
            resume(&root).await.unwrap();
            let publication = Publication::load(&root).unwrap();
            publication.validate(&root).unwrap();
            assert_eq!(publication.mappings.len(), 1);
            assert_eq!(publication.published.len(), 1);
            assert!(publication.activated.is_empty());
            assert!(abandon(&root, "reviewed").is_err());
            assert_eq!(fingerprint(&source).unwrap(), before);
        }
    }

    #[tokio::test]
    async fn each_root_install_in_a_multi_share_set_remains_unpublished_until_recovery() {
        for interrupted_root in [0, 1] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join("data");
            let backup = dir.path().join("backup");
            let mut plan = fixture(&root, &backup).await;
            let mut accounts = AccountStore::load(&root).unwrap();
            let second = accounts.create_share("Second synthetic share").unwrap();
            let member = accounts.shares[0].members[0].clone();
            accounts.shares[1].members.push(member.clone());
            accounts.save(&root).unwrap();
            VaultService::legacy_for_fixture(root.clone())
                .register(
                    "fixture",
                    "second",
                    RegisterRequest {
                        remote_url: String::new(),
                        branch: "main".into(),
                        author_name: "Synthetic".into(),
                        author_email: "fixture@example.invalid".into(),
                    },
                )
                .await
                .unwrap();
            plan.mappings.push(Mapping {
                user: "fixture".into(),
                vault: "second".into(),
                share_id: second,
                principals: vec![member.principal],
                native_enabled: true,
                dav_enabled: true,
            });
            copy_tree(&root, &backup).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&backup, fs::Permissions::from_mode(0o700)).unwrap();
            }
            let installed = std::sync::atomic::AtomicUsize::new(0);
            let checkpoint = |point: &str| {
                if point == "root-installed"
                    && installed.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                        == interrupted_root
                {
                    bail!("synthetic interruption after selected root install");
                }
                Ok(())
            };
            assert!(apply_checked(
                &root,
                plan.clone(),
                "reviewed".into(),
                "reviewed",
                &checkpoint
            )
            .await
            .is_err());
            assert!(Publication::load(&root).is_err());
            assert!(Publication::read_for_recovery(&root).unwrap().is_none());
            resume(&root).await.unwrap();
            let published = Publication::load(&root).unwrap();
            assert_eq!(published.mappings.len(), 2);
            assert_eq!(published.published.len(), 2);
            let before = fs::read(root.join(AUTHORITY)).unwrap();
            assert!(resume(&root).await.is_err());
            assert_eq!(before, fs::read(root.join(AUTHORITY)).unwrap());
            for mapping in &plan.mappings {
                assert_eq!(
                    fingerprint(&source(&root, &mapping.user, &mapping.vault).unwrap()).unwrap(),
                    fingerprint(&root.join("shares").join(&mapping.share_id)).unwrap()
                );
            }
        }
    }

    #[tokio::test]
    async fn verified_backup_restores_prewrite_state_and_postwrite_recovery_requires_reconciliation(
    ) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("data");
        let backup = dir.path().join("backup");
        let restored = dir.path().join("restored");
        let plan = fixture(&root, &backup).await;
        apply(&root, plan.clone(), "reviewed".into(), "reviewed")
            .await
            .unwrap();
        // Rehearse complete backup restoration in another disposable directory, before resumed writes.
        copy_tree(&backup, &restored).unwrap();
        assert_eq!(
            auth_fingerprint(&backup).unwrap(),
            auth_fingerprint(&restored).unwrap()
        );
        assert_eq!(
            fingerprint(&source(&root, "fixture", "notes").unwrap()).unwrap(),
            fingerprint(&source(&restored, "fixture", "notes").unwrap()).unwrap()
        );
        assert!(Publication::read_for_recovery(&restored).unwrap().is_none());
        let share = plan.mappings[0].share_id.clone();
        let before = fingerprint(&root.join("shares").join(&share)).unwrap();
        VaultService::new(root.clone())
            .dav_write(
                "fixture",
                "notes",
                "resumed.md",
                b"synthetic resumed write".to_vec(),
                &crate::vault::dav::DavDevice {
                    client_id: "synthetic".into(),
                    name: "Synthetic".into(),
                },
            )
            .await
            .unwrap();
        assert_ne!(
            before,
            fingerprint(&root.join("shares").join(&share)).unwrap()
        );
        assert!(!source(&restored, "fixture", "notes")
            .unwrap()
            .join("repo/resumed.md")
            .exists());
        // Recovery commands refuse to abandon committed roots or overwrite newer writes.
        assert!(abandon(&root, "reviewed").is_err());
        assert!(apply(&root, plan, "reviewed".into(), "reviewed")
            .await
            .is_err());
        assert!(root
            .join("shares")
            .join(&share)
            .join("repo/resumed.md")
            .exists());
    }

    #[tokio::test]
    async fn backup_approval_exclusion_collision_and_changed_source_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("data");
        let backup = dir.path().join("backup");
        let plan = fixture(&root, &backup).await;
        assert!(apply(&root, plan.clone(), "reviewed".into(), "wrong")
            .await
            .is_err());
        assert!(!root.join(PENDING).exists());
        let mut excluded = plan.clone();
        excluded.excluded.push(Excluded {
            user: "fixture".into(),
            vault: "notes".into(),
        });
        assert!(dry_run(&root, &excluded).await.is_err());
        let source = source(&root, "fixture", "notes").unwrap();
        fs::write(source.join("state.json"), "invalid synthetic state").unwrap();
        assert!(dry_run(&root, &plan).await.is_err());
        fs::copy(
            backup.join("users/fixture/vaults/notes/state.json"),
            source.join("state.json"),
        )
        .unwrap();
        let checkpoint = |point: &str| {
            if point == "journal-written" {
                bail!("synthetic interruption");
            }
            Ok(())
        };
        assert!(
            apply_checked(&root, plan, "reviewed".into(), "reviewed", &checkpoint)
                .await
                .is_err()
        );
        fs::write(source.join("unexpected"), "synthetic change").unwrap();
        assert!(resume(&root).await.is_err());
        assert!(Publication::load(&root).is_err());
        abandon(&root, "reviewed").unwrap();
        assert!(source.join("unexpected").exists());
    }

    #[tokio::test]
    async fn unsafe_schema_links_targets_and_capacity_are_rejected_before_journaling() {
        for fault in ["schema", "symlink", "target", "duplicate", "capacity"] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join("data");
            let backup = dir.path().join("backup");
            let mut plan = fixture(&root, &backup).await;
            match fault {
                "schema" => {
                    for base in [&root, &backup] {
                        fs::write(
                            source(base, "fixture", "notes")
                                .unwrap()
                                .join("devices.json"),
                            b"invalid synthetic schema",
                        )
                        .unwrap();
                    }
                }
                "symlink" => {
                    #[cfg(unix)]
                    {
                        let outside = dir.path().join("outside");
                        fs::write(&outside, b"synthetic outside").unwrap();
                        for base in [&root, &backup] {
                            std::os::unix::fs::symlink(
                                &outside,
                                source(base, "fixture", "notes").unwrap().join("escape"),
                            )
                            .unwrap();
                        }
                    }
                }
                "target" => {
                    fs::create_dir_all(root.join("shares").join(&plan.mappings[0].share_id))
                        .unwrap()
                }
                "duplicate" => plan.mappings.push(plan.mappings[0].clone()),
                "capacity" => {
                    assert!(capacity(&root, u64::MAX).is_err());
                    assert!(!root.join(PENDING).exists());
                    continue;
                }
                _ => unreachable!(),
            }
            assert!(dry_run(&root, &plan).await.is_err(), "{fault}");
            assert!(!root.join(PENDING).exists(), "{fault}");
            assert!(
                Publication::read_for_recovery(&root).unwrap().is_none(),
                "{fault}"
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dangling_recovery_journal_link_is_corruption_and_never_allows_startup() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("data");
        AccountStore::default().save(&root).unwrap();
        initialize(&root).unwrap();
        std::os::unix::fs::symlink(dir.path().join("missing"), root.join(PENDING)).unwrap();
        assert!(Publication::load(&root).is_err());
    }

    #[tokio::test]
    async fn later_sets_verify_backups_of_existing_shares_and_cannot_remap_published_namespaces() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("data");
        let backup = dir.path().join("backup");
        let initial = fixture(&root, &backup).await;
        apply(&root, initial.clone(), "reviewed".into(), "reviewed")
            .await
            .unwrap();
        let mut accounts = AccountStore::load(&root).unwrap();
        let new_id = accounts.create_share("Later synthetic share").unwrap();
        let member = accounts.shares[0].members[0].clone();
        accounts.shares[1].members.push(member.clone());
        accounts.save(&root).unwrap();
        VaultService::legacy_for_fixture(root.clone())
            .register(
                "fixture",
                "later",
                RegisterRequest {
                    remote_url: String::new(),
                    branch: "main".into(),
                    author_name: "Synthetic".into(),
                    author_email: "fixture@example.invalid".into(),
                },
            )
            .await
            .unwrap();
        copy_tree(&root, &backup).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&backup, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let later = Plan {
            version: 1,
            set_id: "later-set".into(),
            backup: backup.clone(),
            mappings: vec![Mapping {
                user: "fixture".into(),
                vault: "later".into(),
                share_id: new_id,
                principals: vec![member.principal],
                native_enabled: true,
                dav_enabled: true,
            }],
            excluded: vec![],
        };
        dry_run(&root, &later).await.unwrap();
        let mut collision = later.clone();
        collision.mappings[0].vault = "notes".into();
        assert!(dry_run(&root, &collision).await.is_err());
        let old_backup = backup.join("shares").join(&initial.mappings[0].share_id);
        fs::write(
            old_backup.join("unexpected"),
            b"synthetic backup corruption",
        )
        .unwrap();
        assert!(dry_run(&root, &later).await.is_err());
        fs::remove_dir_all(old_backup).unwrap();
        assert!(dry_run(&root, &later).await.is_err());
        assert!(!root.join(PENDING).exists());
        Publication::load(&root).unwrap().validate(&root).unwrap();
    }

    #[tokio::test]
    async fn committed_recovery_refuses_changed_manifest_or_installed_bytes() {
        for fault in ["manifest", "storage"] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join("data");
            let backup = dir.path().join("backup");
            let plan = fixture(&root, &backup).await;
            let checkpoint = |point: &str| {
                if point == "manifest-after-rename" {
                    bail!("synthetic interruption");
                }
                Ok(())
            };
            assert!(apply_checked(
                &root,
                plan.clone(),
                "reviewed".into(),
                "reviewed",
                &checkpoint
            )
            .await
            .is_err());
            if fault == "manifest" {
                let mut committed = Publication::read_for_recovery(&root).unwrap().unwrap();
                committed.generation += 1;
                auth_storage::write(&root.join(AUTHORITY), &committed).unwrap();
            } else {
                fs::write(
                    root.join("shares")
                        .join(&plan.mappings[0].share_id)
                        .join("unexpected"),
                    b"synthetic changed installation",
                )
                .unwrap();
            }
            assert!(resume(&root).await.is_err(), "{fault}");
            assert!(root.join(PENDING).exists());
            assert!(Publication::load(&root).is_err());
            assert!(abandon(&root, "reviewed").is_err());
        }
    }
}
