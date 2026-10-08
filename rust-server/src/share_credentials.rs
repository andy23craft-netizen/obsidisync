//! Immutable share grants; publication owns the separate, explicit activated-ID set.
use crate::accounts::{
    opaque_id, validate_id, validate_label, AccountStore, Capability, Principal,
};
use crate::auth_storage;
use crate::device_passwords::validate_device_folder;
use crate::time_format::unix_now;
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::Path;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Credential {
    pub id: String,
    pub share_id: String,
    pub folder: String,
    pub capability: Capability,
    pub creator: Principal,
    pub label: String,
    pub password_hash: String,
    pub created_at: u64,
    pub kind: String,
    pub lifecycle: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotation_actor: Option<Principal>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Store {
    pub version: u32,
    pub credentials: Vec<Credential>,
}
impl Default for Store {
    fn default() -> Self {
        Self {
            version: 1,
            credentials: vec![],
        }
    }
}
impl Store {
    pub fn load(root: &Path) -> Result<Self> {
        let store: Self =
            auth_storage::read(&root.join("auth/share-device-passwords.json"))?.unwrap_or_default();
        store.validate(&AccountStore::load(root)?).map_err(|_| {
            anyhow!("auth store contains corrupt or unsupported staged credential records")
        })?;
        Ok(store)
    }
    pub fn save(&self, root: &Path) -> Result<()> {
        self.validate(&AccountStore::load(root)?)?;
        auth_storage::write(&root.join("auth/share-device-passwords.json"), self)
    }
    fn validate(&self, accounts: &AccountStore) -> Result<()> {
        if self.version != 1 {
            bail!("unsupported staged credential store version");
        }
        let mut ids = HashSet::new();
        for c in &self.credentials {
            validate_id(&c.id, "c_")?;
            if !ids.insert(&c.id)
                || c.lifecycle != "staged"
                || c.kind != "webdav"
                || !accounts.shares.iter().any(|s| s.id == c.share_id)
                || c.password_hash.len() != 64
                || !c.password_hash.bytes().all(|b| b.is_ascii_hexdigit())
            {
                bail!("invalid staged credential record");
            }
            accounts.validate_principal(&c.creator)?;
            if let Some(actor) = &c.rotation_actor {
                accounts.validate_principal(actor)?;
            }
            validate_device_folder(&c.folder)?;
            validate_label(&c.label)?;
        }
        Ok(())
    }
    pub fn create(
        &mut self,
        accounts: &AccountStore,
        share: &str,
        creator: Principal,
        folder: &str,
        capability: Capability,
        label: &str,
    ) -> Result<(String, String)> {
        if !accounts
            .capability(share, &creator)
            .is_some_and(|c| c.permits(capability))
        {
            bail!("creator lacks required share capability");
        }
        validate_label(label)?;
        let folder = validate_device_folder(folder)?;
        let id = opaque_id("c_")?;
        let secret = generate_secret()?;
        self.credentials.push(Credential {
            id: id.clone(),
            share_id: share.to_string(),
            folder,
            capability,
            creator,
            label: label.to_string(),
            password_hash: hash_secret(&secret),
            created_at: unix_now(),
            kind: "webdav".into(),
            lifecycle: "staged".into(),
            rotation_actor: None,
        });
        Ok((id, secret))
    }
    pub fn rotate(&mut self, id: &str) -> Result<String> {
        let c = self
            .credentials
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or_else(|| anyhow!("credential not found"))?;
        let secret = generate_secret()?;
        c.password_hash = hash_secret(&secret);
        Ok(secret)
    }
    pub fn revoke(&mut self, id: &str) -> Result<()> {
        let before = self.credentials.len();
        self.credentials.retain(|c| c.id != id);
        if before == self.credentials.len() {
            bail!("credential not found");
        }
        Ok(())
    }
    pub fn rotate_as(&mut self, id: &str, actor: Principal) -> Result<String> {
        let secret = self.rotate(id)?;
        self.credentials
            .iter_mut()
            .find(|c| c.id == id)
            .unwrap()
            .rotation_actor = Some(actor);
        Ok(secret)
    }
}
fn generate_secret() -> Result<String> {
    opaque_id("staged_")
}
fn hash_secret(secret: &str) -> String {
    format!("{:x}", Sha256::digest(secret.as_bytes()))
}
