//! Network device grants: legacy aliases and explicit active share grants never become sessions.
use crate::device_passwords::{DeviceGrant, DeviceKind};
use crate::http::AppState;
use anyhow::{anyhow, bail, Result};
use sha2::{Digest, Sha256};

pub async fn authenticate(
    state: &AppState,
    username: Option<&str>,
    secret: &str,
) -> Result<DeviceGrant> {
    if !state.vaults.uses_published_storage() {
        return match username {
            Some(u) => state.device_passwords.authenticate(u, secret).await,
            None => state.device_passwords.authenticate_bearer(secret).await,
        };
    }
    let publication = state.vaults.publication()?;
    let store = crate::share_credentials::Store::load(&state.vaults.data_dir)?;
    let hash = format!("{:x}", Sha256::digest(secret.trim().as_bytes()));
    let active: Vec<_> = store
        .credentials
        .iter()
        .filter(|c| {
            publication.activated.contains(&c.id)
                && publication.available(&c.share_id)
                && username.is_none_or(|u| u == c.share_id)
                && constant_time_eq(&hash, &c.password_hash)
        })
        .collect();
    let legacy = state
        .device_passwords
        .authenticate_published(username, secret)
        .await;
    if active.len() + usize::from(legacy.is_ok()) != 1 {
        bail!("unauthorized");
    }
    if let Ok(grant) = legacy {
        let mapping = publication.mapping(&grant.user, &grant.vault)?;
        crate::compatibility::record(&state.vaults.data_dir, mapping, "dav", &grant.id)?;
        return Ok(grant);
    }
    let c = active.first().ok_or_else(|| anyhow!("unauthorized"))?;
    crate::compatibility::record_share_grant(&state.vaults.data_dir, &c.id)?;
    Ok(DeviceGrant {
        id: c.id.clone(),
        user: c.share_id.clone(),
        vault: c.share_id.clone(),
        folder: c.folder.clone(),
        label: c.label.clone(),
        kind: DeviceKind::Webdav,
        saber: None,
    })
}
pub fn share_id(
    state: &AppState,
    grant: &DeviceGrant,
) -> Result<(String, crate::accounts::Capability, bool)> {
    let publication = state.vaults.publication()?;
    let store = crate::share_credentials::Store::load(&state.vaults.data_dir)?;
    if let Some(c) = store
        .credentials
        .iter()
        .find(|c| c.id == grant.id && c.share_id == grant.user)
    {
        if !publication.available(&c.share_id)
            || !publication.activated.contains(&c.id)
            || c.folder != grant.folder
        {
            bail!("not found: share");
        }
        Ok((c.share_id.clone(), c.capability, true))
    } else {
        Ok((
            publication.legacy_device(&grant.user, &grant.vault, &grant.id, "dav")?,
            crate::accounts::Capability::ReadWrite,
            false,
        ))
    }
}
pub async fn recheck_legacy(
    service: &crate::vault::VaultService,
    grant: &DeviceGrant,
) -> Result<()> {
    let devices = crate::device_passwords::DevicePasswordStore::new(&service.data_dir);
    if !devices.grant_is_live(grant).await? {
        bail!("unauthorized: credential revoked");
    }
    if service.uses_published_storage() {
        let share =
            service
                .publication()?
                .legacy_device(&grant.user, &grant.vault, &grant.id, "saber")?;
        if service.storage_root(&grant.user, &grant.vault)?
            != service.data_dir.join("shares").join(share)
        {
            bail!("not found: legacy worker share boundary");
        }
    }
    Ok(())
}
fn constant_time_eq(a: &str, b: &str) -> bool {
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        diff |= (*a.as_bytes().get(i).unwrap_or(&0) ^ *b.as_bytes().get(i).unwrap_or(&0)) as usize;
    }
    diff == 0
}
/// Revocation waits for operations already authorized; queued operations recheck after
/// acquiring this lease. Once revocation returns, no cached grant can publish output.
pub fn operation_lock(root: &std::path::Path) -> std::sync::Arc<tokio::sync::RwLock<()>> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static LOCKS: OnceLock<
        Mutex<HashMap<std::path::PathBuf, std::sync::Arc<tokio::sync::RwLock<()>>>>,
    > = OnceLock::new();
    LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("grant lock poisoned")
        .entry(root.to_path_buf())
        .or_insert_with(|| std::sync::Arc::new(tokio::sync::RwLock::new(())))
        .clone()
}
