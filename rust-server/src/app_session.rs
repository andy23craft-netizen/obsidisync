use anyhow::{anyhow, bail, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

const ACCESS_TOKEN_TTL_SECONDS: u64 = 24 * 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS: u64 = 180 * 24 * 60 * 60;
const MAX_SESSIONS: usize = 100;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSession {
    pub user: String,
    pub subject: String,
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
    pub refresh_expires_in: u64,
}

#[derive(Debug, Clone)]
pub struct VerifiedSession {
    pub user: String,
    pub subject: String,
    pub local_v1: bool,
}

#[derive(Debug)]
pub struct AppSessionStore {
    store_path: PathBuf,
    lock: Mutex<()>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionStore {
    sessions: Vec<SessionRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionRecord {
    user: String,
    subject: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    identity_version: Option<String>,
    access_token_hash: String,
    refresh_token_hash: String,
    access_expires_at: u64,
    refresh_expires_at: u64,
    created_at: u64,
    refreshed_at: u64,
}

impl AppSessionStore {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            store_path: data_dir.into().join("auth/sessions.json"),
            lock: Mutex::new(()),
        }
    }

    pub async fn issue(&self, user: String, subject: String) -> Result<AppSession> {
        self.issue_inner(user, subject, None).await
    }

    pub async fn issue_local(&self, user: String, subject: String) -> Result<AppSession> {
        self.issue_inner(user, subject, Some("local-v1".to_string()))
            .await
    }

    async fn issue_inner(
        &self,
        user: String,
        subject: String,
        identity_version: Option<String>,
    ) -> Result<AppSession> {
        let _guard = self.lock.lock().await;
        let mut store = self.read_store().await?;
        let session = new_session(user, subject, identity_version)?;
        store.sessions.push(session.record.clone());
        prune_sessions(&mut store);
        self.write_store(&store).await?;
        Ok(session.session)
    }

    pub async fn verify_access_token(&self, token: &str) -> Result<VerifiedSession> {
        let store = self.read_store().await?;
        let token_hash = hash_token(token);
        let now = unix_now();
        let record = store
            .sessions
            .iter()
            .find(|session| constant_time_eq(&session.access_token_hash, &token_hash))
            .ok_or_else(|| anyhow!("invalid bearer token"))?;
        if record.access_expires_at <= now {
            bail!("expired bearer token");
        }
        Ok(VerifiedSession {
            user: record.user.clone(),
            subject: record.subject.clone(),
            local_v1: record.identity_version.as_deref() == Some("local-v1"),
        })
    }

    pub async fn refresh<F, Fut>(&self, refresh_token: &str, authorize: F) -> Result<AppSession>
    where
        F: FnOnce(String, String) -> Fut,
        Fut: std::future::Future<Output = Result<()>>,
    {
        self.refresh_inner(refresh_token, None, authorize).await
    }

    pub async fn refresh_local<F, Fut>(
        &self,
        refresh_token: &str,
        authorize: F,
    ) -> Result<AppSession>
    where
        F: FnOnce(String, String) -> Fut,
        Fut: std::future::Future<Output = Result<()>>,
    {
        self.refresh_inner(refresh_token, Some("local-v1"), authorize)
            .await
    }

    async fn refresh_inner<F, Fut>(
        &self,
        refresh_token: &str,
        required_kind: Option<&str>,
        authorize: F,
    ) -> Result<AppSession>
    where
        F: FnOnce(String, String) -> Fut,
        Fut: std::future::Future<Output = Result<()>>,
    {
        let _guard = self.lock.lock().await;
        let mut store = self.read_store().await?;
        let token_hash = hash_token(refresh_token);
        let now = unix_now();
        let index = store
            .sessions
            .iter()
            .position(|session| constant_time_eq(&session.refresh_token_hash, &token_hash))
            .ok_or_else(|| anyhow!("invalid refresh token"))?;
        if store.sessions[index].identity_version.as_deref() != required_kind {
            bail!("invalid refresh token identity; log in again");
        }
        let record = store.sessions.remove(index);
        if record.refresh_expires_at <= now {
            self.write_store(&store).await?;
            bail!("expired refresh token");
        }
        self.write_store(&store).await?;
        authorize(record.user.clone(), record.subject.clone()).await?;
        let session = new_session(record.user, record.subject, record.identity_version)?;
        store.sessions.push(session.record.clone());
        prune_sessions(&mut store);
        self.write_store(&store).await?;
        Ok(session.session)
    }

    async fn read_store(&self) -> Result<SessionStore> {
        let store: SessionStore =
            crate::auth_storage::read(&self.store_path)?.unwrap_or(SessionStore {
                sessions: Vec::new(),
            });
        for record in &store.sessions {
            if record
                .identity_version
                .as_deref()
                .is_some_and(|kind| kind != "local-v1")
            {
                bail!("auth store contains an unsupported session identity");
            }
        }
        Ok(store)
    }

    async fn write_store(&self, store: &SessionStore) -> Result<()> {
        crate::auth_storage::write(&self.store_path, store)
    }
}

struct IssuedSession {
    session: AppSession,
    record: SessionRecord,
}

fn new_session(
    user: String,
    subject: String,
    identity_version: Option<String>,
) -> Result<IssuedSession> {
    let access_token = random_token()?;
    let refresh_token = random_token()?;
    let now = unix_now();
    let access_expires_at = now + ACCESS_TOKEN_TTL_SECONDS;
    let refresh_expires_at = now + REFRESH_TOKEN_TTL_SECONDS;
    Ok(IssuedSession {
        session: AppSession {
            user: user.clone(),
            subject: subject.clone(),
            access_token: access_token.clone(),
            refresh_token: refresh_token.clone(),
            expires_in: ACCESS_TOKEN_TTL_SECONDS,
            refresh_expires_in: REFRESH_TOKEN_TTL_SECONDS,
        },
        record: SessionRecord {
            user,
            subject,
            identity_version,
            access_token_hash: hash_token(&access_token),
            refresh_token_hash: hash_token(&refresh_token),
            access_expires_at,
            refresh_expires_at,
            created_at: now,
            refreshed_at: now,
        },
    })
}

fn prune_sessions(store: &mut SessionStore) {
    let now = unix_now();
    store
        .sessions
        .retain(|session| session.refresh_expires_at > now);
    if store.sessions.len() > MAX_SESSIONS {
        let remove_count = store.sessions.len() - MAX_SESSIONS;
        store.sessions.drain(0..remove_count);
    }
}

fn random_token() -> Result<String> {
    let mut token = [0_u8; 32];
    getrandom::fill(&mut token).map_err(|error| anyhow!("random generator failed: {error}"))?;
    Ok(URL_SAFE_NO_PAD.encode(token))
}

fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join("")
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut diff = left.len() ^ right.len();
    let max_len = left.len().max(right.len());
    for index in 0..max_len {
        let left_byte = *left.get(index).unwrap_or(&0);
        let right_byte = *right.get(index).unwrap_or(&0);
        diff |= (left_byte ^ right_byte) as usize;
    }
    diff == 0
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn refresh_token_is_consumed_before_authorization_check() {
        let root = tempfile::tempdir().unwrap();
        let store = AppSessionStore::new(root.path());
        let session = store
            .issue("alice".to_string(), "subject-1".to_string())
            .await
            .unwrap();

        let denied = store
            .refresh(&session.refresh_token, |_user, _subject| async {
                bail!("not authorized")
            })
            .await;
        assert!(denied.is_err());

        let reused = store
            .refresh(&session.refresh_token, |_user, _subject| async { Ok(()) })
            .await;
        assert!(reused.is_err());
    }
}
