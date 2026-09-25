use anyhow::{bail, Result};
use obsidian_git_sync_server::auth::{AuthVerifier, ZitadelAuthorization};
use obsidian_git_sync_server::http::{
    router_with_webdav_limit, AppState, PublicAuthConfig, DEFAULT_WEBDAV_MAX_BODY_BYTES,
};
use obsidian_git_sync_server::remote::RemotePolicy;
use obsidian_git_sync_server::vault::{
    UploadLimits, VaultService, VaultServiceOptions, DEFAULT_INCOMPLETE_UPLOAD_TTL_SECONDS,
    DEFAULT_MAX_DECLARED_UPLOAD_BYTES, DEFAULT_MAX_INCOMPLETE_UPLOAD_BYTES,
};
use std::net::SocketAddr;
use std::path::PathBuf;

/// Worker threads get a larger stack than tokio's 2 MiB default: the sync and Saber code paths
/// build deep async state machines, and a debug build overflowed the default in tests.
const WORKER_STACK_BYTES: usize = 8 * 1024 * 1024;

fn main() -> Result<()> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_stack_size(WORKER_STACK_BYTES)
        .build()?
        .block_on(async_main())
}

async fn async_main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config = RuntimeConfig::from_env()?;
    let vaults = VaultService::new_with_options(VaultServiceOptions {
        data_dir: config.data_dir,
        remote_policy: config.remote_policy,
        upload_limits: config.upload_limits,
    });
    let app = router_with_webdav_limit(
        AppState::new(vaults, config.auth, config.public_auth),
        config.max_body_bytes,
        config.webdav_max_body_bytes,
        config.allowed_origins,
    );
    let listener = tokio::net::TcpListener::bind(config.listen).await?;
    tracing::info!("obsidian git sync server listening on {}", config.listen);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

struct RuntimeConfig {
    listen: SocketAddr,
    data_dir: PathBuf,
    auth: AuthVerifier,
    public_auth: PublicAuthConfig,
    max_body_bytes: usize,
    webdav_max_body_bytes: usize,
    remote_policy: RemotePolicy,
    allowed_origins: Vec<String>,
    upload_limits: UploadLimits,
}

impl RuntimeConfig {
    fn from_env() -> Result<Self> {
        let port = std::env::var("PORT")
            .unwrap_or_else(|_| "8787".to_string())
            .parse::<u16>()?;
        let listen = std::env::var("OBSIDIAN_GIT_SYNC_LISTEN")
            .unwrap_or_else(|_| format!("127.0.0.1:{port}"))
            .parse::<SocketAddr>()?;
        let data_dir = PathBuf::from(
            std::env::var("OBSIDIAN_GIT_SYNC_DATA_DIR").unwrap_or_else(|_| "data".to_string()),
        );

        let (auth, public_auth) = if let Ok(token) = std::env::var("OBSIDIAN_GIT_SYNC_DEV_TOKEN") {
            let token = non_empty_env_value("OBSIDIAN_GIT_SYNC_DEV_TOKEN", token)?;
            let user =
                std::env::var("OBSIDIAN_GIT_SYNC_DEV_USER").unwrap_or_else(|_| "dev".to_string());
            (
                AuthVerifier::StaticTokenForDev { token, user },
                PublicAuthConfig::Token,
            )
        } else if let Some(user) = password_user_env() {
            let setup_token = password_setup_token()?;
            (
                AuthVerifier::password_with_setup_token(user, data_dir.clone(), Some(setup_token))?,
                PublicAuthConfig::Password,
            )
        } else {
            let issuer = required_env("OIDC_ISSUER")?;
            let audience = required_env("OIDC_AUDIENCE")?;
            let jwks_url = std::env::var("OIDC_JWKS_URL").ok();
            let user_claim = std::env::var("OIDC_USER_CLAIM")
                .unwrap_or_else(|_| "preferred_username".to_string());
            let client_id = std::env::var("OIDC_DEVICE_CLIENT_ID")
                .or_else(|_| std::env::var("OIDC_CLIENT_ID"))
                .map_err(|_| {
                    anyhow::anyhow!(
                        "OIDC_DEVICE_CLIENT_ID is required for plugin login in OIDC mode"
                    )
                })?;
            let scope = std::env::var("OIDC_DEVICE_SCOPE")
                .unwrap_or_else(|_| "openid profile email".to_string());
            let zitadel = match std::env::var("ZITADEL_API_TOKEN") {
                Ok(api_token) if !api_token.trim().is_empty() => {
                    let base_url =
                        std::env::var("ZITADEL_BASE_URL").unwrap_or_else(|_| issuer.clone());
                    Some(ZitadelAuthorization::new(base_url, api_token)?)
                }
                _ => None,
            };
            let auth = AuthVerifier::oidc(
                issuer.clone(),
                audience.clone(),
                jwks_url,
                user_claim,
                data_dir.clone(),
                zitadel,
            )?;
            (
                auth,
                PublicAuthConfig::Oidc {
                    issuer,
                    client_id,
                    scope,
                    audience: Some(audience),
                },
            )
        };
        let max_body_bytes = std::env::var("OBSIDIAN_GIT_SYNC_MAX_BODY_BYTES")
            .unwrap_or_else(|_| (50 * 1024 * 1024).to_string())
            .parse::<usize>()?;
        let webdav_max_body_bytes = std::env::var("OBSIDIAN_GIT_SYNC_WEBDAV_MAX_BODY_BYTES")
            .unwrap_or_else(|_| DEFAULT_WEBDAV_MAX_BODY_BYTES.to_string())
            .parse::<usize>()?;
        let remote_policy = RemotePolicy {
            allow_local_remotes: parse_bool_env("OBSIDIAN_GIT_SYNC_ALLOW_LOCAL_REMOTES"),
            allowed_hosts: parse_csv_env("OBSIDIAN_GIT_SYNC_ALLOWED_REMOTE_HOSTS"),
        };
        let allowed_origins = parse_csv_env("OBSIDIAN_GIT_SYNC_ALLOWED_ORIGINS");
        let upload_limits = UploadLimits {
            max_declared_bytes: parse_u64_env(
                "OBSIDIAN_GIT_SYNC_MAX_DECLARED_UPLOAD_BYTES",
                DEFAULT_MAX_DECLARED_UPLOAD_BYTES,
            )?,
            max_incomplete_bytes: parse_u64_env(
                "OBSIDIAN_GIT_SYNC_MAX_INCOMPLETE_UPLOAD_BYTES",
                DEFAULT_MAX_INCOMPLETE_UPLOAD_BYTES,
            )?,
            incomplete_ttl_seconds: parse_u64_env(
                "OBSIDIAN_GIT_SYNC_INCOMPLETE_UPLOAD_TTL_SECONDS",
                DEFAULT_INCOMPLETE_UPLOAD_TTL_SECONDS,
            )?,
        };
        if upload_limits.max_declared_bytes == 0
            || upload_limits.max_incomplete_bytes == 0
            || upload_limits.incomplete_ttl_seconds == 0
        {
            bail!("upload limit environment values must be positive");
        }

        Ok(Self {
            listen,
            data_dir,
            auth,
            public_auth,
            max_body_bytes,
            webdav_max_body_bytes,
            remote_policy,
            allowed_origins,
            upload_limits,
        })
    }
}

