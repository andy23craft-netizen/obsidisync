//! Offline publication authority. Auth stores remain independent sources of identity/grants.
use crate::accounts::{validate_id, AccountStore, Capability, Principal};
use crate::{auth_storage, paths};
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub const AUTHORITY: &str = "auth/share-publication.json";
pub const PENDING: &str = "auth/share-migration-pending.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mapping {
    pub user: String,
    pub vault: String,
    pub share_id: String,
    pub principals: Vec<Principal>,
    pub native_enabled: bool,
    pub dav_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Publication {
    pub version: u32,
    pub generation: u64,
    pub set_id: String,
    pub published: Vec<String>,
    pub retired: Vec<String>,
    pub mappings: Vec<Mapping>,
    pub activated: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compatibility_cutoff: Option<crate::compatibility::Review>,
}
impl Default for Publication {
    fn default() -> Self {
        Self {
            version: 1,
            generation: 0,
            set_id: "initial".into(),
            published: vec![],
            retired: vec![],
            mappings: vec![],
            activated: vec![],
            compatibility_cutoff: None,
        }
    }
}
impl Publication {
    pub fn load(root: &Path) -> Result<Self> {
        paths::reject_storage_links(&root.join(PENDING))?;
        if root.join(PENDING).exists() {
            bail!("publication pending; recover offline before startup");
        }
        let value: Self = auth_storage::read(&root.join(AUTHORITY))?
            .ok_or_else(|| anyhow!("publication missing; initialize or migrate offline"))?;
        value.validate_references(root, false)?;
        Ok(value)
    }
    pub fn read_for_recovery(root: &Path) -> Result<Option<Self>> {
        auth_storage::read(&root.join(AUTHORITY))
    }
    pub fn validate(&self, root: &Path) -> Result<()> {
        self.validate_references(root, true)
    }
    fn validate_references(&self, root: &Path, inspect_storage: bool) -> Result<()> {
        if self.version != 1 {
            bail!("unsupported publication schema");
        }
        let accounts = AccountStore::load(root)?;
        let mut ids = HashSet::new();
        for id in &self.published {
            validate_id(id, "s_")?;
            if !ids.insert(id) || !accounts.shares.iter().any(|s| &s.id == id) {
                bail!("invalid published share reference");
            }
            if !inspect_storage {
                continue;
            }
            let share = root.join("shares").join(id);
            reject_symlink(&share)?;
            reject_symlink(&share.join("repo"))?;
            reject_symlink(&share.join("repo/.git"))?;
            if !share.join("state.json").is_file() || !share.join("repo/.git").is_dir() {
                bail!("incomplete published share");
            }
            reject_symlink(&share.join("state.json"))?;
            let state: crate::vault::VaultState =
                serde_json::from_slice(&std::fs::read(share.join("state.json"))?)?;
            paths::validate_slug(&state.user, "stored user")?;
            paths::validate_slug(&state.vault, "stored vault")?;
            paths::validate_git_branch(&state.branch)?;
        }
        let mut retired = HashSet::new();
        for id in &self.retired {
            if !ids.contains(id) || !retired.insert(id) {
                bail!("invalid retired share reference");
            }
        }
        let mut aliases = HashSet::new();
        let mut targets = HashSet::new();
        for m in &self.mappings {
            paths::validate_slug(&m.user, "user")?;
            if crate::auth::normalize_user_claim(&m.user)? != m.user {
                bail!("legacy mapping requires the original canonical authentication namespace");
            }
            paths::validate_slug(&m.vault, "vault")?;
            if !ids.contains(&m.share_id)
                || !aliases.insert((&m.user, &m.vault))
                || !targets.insert(&m.share_id)
            {
                bail!("invalid compatibility mapping");
            }
            let mut principals = HashSet::new();
            for p in &m.principals {
                accounts.validate_principal(p)?;
                if !principals.insert(p) {
                    bail!("duplicate mapped principal");
                }
            }
            if m.principals.is_empty() {
                bail!("mapping requires reviewed typed principals");
            }
        }
        let credentials = crate::share_credentials::Store::load(root)?;
        let mut active = HashSet::new();
        for id in &self.activated {
            let grant = credentials
                .credentials
                .iter()
                .find(|c| &c.id == id)
                .ok_or_else(|| anyhow!("dangling activated grant; recover offline"))?;
            if !active.insert(id)
                || !ids.contains(&grant.share_id)
                || self.mappings.iter().any(|m| {
                    m.dav_enabled
                        && crate::auth::normalize_user_claim(&m.user)
                            .is_ok_and(|user| user == grant.share_id)
                })
            {
                bail!("invalid or ambiguous activated grant");
            }
        }
        Ok(())
    }
    pub fn save(&self, root: &Path) -> Result<()> {
        self.validate(root)?;
        auth_storage::write(&root.join(AUTHORITY), self)
    }
    pub fn available(&self, share: &str) -> bool {
        self.published.iter().any(|s| s == share) && !self.retired.iter().any(|s| s == share)
    }
    pub fn mapping(&self, user: &str, vault: &str) -> Result<&Mapping> {
        self.mappings
            .iter()
            .find(|m| m.user == user && m.vault == vault && self.available(&m.share_id))
            .ok_or_else(|| anyhow!("not found: share"))
    }
    pub fn resolve_storage(&self, user: &str, vault: &str) -> Result<String> {
        Ok(self.mapping(user, vault)?.share_id.clone())
    }
    pub fn authorize(
        &self,
        root: &Path,
        share: &str,
        principal: &Principal,
        requested: Capability,
    ) -> Result<()> {
        if !self.available(share) {
            bail!("not found: share");
        }
        let capability = AccountStore::load(root)?
            .capability(share, principal)
            .ok_or_else(|| anyhow!("not found: share"))?;
        if !capability.permits(requested) {
            bail!("forbidden: capability");
        }
        Ok(())
    }
    pub fn authorize_legacy(
        &self,
        root: &Path,
        user: &str,
        vault: &str,
        principal: &Principal,
        requested: Capability,
    ) -> Result<String> {
        let m = self.mapping(user, vault)?;
        if !m.principals.contains(principal) {
            bail!("not found: share");
        }
        self.authorize(root, &m.share_id, principal, requested)?;
        if !m.native_enabled {
            bail!("gone: compatibility retired");
        }
        Ok(m.share_id.clone())
    }
    pub fn legacy_grant(&self, user: &str, vault: &str) -> Result<String> {
        let m = self.mapping(user, vault)?;
        if !m.dav_enabled {
            bail!("gone: compatibility retired");
        }
        Ok(m.share_id.clone())
    }
    pub fn legacy_device(
        &self,
        user: &str,
        vault: &str,
        id: &str,
        protocol: &str,
    ) -> Result<String> {
        let share = self.legacy_grant(user, vault)?;
        if self.compatibility_cutoff.as_ref().is_some_and(|review| {
            !review.consumers.iter().any(|c| {
                c.retain && c.share_id == share && c.client == id && c.protocol == protocol
            })
        }) {
            bail!("unauthorized: compatibility grant not retained");
        }
        Ok(share)
    }
    pub fn root(&self, data: &Path, user: &str, vault: &str) -> Result<PathBuf> {
        let root = data.join("shares").join(self.resolve_storage(user, vault)?);
        reject_symlink(&root)?;
        Ok(root)
    }
}

pub fn reject_symlink(path: &Path) -> Result<()> {
    paths::reject_storage_links(path)
}
