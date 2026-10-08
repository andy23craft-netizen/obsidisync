//! Identity and membership configuration. This module never resolves document storage.
use crate::auth::normalize_user_claim;
use crate::auth_storage;
use crate::password_auth::{hash_password, validate_hash};
use crate::time_format::unix_now;
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Principal {
    Local { account_id: String },
    Oidc { issuer: String, subject: String },
    Development { user: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Capability {
    Read,
    ReadWrite,
}
impl Capability {
    pub fn permits(self, requested: Self) -> bool {
        self == Self::ReadWrite || requested == Self::Read
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Account {
    pub id: String,
    pub user: String,
    pub enabled: bool,
    pub password_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Membership {
    pub principal: Principal,
    pub capability: Capability,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Share {
    pub id: String,
    pub label: String,
    pub created_at: u64,
    pub members: Vec<Membership>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyImport {
    pub user: String,
    pub account_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountStore {
    pub version: u32,
    pub accounts: Vec<Account>,
    pub shares: Vec<Share>,
    pub legacy_import: Option<LegacyImport>,
}

impl Default for AccountStore {
    fn default() -> Self {
        Self {
            version: 1,
            accounts: vec![],
            shares: vec![],
            legacy_import: None,
        }
    }
}

impl AccountStore {
    pub fn load(root: &Path) -> Result<Self> {
        let store: Self = auth_storage::read(&root.join("auth/accounts.json"))?.unwrap_or_default();
        store.validate().map_err(|_| {
            anyhow!("auth store is corrupt or unsupported; restore a protected backup offline")
        })?;
        Ok(store)
    }
    pub fn save(&self, root: &Path) -> Result<()> {
        self.validate()?;
        auth_storage::write(&root.join("auth/accounts.json"), self)
    }
    pub fn validate(&self) -> Result<()> {
        if self.version != 1 {
            bail!("unsupported account store version");
        }
        let mut ids = HashSet::new();
        let mut users = HashSet::new();
        for account in &self.accounts {
            validate_id(&account.id, "p_")?;
            crate::paths::validate_slug(&account.user, "user")?;
            if normalize_user_claim(&account.user)? != account.user
                || !users.insert(&account.user)
                || !ids.insert(&account.id)
            {
                bail!("invalid or duplicate account identity");
            }
            validate_hash(&account.password_hash)?;
        }
        let mut shares = HashSet::new();
        for share in &self.shares {
            validate_id(&share.id, "s_")?;
            validate_label(&share.label)?;
            if !shares.insert(&share.id) {
                bail!("duplicate share identity");
            }
            let mut members = HashSet::new();
            for member in &share.members {
                self.validate_principal(&member.principal)?;
                if !members.insert(&member.principal) {
                    bail!("duplicate membership");
                }
            }
        }
        if let Some(import) = &self.legacy_import {
            if normalize_user_claim(&import.user)? != import.user {
                bail!("invalid import namespace");
            }
            if let Some(id) = &import.account_id {
                if !self
                    .accounts
                    .iter()
                    .any(|a| &a.id == id && a.user == import.user)
                {
                    bail!("invalid legacy import mapping");
                }
            }
        }
        Ok(())
    }
    pub fn validate_principal(&self, principal: &Principal) -> Result<()> {
        match principal {
            Principal::Development { user } => {
                crate::paths::validate_slug(user, "development user")?;
                if normalize_user_claim(user)? != *user {
                    bail!("development identity must use its canonical configured namespace");
                }
                Ok(())
            }
            Principal::Local { account_id }
                if self.accounts.iter().any(|a| &a.id == account_id) =>
            {
                Ok(())
            }
            Principal::Oidc { issuer, subject } => {
                let url = url::Url::parse(issuer).map_err(|_| anyhow!("invalid OIDC issuer"))?;
                if (url.scheme() != "https"
                    && !(url.scheme() == "http"
                        && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))))
                    || subject.trim().is_empty()
                {
                    bail!("invalid OIDC identity");
                }
                Ok(())
            }
            _ => bail!("unknown local principal"),
        }
    }
    pub fn capability(&self, share_id: &str, principal: &Principal) -> Option<Capability> {
        if let Principal::Local { account_id } = principal {
            if !self
                .accounts
                .iter()
                .any(|a| &a.id == account_id && a.enabled)
            {
                return None;
            }
        }
        self.shares
            .iter()
            .find(|s| s.id == share_id)?
            .members
            .iter()
            .find(|m| &m.principal == principal)
            .map(|m| m.capability)
    }
    pub fn create_account(&mut self, username: &str, password: &str) -> Result<String> {
        let user = normalize_user_claim(username)?;
        crate::paths::validate_slug(&user, "user")?;
        if self.accounts.iter().any(|a| a.user == user) {
            bail!("username already reserved");
        }
        let id = opaque_id("p_")?;
        self.accounts.push(Account {
            id: id.clone(),
            user,
            enabled: true,
            password_hash: hash_password(password)?,
        });
        Ok(id)
    }
    pub fn create_share(&mut self, label: &str) -> Result<String> {
        validate_label(label)?;
        let id = opaque_id("s_")?;
        self.shares.push(Share {
            id: id.clone(),
            label: label.to_string(),
            created_at: unix_now(),
            members: vec![],
        });
        Ok(id)
    }
}

pub fn validate_label(label: &str) -> Result<()> {
    if label.trim().is_empty() || label.len() > 120 || label.chars().any(char::is_control) {
        bail!("invalid display label");
    }
    Ok(())
}
pub fn opaque_id(prefix: &str) -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| anyhow!("random generator failed"))?;
    Ok(format!(
        "{prefix}{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}
pub fn validate_id(id: &str, prefix: &str) -> Result<()> {
    if !id.starts_with(prefix)
        || id.len() != prefix.len() + 32
        || !id[prefix.len()..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        bail!("invalid opaque identifier");
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyStore {
    user: String,
    password_hash: Option<String>,
    #[serde(default)]
    sessions: Vec<LegacySession>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacySession {
    token_hash: String,
    created_at: u64,
}

pub fn import_legacy(
    root: &Path,
    expected_user: Option<&str>,
    dry_run: bool,
) -> Result<LegacyImport> {
    let legacy: LegacyStore = auth_storage::read(&root.join("auth/password.json"))?
        .ok_or_else(|| anyhow!("no legacy password store"))?;
    if normalize_user_claim(&legacy.user)? != legacy.user
        || expected_user
            .map(normalize_user_claim)
            .transpose()?
            .is_some_and(|u| u != legacy.user)
    {
        bail!("legacy namespace mismatch; review configuration offline");
    }
    crate::paths::validate_slug(&legacy.user, "user")?;
    for session in &legacy.sessions {
        if session.token_hash.len() != 64 || session.created_at == 0 {
            bail!("invalid legacy session record");
        }
    }
    if let Some(hash) = &legacy.password_hash {
        validate_hash(hash)?;
    }
    let mut store = AccountStore::load(root)?;
    if let Some(import) = &store.legacy_import {
        if import.user != legacy.user
            || import.account_id.as_ref().is_some_and(|id| {
                !store
                    .accounts
                    .iter()
                    .any(|a| &a.id == id && Some(&a.password_hash) == legacy.password_hash.as_ref())
            })
        {
            bail!("legacy import conflicts with destination");
        }
        return Ok(import.clone());
    }
    if !store.accounts.is_empty() {
        bail!("destination accounts already exist; refusing legacy import");
    }
    let account_id = if let Some(hash) = legacy.password_hash {
        let id = opaque_id("p_")?;
        store.accounts.push(Account {
            id: id.clone(),
            user: legacy.user.clone(),
            enabled: true,
            password_hash: hash,
        });
        Some(id)
    } else {
        None
    };
    let import = LegacyImport {
        user: legacy.user,
        account_id,
    };
    store.legacy_import = Some(import.clone());
    if !dry_run {
        store.save(root)?;
    }
    Ok(import)
}

#[derive(Debug)]
pub struct Accounts {
    root: PathBuf,
}
impl Accounts {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
    pub fn load(&self) -> Result<AccountStore> {
        AccountStore::load(&self.root)
    }
    pub fn require_import(&self) -> Result<()> {
        let store = self.load()?;
        if self.root.join("auth/password.json").try_exists()? && store.legacy_import.is_none() {
            bail!("legacy password store requires offline admin auth import-legacy before password startup");
        }
        Ok(())
    }
}