fn parse_u64_env(name: &str, default: u64) -> Result<u64> {
    match std::env::var(name) {
        Ok(value) => value.parse::<u64>().map_err(Into::into),
        Err(_) => Ok(default),
    }
}

fn password_user_env() -> Option<String> {
    std::env::var("OBSIDIAN_GIT_SYNC_PASSWORD_USER")
        .or_else(|_| std::env::var("OBSIDIAN_GIT_SYNC_USER"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn password_setup_token() -> Result<String> {
    password_setup_token_from_env(std::env::var("OBSIDIAN_GIT_SYNC_PASSWORD_SETUP_TOKEN"))
}

fn password_setup_token_from_env(
    value: std::result::Result<String, std::env::VarError>,
) -> Result<String> {
    let value = value.map_err(|_| {
        anyhow::anyhow!("OBSIDIAN_GIT_SYNC_PASSWORD_SETUP_TOKEN is required in password mode")
    })?;
    non_empty_env_value("OBSIDIAN_GIT_SYNC_PASSWORD_SETUP_TOKEN", value)
}

fn non_empty_env_value(name: &str, value: String) -> Result<String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        bail!("{name} must not be empty");
    }
    if value.chars().any(char::is_whitespace) {
        bail!("{name} must not contain whitespace");
    }
    Ok(value)
}

fn required_env(name: &str) -> Result<String> {
    match std::env::var(name) {
        Ok(value) if !value.is_empty() => Ok(value),
        _ => bail!("{name} is required unless OBSIDIAN_GIT_SYNC_DEV_TOKEN or OBSIDIAN_GIT_SYNC_PASSWORD_USER is set"),
    }
}

fn parse_bool_env(name: &str) -> bool {
    std::env::var(name)
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn parse_csv_env(name: &str) -> Vec<String> {
    std::env::var(name)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tracing_subscriber::layer::{Context, Layer};
    use tracing_subscriber::prelude::*;
    use tracing_subscriber::registry::LookupSpan;

    #[derive(Clone)]
    struct EventRecorder(Arc<Mutex<Vec<String>>>);

    impl<S> Layer<S> for EventRecorder
    where
        S: tracing::Subscriber + for<'a> LookupSpan<'a>,
    {
        fn on_event(&self, event: &tracing::Event<'_>, _context: Context<'_, S>) {
            self.0
                .lock()
                .unwrap()
                .push(event.metadata().name().to_string());
        }
    }

    #[test]
    fn configured_password_setup_token_is_never_logged() {
        let token = "production-setup-token-123456";
        let events = Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::registry().with(EventRecorder(events.clone()));

        tracing::subscriber::with_default(subscriber, || {
            assert_eq!(
                password_setup_token_from_env(Ok(token.to_string())).unwrap(),
                token
            );
        });

        assert!(events.lock().unwrap().is_empty());
    }

    #[test]
    fn password_mode_requires_a_setup_token() {
        let error = password_setup_token_from_env(Err(std::env::VarError::NotPresent))
            .unwrap_err()
            .to_string();

        assert_eq!(
            error,
            "OBSIDIAN_GIT_SYNC_PASSWORD_SETUP_TOKEN is required in password mode"
        );
    }

    #[test]
    fn password_mode_rejects_an_invalid_setup_token() {
        let data_dir = tempfile::tempdir().unwrap();
        assert!(AuthVerifier::password_with_setup_token(
            "alice".to_string(),
            data_dir.path(),
            Some("too-short".to_string()),
        )
        .is_err());
    }
}
