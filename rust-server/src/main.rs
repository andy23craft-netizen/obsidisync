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
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|a| a == "admin") && args.get(1).is_some_and(|a| a == "--help") {
        println!("{}", obsidian_git_sync_server::admin::HELP);
        return Ok(());
    }
    let mut data_dir = PathBuf::from(
        std::env::var("OBSIDIAN_GIT_SYNC_DATA_DIR").unwrap_or_else(|_| "data".into()),
    );
    let admin_args = if args.first().is_some_and(|a| a == "admin") {
        let mut commands = args[1..].to_vec();
        if commands.first().is_some_and(|a| a == "--data-dir") {
            if commands.len() < 2 {
                bail!("--data-dir requires a path");
            }
            data_dir = PathBuf::from(&commands[1]);
            commands.drain(..2);
        }
        Some(commands)
    } else {
        if !args.is_empty() {
            bail!("unknown server arguments; use admin --help");
        }
        None
    };
    let _directory_lock =
        obsidian_git_sync_server::auth_storage::DataDirectoryLock::acquire(&data_dir)?;
    // Declared after the lock so runtime workers stop before the lock is released on return.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_stack_size(WORKER_STACK_BYTES)
        .build()?;
    if let Some(commands) = admin_args {
        return runtime.block_on(obsidian_git_sync_server::admin::run(&data_dir, &commands));
    }
    runtime.block_on(async_main())
}

async fn async_main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    // Fail before constructing workers or listeners. Installed staged roots are never
    // served until the single authority is complete and its recovery journal is cleared.
    let data = PathBuf::from(
        std::env::var("OBSIDIAN_GIT_SYNC_DATA_DIR").unwrap_or_else(|_| "data".into()),
    );
    let publication = obsidian_git_sync_server::publication::Publication::load(&data)?;
    publication.validate(&data)?;
    let config = RuntimeConfig::from_env()?;
    let vaults = VaultService::published(VaultServiceOptions {
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

        let mode = std::env::var("OBSIDIAN_GIT_SYNC_AUTH_MODE").ok();
        if mode
            .as_deref()
            .is_some_and(|m| !matches!(m, "password" | "oidc" | "dev"))
        {
            bail!("OBSIDIAN_GIT_SYNC_AUTH_MODE must be password, oidc, or dev");
        }
        let development = mode.as_deref() == Some("dev")
            || (mode.is_none() && std::env::var("OBSIDIAN_GIT_SYNC_DEV_TOKEN").is_ok());
        let password = mode.as_deref() == Some("password")
            || (mode.is_none() && password_user_env().is_some());
        let (auth, public_auth) = if development {
            let token = required_env("OBSIDIAN_GIT_SYNC_DEV_TOKEN")?;
            let token = non_empty_env_value("OBSIDIAN_GIT_SYNC_DEV_TOKEN", token)?;
            let user = obsidian_git_sync_server::auth::normalize_user_claim(
                &std::env::var("OBSIDIAN_GIT_SYNC_DEV_USER").unwrap_or_else(|_| "dev".to_string()),
            )?;
            obsidian_git_sync_server::paths::validate_slug(&user, "development user")?;
            tracing::warn!("development-token authentication explicitly enabled; use only for local development");
            (
                AuthVerifier::StaticTokenForDev { token, user },
                PublicAuthConfig::Token,
            )
        } else if password {
            if std::env::var_os("OBSIDIAN_GIT_SYNC_PASSWORD_SETUP_TOKEN").is_some() {
                tracing::info!("password setup token configuration is retired and ignored");
            }
            (
                AuthVerifier::password(password_user_env().unwrap_or_default(), data_dir.clone())?,
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
        _ => bail!("{name} is required for the selected authentication mode"),
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
    #[test]
    fn password_mode_ignores_retired_username_and_setup_token() {
        let data_dir = tempfile::tempdir().unwrap();
        assert!(AuthVerifier::password_with_setup_token(
            String::new(),
            data_dir.path(),
            Some("too-short".to_string()),
        )
        .is_ok());
    }
}
