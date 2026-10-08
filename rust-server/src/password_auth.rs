use crate::accounts::Accounts;
use crate::app_session::{AppSession, AppSessionStore, VerifiedSession};
use crate::auth::normalize_user_claim;
use anyhow::{anyhow, bail, Result};
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use std::path::PathBuf;
use tokio::sync::Mutex;

#[derive(Debug)]
pub struct PasswordAuth {
    accounts: Accounts,
    sessions: AppSessionStore,
    dummy_hash: String,
    lock: Mutex<()>,
}
pub type PasswordAuthSession = AppSession;

impl PasswordAuth {
    pub fn new(
        _user: String,
        data_dir: impl Into<PathBuf>,
        _setup_token: Option<String>,
    ) -> Result<Self> {
        let root = data_dir.into();
        let accounts = Accounts::new(root.clone());
        accounts.require_import()?;
        Ok(Self {
            accounts,
            sessions: AppSessionStore::new(root),
            dummy_hash: hash_password("reserved-invalid-login-check")?,
            lock: Mutex::new(()),
        })
    }
    pub async fn is_configured(&self) -> Result<bool> {
        Ok(self.accounts.load()?.accounts.iter().any(|a| a.enabled))
    }
    pub fn setup_token_is_required(&self) -> bool {
        false
    }
    pub async fn setup_password(&self, _: &str, _: &str, _: Option<&str>) -> Result<AppSession> {
        bail!("public password setup is retired; use host-local administration")
    }
    pub async fn login(&self, username: &str, password: &str) -> Result<AppSession> {
        let _guard = self.lock.lock().await;
        let store = self.accounts.load()?;
        if !store.accounts.iter().any(|a| a.enabled) {
            bail!("local login unavailable; ask the server operator to create or enable a local account");
        }
        let user = normalize_user_claim(username).ok();
        let account = store
            .accounts
            .iter()
            .find(|a| Some(&a.user) == user.as_ref());
        // Unknown and disabled usernames also pay the hash-verification cost.
        let hash = account
            .map(|a| a.password_hash.as_str())
            .unwrap_or(&self.dummy_hash);
        let valid = verify_password(password, hash)?;
        let account = account.filter(|a| a.enabled && valid);
        let Some(account) = account else {
            bail!("invalid username or password");
        };
        self.sessions
            .issue_local(account.user.clone(), account.id.clone())
            .await
    }
    pub async fn verify_token(&self, token: &str) -> Result<VerifiedSession> {
        let session = self.sessions.verify_access_token(token).await?;
        if !session.local_v1
            || !self
                .accounts
                .load()?
                .accounts
                .iter()
                .any(|a| a.id == session.subject && a.user == session.user)
        {
            bail!("invalid bearer token identity; log in again");
        }
        Ok(session)
    }
    pub async fn refresh_session(&self, refresh_token: &str) -> Result<AppSession> {
        self.sessions
            .refresh_local(refresh_token, |user, subject| async move {
                if self
                    .accounts
                    .load()?
                    .accounts
                    .iter()
                    .any(|a| a.id == subject && a.user == user && a.enabled)
                {
                    Ok(())
                } else {
                    bail!("invalid refresh token")
                }
            })
            .await
    }
}
pub fn validate_hash(hash: &str) -> Result<()> {
    let parsed = PasswordHash::new(hash).map_err(|_| anyhow!("stored password hash is invalid"))?;
    if !matches!(
        parsed.algorithm.as_str(),
        "argon2id" | "argon2i" | "argon2d"
    ) || parsed.salt.is_none()
        || parsed.hash.is_none()
    {
        bail!("stored password hash is invalid");
    }
    argon2::Params::try_from(&parsed)
        .map_err(|_| anyhow!("stored password parameters are invalid"))?;
    if let Some(version) = parsed.version {
        argon2::Version::try_from(version)
            .map_err(|_| anyhow!("stored password version is invalid"))?;
    }
    Ok(())
}
pub fn hash_password(password: &str) -> Result<String> {
    if password.len() < 12 {
        bail!("password must be at least 12 bytes");
    }
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| anyhow!("random generator failed"))?;
    let salt =
        SaltString::encode_b64(&bytes).map_err(|_| anyhow!("password salt generation failed"))?;
    Ok(Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|_| anyhow!("password hashing failed"))?
        .to_string())
}
fn verify_password(password: &str, hash: &str) -> Result<bool> {
    let hash = PasswordHash::new(hash).map_err(|_| anyhow!("stored password hash is invalid"))?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &hash)
        .is_ok())
}
