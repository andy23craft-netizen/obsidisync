use crate::auth::AuthVerifier;
use crate::auth_throttle::AuthThrottle;
use crate::device_passwords::{
    CreateDevicePasswordRequest, CreatedDevicePassword, DevicePasswordEntry, DevicePasswordStore,
};
use crate::nextcloud::LoginFlowStore;
use crate::oidc_login::OidcLoginStore;
use crate::protocol::*;
use crate::saber::push::{TabletPusher, DEFAULT_PUSH_DELAY};
use crate::saber::sync::{SaberRenderer, DEFAULT_RENDER_DELAY};
use crate::vault::VaultService;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Form, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{any, delete, get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

const SITE_SESSION_COOKIE: &str = "obsidisync_session";
const SITE_SESSION_COOKIE_MAX_AGE_SECONDS: u64 = 30 * 24 * 60 * 60;
const SERVER_API_VERSION: u32 = 1;
const MIN_CLIENT_API_VERSION: u32 = 1;
/// Optional capabilities advertised to clients. Older plugins ignore the list; newer plugins
/// hide or explain features that the server they talk to does not have yet.
const SERVER_FEATURES: &[&str] = &[
    "inkVaultNotesV1",
    "webdavDevicePasswords",
    "syncFileReferences",
    "saberNextcloud",
    "shareSyncV2",
    "readOnlyShareSync",
];
/// PDFs exported from note-taking tablets are routinely larger than the JSON sync payload limit.
pub const DEFAULT_WEBDAV_MAX_BODY_BYTES: usize = 200 * 1024 * 1024;

#[derive(Clone)]
pub struct AppState {
    pub vaults: VaultService,
    pub auth: AuthVerifier,
    pub public_auth: PublicAuthConfig,
    pub device_passwords: Arc<DevicePasswordStore>,
    pub webdav_throttle: Arc<AuthThrottle>,
    /// Password setup/login uses the same bounded in-memory throttle as WebDAV.
    pub password_throttle: Arc<AuthThrottle>,
    /// Largest single WebDAV upload. Enforced while streaming the body to disk.
    pub webdav_max_body_bytes: usize,
    /// Renders Saber uploads to PDFs in the background.
    pub saber: Arc<SaberRenderer>,
    /// Pushes `#tablet`-tagged PDFs into Saber in the background.
    pub tablet: Arc<TabletPusher>,
    /// Pending Nextcloud Login Flow v2 sessions started by the Saber app.
    pub login_flows: Arc<LoginFlowStore>,
    /// Pending browser logins through the OIDC issuer.
    pub oidc_login: Arc<OidcLoginStore>,
}

impl AppState {
    pub fn new(vaults: VaultService, auth: AuthVerifier, public_auth: PublicAuthConfig) -> Self {
        let device_passwords = Arc::new(DevicePasswordStore::new(vaults.data_dir.clone()));
        let saber = SaberRenderer::new(vaults.clone(), DEFAULT_RENDER_DELAY);
        let tablet = TabletPusher::new(
            vaults.clone(),
            Arc::clone(&device_passwords),
            DEFAULT_PUSH_DELAY,
        );
        Self {
            vaults,
            auth,
            public_auth,
            device_passwords,
            webdav_throttle: Arc::new(AuthThrottle::new()),
            password_throttle: Arc::new(AuthThrottle::new()),
            webdav_max_body_bytes: DEFAULT_WEBDAV_MAX_BODY_BYTES,
            saber,
            tablet,
            login_flows: Arc::new(LoginFlowStore::default()),
            oidc_login: Arc::new(OidcLoginStore::default()),
        }
    }

    /// Changes how long the Saber renderer waits for related uploads before rendering.
    pub fn with_saber_render_delay(mut self, delay: std::time::Duration) -> Self {
        self.saber = SaberRenderer::new(self.vaults.clone(), delay);
        self.tablet = TabletPusher::new(
            self.vaults.clone(),
            Arc::clone(&self.device_passwords),
            delay,
        );
        self
    }
}

#[derive(Debug)]
pub struct ApiError(anyhow::Error);

#[derive(Debug, Deserialize)]
pub struct HistoryQuery {
    pub path: Option<String>,
}

#[derive(Clone, Debug)]
pub enum PublicAuthConfig {
    Password,
    Oidc {
        issuer: String,
        client_id: String,
        scope: String,
        audience: Option<String>,
    },
    Token,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
enum PublicAuthConfigResponse {
    Password {
        #[serde(rename = "passwordConfigured")]
        password_configured: bool,
        #[serde(rename = "setupTokenRequired")]
        setup_token_required: bool,
        #[serde(rename = "accountProvisioning")]
        account_provisioning: &'static str,
        #[serde(rename = "loginAvailable")]
        login_available: bool,
    },
    Oidc {
        issuer: String,
        #[serde(rename = "clientId")]
        client_id: String,
        scope: String,
        audience: Option<String>,
    },
    Token,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthSessionResponse {
    user: String,
    subject: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerInfoResponse {
    name: &'static str,
    version: &'static str,
    api_version: u32,
    min_client_api_version: u32,
    features: &'static [&'static str],
}

impl<E> From<E> for ApiError
where
    E: Into<anyhow::Error>,
{
    fn from(error: E) -> Self {
        Self(error.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let message = self.0.to_string();
        // Errors may include client-controlled paths or parser context. Keep server logs useful
        // without turning them into a second store for vault names or request secrets.
        tracing::warn!(status = %status_for_error(&message), "request failed");
        let status = status_for_error(&message);
        (
            status,
            Json(ApiErrorBody {
                error: public_error_message(status, &message),
            }),
        )
            .into_response()
    }
}

fn status_for_error(message: &str) -> StatusCode {
    if message.contains("local login unavailable")
        || message.contains("auth store")
        || message.contains("account store")
    {
        StatusCode::SERVICE_UNAVAILABLE
    } else if message.contains("unauthorized")
        || message.contains("authorization")
        || message.contains("OIDC")
        || message.contains("bearer")
        || message.contains("refresh token")
        || message.contains("invalid username or password")
        || message.contains("password is not set")
    {
        StatusCode::UNAUTHORIZED
    } else if message.starts_with("InkNote changed since conflict") {
        StatusCode::CONFLICT
    } else if message.starts_with("gone:") {
        StatusCode::GONE
    } else if message.contains("forbidden") {
        StatusCode::FORBIDDEN
    } else if message.contains("not found") || message.contains("Unknown vault") {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::BAD_REQUEST
    }
}

pub fn router(state: AppState, max_body_bytes: usize, allowed_origins: Vec<String>) -> Router {
    router_with_webdav_limit(
        state,
        max_body_bytes,
        max_body_bytes.max(DEFAULT_WEBDAV_MAX_BODY_BYTES),
        allowed_origins,
    )
}

pub fn router_with_webdav_limit(
    mut state: AppState,
    max_body_bytes: usize,
    webdav_max_body_bytes: usize,
    allowed_origins: Vec<String>,
) -> Router {
    state.webdav_max_body_bytes = webdav_max_body_bytes;
    // WebDAV reads the raw request body itself (streamed to disk), so its size limit is
    // enforced in the handler rather than through `DefaultBodyLimit`.
    let webdav = Router::new()
        .route("/dav", any(crate::webdav::handle))
        .route("/dav/", any(crate::webdav::handle))
        .route("/dav/*path", any(crate::webdav::handle));
    let router = Router::new()
        .route("/", get(home_page))
        .route("/login", get(password_page).post(password_form))
        .route("/change-feed", get(change_feed_page))
        .route(
            "/health",
            get(|| async { Json(serde_json::json!({ "ok": true })) }),
        )
        .route("/v1/server/info", get(server_info))
        .route("/v1/auth/config", get(auth_config))
        .route("/v1/auth/session", get(auth_session))
        .route("/v1/auth/session/refresh", post(refresh_session))
        .route("/v1/auth/oidc/login", post(login_oidc))
        .route("/v1/auth/password/setup", post(setup_password))
        .route("/v1/auth/password/login", post(login_password))
        .route("/v1/users/:user/feed", get(feed))
        .route("/v1/users/:user/vaults/:vault/register", post(register))
        .route("/v1/users/:user/vaults/:vault/uploads", post(init_upload))
        .route(
            "/v1/users/:user/vaults/:vault/uploads/:upload/chunk",
            post(upload_chunk),
        )
        .route(
            "/v1/users/:user/vaults/:vault/uploads/:upload/complete",
            post(complete_upload),
        )
        .route("/v1/users/:user/vaults/:vault/sync", post(sync))
        .route(
            "/v1/users/:user/vaults/:vault/inkvault/resolve",
            post(resolve_inkvault),
        )
        .route("/v1/users/:user/vaults/:vault/history", get(history))
        .route("/v1/users/:user/vaults/:vault/file", get(file_at_version))
        .route("/v1/users/:user/vaults/:vault/blob", get(blob_at_version))
        .route("/v1/users/:user/vaults/:vault/resolve", post(resolve))
        .route("/v1/users/:user/vaults/:vault/devices", get(devices))
        .route(
            "/v1/users/:user/vaults/:vault/conflicts",
            get(pending_conflicts),
        )
        .route(
            "/v1/users/:user/vaults/:vault/files/device-versions",
            get(device_versions),
        )
        .route(
            "/v1/users/:user/vaults/:vault/files/version-metadata",
            post(set_version_metadata),
        )
        .route(
            "/v1/users/:user/vaults/:vault/device-passwords",
            get(list_device_passwords).post(create_device_password),
        )
        .route(
            "/v1/users/:user/vaults/:vault/device-passwords/:id",
            delete(revoke_device_password),
        )
        .layer(DefaultBodyLimit::max(max_body_bytes))
        .merge(webdav)
        .merge(crate::nextcloud::router())
        .merge(crate::v2::router())
        .merge(crate::oidc_login::router())
        .with_state(Arc::new(state));

    apply_cors(router, allowed_origins)
}

async fn home_page(State(state): State<Arc<AppState>>) -> Result<Html<String>, ApiError> {
    Ok(Html(render_home_page(&state.public_auth)))
}

async fn server_info() -> Json<ServerInfoResponse> {
    Json(ServerInfoResponse {
        name: "obsidisync-server",
        version: env!("CARGO_PKG_VERSION"),
        api_version: SERVER_API_VERSION,
        min_client_api_version: MIN_CLIENT_API_VERSION,
        features: SERVER_FEATURES,
    })
}

fn apply_cors(router: Router, allowed_origins: Vec<String>) -> Router {
    if allowed_origins.is_empty() {
        return router;
    }

    let layer = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);

    if allowed_origins.iter().any(|origin| origin == "*") {
        router.layer(layer.allow_origin(Any))
    } else {
        let origins: Vec<HeaderValue> = allowed_origins
            .into_iter()
            .filter_map(|origin| HeaderValue::from_str(origin.trim()).ok())
            .collect();
        if origins.is_empty() {
            router
        } else {
            router.layer(layer.allow_origin(origins))
        }
    }
}

fn public_error_message(status: StatusCode, message: &str) -> String {
    match status {
        StatusCode::SERVICE_UNAVAILABLE if message.contains("local login unavailable") => {
            "Ask the server operator to create or enable a local account".to_string()
        }
        StatusCode::UNAUTHORIZED => "unauthorized".to_string(),
        StatusCode::FORBIDDEN => "forbidden".to_string(),
        StatusCode::NOT_FOUND => "not found".to_string(),
        _ if is_public_client_error(message) => message.to_string(),
        _ => "request failed".to_string(),
    }
}

fn is_public_client_error(message: &str) -> bool {
    message.starts_with("InkNote ")
        || message.starts_with("invalid ")
        || message.starts_with("unsafe vault path")
        || message.starts_with("local git remotes are disabled")
        || message.starts_with("git remote ")
        || message.starts_with("OIDC user claim cannot be used")
        || message.starts_with("password must")
        || message.starts_with("password setup token is required")
        || message.starts_with("password is already set")
        || message.starts_with("password confirmation")
        || message.starts_with("invalid device password")
        || message.starts_with("invalid request")
        || message.starts_with("invalid vault")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasswordAuthRequest {
    username: String,
    password: String,
}

#[derive(Debug, Deserialize)]
struct PasswordLoginForm {
    username: String,
    password: String,
    /// Site-relative path to continue to after login (for example a Saber login flow page).
    next: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct LoginPageQuery {
    next: Option<String>,
}

/// Only same-site paths are followed after login, never absolute URLs.
pub(crate) fn safe_next_path(next: Option<&str>) -> Option<String> {
    let next = next?.trim();
    if next.starts_with('/') && !next.starts_with("//") && !next.contains(['\r', '\n']) {
        Some(next.to_string())
    } else {
        None
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OidcLoginRequest {
    access_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshSessionRequest {
    refresh_token: String,
}

async fn password_page(
    State(state): State<Arc<AppState>>,
    Query(query): Query<LoginPageQuery>,
) -> Result<Response, ApiError> {
    if matches!(state.public_auth, PublicAuthConfig::Oidc { .. }) {
        let next =
            safe_next_path(query.next.as_deref()).unwrap_or_else(|| "/change-feed".to_string());
        return Ok(
            axum::response::Redirect::to(&crate::oidc_login::start_url(&next)).into_response(),
        );
    }
    if !matches!(state.public_auth, PublicAuthConfig::Password) {
        return Ok(Html(render_home_page(&state.public_auth)).into_response());
    }
    let configured = state.auth.password_is_configured().await?;
    if !configured {
        return Ok(
            Html("<p>Ask the server operator to create or enable a local account.</p>")
                .into_response(),
        );
    }
    Ok(Html(render_password_page(
        None,
        safe_next_path(query.next.as_deref()).as_deref(),
    ))
    .into_response())
}

async fn password_form(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    peer: Option<ConnectInfo<std::net::SocketAddr>>,
    Form(form): Form<PasswordLoginForm>,
) -> Result<Response, ApiError> {
    if !matches!(state.public_auth, PublicAuthConfig::Password) {
        return Err(ApiError(anyhow::anyhow!("password login is not enabled")));
    }
    let configured = state.auth.password_is_configured().await?;
    if !configured {
        return Err(ApiError(anyhow::anyhow!("local login unavailable")));
    }
    let keys = password_throttle_keys(&form.username, peer.as_ref());
    if let Some(retry_after) = state.password_throttle.blocked_for(&keys).await {
        return Ok(password_throttled_form(
            safe_next_path(form.next.as_deref()).as_deref(),
            retry_after,
        ));
    }
    let result = state
        .auth
        .login_password(&form.username, &form.password)
        .await;

    let next = safe_next_path(form.next.as_deref());
    match result {
        Ok(session) => {
            state.password_throttle.record_success(&keys).await;
            Ok(redirect_with_site_session(
                next.as_deref().unwrap_or("/change-feed"),
                &session.access_token,
                site_session_cookie_is_secure(&headers),
            ))
        }
        Err(_) => {
            state.password_throttle.record_failure(&keys).await;
            if let Some(retry_after) = state.password_throttle.blocked_for(&keys).await {
                return Ok(password_throttled_form(next.as_deref(), retry_after));
            }
            Ok(Html(render_password_page(
                Some("login failed".to_string()),
                next.as_deref(),
            ))
            .into_response())
        }
    }
}

async fn change_feed_page(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let Some(token) = site_session_token(&headers) else {
        return Ok(redirect_to_login());
    };
    let auth = match state.auth.verify_bearer_token(&token).await {
        Ok(auth) => auth,
        Err(_) => return Ok(redirect_to_login()),
    };
    let feed = authorized_feed(&state, &auth, false).await?;
    Ok(Html(render_change_feed_page(&auth.user, &feed)).into_response())
}

async fn setup_password(State(state): State<Arc<AppState>>) -> Result<Response, ApiError> {
    if !matches!(state.public_auth, PublicAuthConfig::Password) {
        return Err(ApiError(anyhow::anyhow!("password login is not enabled")));
    }
    Ok((StatusCode::GONE, Json(ApiErrorBody {
        error: "Public password setup is retired; ask the server operator to create an account offline".into(),
    })).into_response())
}

async fn login_password(
    State(state): State<Arc<AppState>>,
    peer: Option<ConnectInfo<std::net::SocketAddr>>,
    Json(request): Json<PasswordAuthRequest>,
) -> Result<Response, ApiError> {
    if !matches!(state.public_auth, PublicAuthConfig::Password) {
        return Err(ApiError(anyhow::anyhow!("password login is not enabled")));
    }
    if !state.auth.password_is_configured().await? {
        return Err(ApiError(anyhow::anyhow!("local login unavailable")));
    }
    password_json_attempt(&state, &request, peer.as_ref()).await
}

fn password_throttle_keys(
    username: &str,
    peer: Option<&ConnectInfo<std::net::SocketAddr>>,
) -> Vec<String> {
    // Deliberately ignore X-Forwarded-For. The TCP peer is the only directly observed address;
    // username throttling remains effective even if a proxy is misconfigured.
    let ip = peer
        .map(|value| value.0.ip().to_string())
        .unwrap_or_else(|| "unknown-peer".to_string());
    vec![AuthThrottle::ip_key(&ip), AuthThrottle::user_key(username)]
}

fn throttled_response(retry_after: u64) -> Response {
    let mut response = (
        StatusCode::TOO_MANY_REQUESTS,
        Json(ApiErrorBody {
            error: "too many failed login attempts; try again later".to_string(),
        }),
    )
        .into_response();
    if let Ok(value) = HeaderValue::from_str(&retry_after.max(1).to_string()) {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

fn password_throttled_form(next: Option<&str>, retry_after: u64) -> Response {
    let mut response = Html(render_password_page(
        Some("too many failed login attempts; try again later".to_string()),
        next,
    ))
    .into_response();
    *response.status_mut() = StatusCode::TOO_MANY_REQUESTS;
    if let Ok(value) = HeaderValue::from_str(&retry_after.max(1).to_string()) {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

async fn password_json_attempt(
    state: &Arc<AppState>,
    request: &PasswordAuthRequest,
    peer: Option<&ConnectInfo<std::net::SocketAddr>>,
) -> Result<Response, ApiError> {
    let keys = password_throttle_keys(&request.username, peer);
    if let Some(retry_after) = state.password_throttle.blocked_for(&keys).await {
        return Ok(throttled_response(retry_after));
    }
    let result = state
        .auth
        .login_password(&request.username, &request.password)
        .await;
    match result {
        Ok(session) => {
            state.password_throttle.record_success(&keys).await;
            Ok(Json(session).into_response())
        }
        Err(_) => {
            state.password_throttle.record_failure(&keys).await;
            if let Some(retry_after) = state.password_throttle.blocked_for(&keys).await {
                Ok(throttled_response(retry_after))
            } else {
                Err(ApiError(anyhow::anyhow!("invalid username or password")))
            }
        }
    }
}

async fn login_oidc(
    State(state): State<Arc<AppState>>,
    Json(request): Json<OidcLoginRequest>,
) -> Result<Json<crate::app_session::AppSession>, ApiError> {
    if !matches!(state.public_auth, PublicAuthConfig::Oidc { .. }) {
        return Err(ApiError(anyhow::anyhow!("OIDC login is not enabled")));
    }
    Ok(Json(state.auth.login_oidc(&request.access_token).await?))
}

async fn refresh_session(
    State(state): State<Arc<AppState>>,
    Json(request): Json<RefreshSessionRequest>,
) -> Result<Json<crate::app_session::AppSession>, ApiError> {
    Ok(Json(
        state.auth.refresh_session(&request.refresh_token).await?,
    ))
}

async fn auth_config(
    State(state): State<Arc<AppState>>,
) -> Result<Json<PublicAuthConfigResponse>, ApiError> {
    let response = match &state.public_auth {
        PublicAuthConfig::Password => PublicAuthConfigResponse::Password {
            password_configured: true,
            setup_token_required: false,
            account_provisioning: "host-local",
            login_available: state.auth.password_is_configured().await?,
        },
        PublicAuthConfig::Oidc {
            issuer,
            client_id,
            scope,
            audience,
        } => PublicAuthConfigResponse::Oidc {
            issuer: issuer.clone(),
            client_id: client_id.clone(),
            scope: scope.clone(),
            audience: audience.clone(),
        },
        PublicAuthConfig::Token => PublicAuthConfigResponse::Token,
    };
    Ok(Json(response))
}

fn render_home_page(public_auth: &PublicAuthConfig) -> String {
    let auth_line = match public_auth {
        PublicAuthConfig::Password => "Password login is enabled. Open /login to sign in.",
        PublicAuthConfig::Oidc { issuer, .. } => {
            return format!(
                r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OBSync</title>
<style>
:root {{ color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }}
main {{ width: min(720px, calc(100vw - 32px)); padding: 2rem 0; }}
h1 {{ font-size: 1.7rem; margin: 0 0 0.75rem; }}
p {{ line-height: 1.5; color: color-mix(in srgb, CanvasText 76%, transparent); }}
code {{ font: 0.95em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }}
</style>
</head>
<body>
<main>
<h1>OBSync</h1>
<p>This sync server is running and uses Zitadel OIDC for plugin login.</p>
<p>Issuer: <code>{}</code></p>
<p>Use the Obsidian plugin login button to start device authorization.</p>
</main>
</body>
</html>"#,
                escape_html(issuer)
            );
        }
        PublicAuthConfig::Token => "Static token authentication is enabled.",
    };

    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OBSync</title>
<style>
:root {{ color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }}
main {{ width: min(720px, calc(100vw - 32px)); padding: 2rem 0; }}
h1 {{ font-size: 1.7rem; margin: 0 0 0.75rem; }}
p {{ line-height: 1.5; color: color-mix(in srgb, CanvasText 76%, transparent); }}
</style>
</head>
<body>
<main>
<h1>OBSync</h1>
<p>{}</p>
</main>
</body>
</html>"#,
        escape_html(auth_line)
    )
}

async fn auth_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<AuthSessionResponse>, ApiError> {
    let auth = state.auth.verify_headers(&headers).await?;
    Ok(Json(AuthSessionResponse {
        user: auth.user,
        subject: auth.subject,
    }))
}

fn render_password_page(message: Option<String>, next: Option<&str>) -> String {
    let next_field = next
        .map(|value| {
            format!(
                r#"<input type="hidden" name="next" value="{}">"#,
                escape_html(value)
            )
        })
        .unwrap_or_default();
    let title = "Log in";
    let message_html = message
        .as_deref()
        .map(|value| format!(r#"<p class="message">{}</p>"#, escape_html(value)))
        .unwrap_or_default();

    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} - ObsidiSync</title>
<style>
:root {{ color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }}
main {{ width: min(760px, calc(100vw - 32px)); padding: 2rem 0; }}
h1 {{ font-size: 1.5rem; margin: 0 0 1rem; }}
form, section {{ display: grid; gap: 1rem; }}
label {{ display: grid; gap: 0.35rem; font-weight: 600; }}
input, textarea, button {{ font: inherit; border: 1px solid color-mix(in srgb, CanvasText 24%, transparent); border-radius: 6px; padding: 0.7rem; }}
textarea {{ min-height: 8rem; resize: vertical; }}
button {{ cursor: pointer; font-weight: 700; }}
.message {{ margin: 0 0 1rem; color: CanvasText; }}
.feed {{ margin-top: 2rem; }}
.feed ol {{ list-style: none; padding: 0; margin: 0; display: grid; gap: 0.9rem; }}
.feed li {{ border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 8px; padding: 0.9rem; }}
.feed h3 {{ margin: 0 0 0.25rem; font-size: 1rem; }}
.meta, .files {{ margin: 0; color: color-mix(in srgb, CanvasText 72%, transparent); font-size: 0.88rem; }}
.files {{ margin-top: 0.5rem; overflow-wrap: anywhere; }}
</style>
</head>
<body>
<main>
<h1>{title}</h1>
{message_html}
<form action="/login" method="post">
{next_field}
<label>Username<input name="username" type="text" autocomplete="username" required autofocus></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">{title}</button>
</form>
</main>
</body>
</html>"#
    )
}

fn render_change_feed_page(user: &str, feed: &[ActivityFeedEntry]) -> String {
    let feed_html = render_feed(feed);
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Change feed - ObsidiSync</title>
<style>
:root {{ color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
body {{ margin: 0; min-height: 100vh; background: Canvas; color: CanvasText; }}
main {{ width: min(860px, calc(100vw - 32px)); margin: 0 auto; padding: 2rem 0; }}
h1 {{ font-size: 1.6rem; margin: 0 0 0.25rem; }}
.meta, .files {{ margin: 0; color: color-mix(in srgb, CanvasText 72%, transparent); font-size: 0.88rem; }}
.feed {{ margin-top: 2rem; }}
.feed ol {{ list-style: none; padding: 0; margin: 0; display: grid; gap: 0.9rem; }}
.feed li {{ border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 8px; padding: 0.9rem; }}
.feed h3 {{ margin: 0 0 0.25rem; font-size: 1rem; }}
.files {{ margin-top: 0.5rem; overflow-wrap: anywhere; }}
</style>
</head>
<body>
<main>
<h1>Change feed</h1>
<p class="meta">Signed in as {}</p>
{feed_html}
</main>
</body>
</html>"#,
        escape_html(user)
    )
}

fn render_feed(feed: &[ActivityFeedEntry]) -> String {
    let items = if feed.is_empty() {
        r#"<p class="meta">No synced changes yet.</p>"#.to_string()
    } else {
        let entries = feed
            .iter()
            .map(|entry| {
                let files = if entry.files.is_empty() {
                    "No file list recorded".to_string()
                } else {
                    let shown = entry
                        .files
                        .iter()
                        .take(8)
                        .map(|path| escape_html(path))
                        .collect::<Vec<_>>()
                        .join(", ");
                    if entry.files.len() > 8 {
                        format!("{} and {} more", shown, entry.files.len() - 8)
                    } else {
                        shown
                    }
                };
                format!(
                    r#"<li><h3>{}</h3><p class="meta">{} · {} · {} · {}</p><p class="files">{}</p></li>"#,
                    escape_html(&entry.subject),
                    escape_html(&entry.vault),
                    escape_html(&entry.author),
                    escape_html(&entry.date),
                    escape_html(&entry.hash.chars().take(12).collect::<String>()),
                    files,
                )
            })
            .collect::<Vec<_>>()
            .join("");
        format!("<ol>{entries}</ol>")
    };
    format!(r#"<section class="feed"><h2>Recent changes</h2>{items}</section>"#)
}

pub(crate) fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

async fn register(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((user, vault)): Path<(String, String)>,
    Json(request): Json<RegisterRequest>,
) -> Result<Json<RegisterResponse>, ApiError> {
    authorize_vault(
        &state,
        &headers,
        &user,
        &vault,
        crate::accounts::Capability::ReadWrite,
    )
    .await?;
    Ok(Json(state.vaults.register(&user, &vault, request).await?))
}

async fn feed(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(user): Path<String>,
) -> Result<Json<Vec<ActivityFeedEntry>>, ApiError> {
    let auth = state.auth.verify_headers(&headers).await?;
    if state.vaults.uses_published_storage() {
        if auth.user != user {
            return Err(anyhow::anyhow!("not found: share").into());
        }
    } else {
        authorize(&state, &headers, &user).await?;
    }
    Ok(Json(authorized_feed(&state, &auth, true).await?))
}

async fn sync(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((user, vault)): Path<(String, String)>,
    Json(request): Json<SyncRequest>,
) -> Result<Json<SyncResponse>, ApiError> {
    authorize_vault_client(
        &state,
        &headers,
        &user,
        &vault,
        crate::accounts::Capability::ReadWrite,
        Some(&request.client_id),
    )
    .await?;
    let changed: Vec<String> = request
        .changes
        .iter()
        .map(|change| match change {
            ClientChange::Upsert { path, .. } | ClientChange::Delete { path } => path.clone(),
        })
        .collect();
    let native = inkvault_client(&headers);
    let has_source = request
        .changes
        .iter()
        .any(|c| crate::inkvault::is_source(crate::vault::inkvault::change_path(c)));
    let mut response = if native && has_source {
        state.vaults.sync_inkvault(&user, &vault, request).await?
    } else {
        state
            .vaults
            .sync_with_sources(&user, &vault, request, native)
            .await?
    };
    if !native {
        response
            .files
            .retain(|f| !crate::inkvault::is_source(crate::vault::inkvault::file_path(f)));
    }

    state.tablet.schedule(&user, &vault, changed);
    Ok(Json(response))
}

async fn init_upload(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((user, vault)): Path<(String, String)>,
    Json(request): Json<UploadInitRequest>,
) -> Result<Json<UploadInitResponse>, ApiError> {
    authorize_vault(
        &state,
        &headers,
        &user,
        &vault,
        crate::accounts::Capability::ReadWrite,
    )
    .await?;
    Ok(Json(
        state.vaults.init_upload(&user, &vault, request).await?,
    ))
}

async fn upload_chunk(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((user, vault, upload)): Path<(String, String, String)>,
    Json(request): Json<UploadChunkRequest>,
) -> Result<Json<UploadChunkResponse>, ApiError> {
    authorize_vault(
        &state,
        &headers,
        &user,
        &vault,
        crate::accounts::Capability::ReadWrite,
    )
    .await?;
    Ok(Json(
        state
            .vaults
            .append_upload_chunk(&user, &vault, &upload, request)
            .await?,
    ))
}

async fn complete_upload(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((user, vault, upload)): Path<(String, String, String)>,
) -> Result<Json<UploadCompleteResponse>, ApiError> {
    authorize_vault(
        &state,
        &headers,
        &user,
        &vault,
        crate::accounts::Capability::ReadWrite,
    )
    .await?;
    Ok(Json(
        state.vaults.complete_upload(&user, &vault, &upload).await?,
    ))
}

async fn history(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((user, vault)): Path<(String, String)>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<Vec<HistoryEntry>>, ApiError> {
    authorize_vault(
        &state,
        &headers,
        &user,
        &vault,
        crate::accounts::Capability::Read,
    )
    .await?;
    if let Some(path) = &query.path {
        authorize_inkvault_path(&headers, path)?;
    }
    Ok(Json(
        state
            .vaults
            .history(&user, &vault, query.path.as_deref())
            .await?,
    ))
}

async fn file_at_version(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((user, vault)): Path<(String, String)>,
    Query(query): Query<FileQuery>,
) -> Result<Json<VersionFileResponse>, ApiError> {
    authorize_vault(
        &state,
        &headers,
        &user,
        &vault,
        crate::accounts::Capability::Read,
    )
    .await?;
    authorize_inkvault_path(&headers, &query.path)?;
    Ok(Json(
        state
            .vaults
            .file_at_version(&user, &vault, &query.path, &query.hash)
            .await?,
    ))
}

/// Raw file bytes at a commit. Complements `sync` in `FileContentMode::Reference`, where the
/// client downloads each changed file separately instead of receiving the vault as one JSON body.
async fn blob_at_version(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((user, vault)): Path<(String, String)>,
    Query(query): Query<FileQuery>,
) -> Result<Response, ApiError> {
    authorize_vault(
        &state,
        &headers,
        &user,
        &vault,
        crate::accounts::Capability::Read,
    )
    .await?;
    authorize_inkvault_path(&headers, &query.path)?;
    let (path, content) = state
        .vaults
        .file_bytes_at_version(&user, &vault, &query.path, &query.hash)
        .await?;
    let sha256 = crate::binary_store::sha256_hex(&content);
    Ok((
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                crate::webdav::content_type_for(&path).to_string(),
            ),
            (header::CONTENT_LENGTH, content.len().to_string()),
            (header::ETAG, format!("\"{sha256}\"")),
            (header::CACHE_CONTROL, "private, max-age=0".to_string()),
            (header::HeaderName::from_static("x-content-sha256"), sha256),
        ],
        content,
    )
        .into_response())
}

async fn resolve(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((user, vault)): Path<(String, String)>,
    Json(request): Json<ResolveRequest>,
) -> Result<Json<SyncResponse>, ApiError> {
    authorize_vault_client(
        &state,
        &headers,
        &user,
        &vault,
        crate::accounts::Capability::ReadWrite,
        Some(&request.client_id),
    )
    .await?;
    Ok(Json(
        state
            .vaults
            .resolve_with_sources(&user, &vault, request, inkvault_client(&headers))
            .await?,
    ))
}

async fn devices(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((user, vault)): Path<(String, String)>,
) -> Result<Json<Vec<DeviceEntry>>, ApiError> {
    authorize_vault(
        &state,
        &headers,
        &user,
        &vault,
        crate::accounts::Capability::Read,
    )
    .await?;
    Ok(Json(state.vaults.list_devices(&user, &vault).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingConflictsQuery {
    client_id: String,
}

async fn pending_conflicts(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((user, vault)): Path<(String, String)>,
    Query(query): Query<PendingConflictsQuery>,
) -> Result<Json<Vec<SyncConflict>>, ApiError> {
    authorize_vault(
        &state,
        &headers,
        &user,
        &vault,
        crate::accounts::Capability::Read,
    )
    .await?;
    Ok(Json(
        state
            .vaults
            .pending_conflicts_for(&user, &vault, &query.client_id)
            .await?,
    ))
}

#[derive(Debug, Deserialize)]
struct DeviceVersionsQuery {
    path: String,
}

async fn device_versions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((user, vault)): Path<(String, String)>,
    Query(query): Query<DeviceVersionsQuery>,
) -> Result<Json<Vec<DeviceVersionEntry>>, ApiError> {
    authorize_vault(
        &state,
        &headers,
        &user,
        &vault,
        crate::accounts::Capability::Read,
    )
    .await?;
    Ok(Json(
        state
            .vaults
            .device_versions(&user, &vault, &query.path)
            .await?,
    ))
}

async fn set_version_metadata(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((user, vault)): Path<(String, String)>,
    Json(request): Json<VersionMetadataRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize_vault(
        &state,
        &headers,
        &user,
        &vault,
        crate::accounts::Capability::ReadWrite,
    )
    .await?;
    state
        .vaults
        .set_version_metadata(&user, &vault, request)
        .await?;
    Ok(Json(serde_json::json!({})))
}

#[derive(Debug, Deserialize)]
struct FileQuery {
    path: String,
    hash: String,
}

async fn list_device_passwords(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((user, vault)): Path<(String, String)>,
) -> Result<Json<Vec<DevicePasswordEntry>>, ApiError> {
    authorize_vault(
        &state,
        &headers,
        &user,
        &vault,
        crate::accounts::Capability::Read,
    )
    .await?;
    Ok(Json(state.device_passwords.list(&user, &vault).await?))
}

async fn create_device_password(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((user, vault)): Path<(String, String)>,
    Json(request): Json<CreateDevicePasswordRequest>,
) -> Result<Json<CreatedDevicePassword>, ApiError> {
    authorize_vault(
        &state,
        &headers,
        &user,
        &vault,
        crate::accounts::Capability::ReadWrite,
    )
    .await?;
    if !state.vaults.is_registered(&user, &vault).await {
        return Err(ApiError(anyhow::anyhow!(
            "invalid vault: sync this vault from Obsidian once before creating device passwords"
        )));
    }
    Ok(Json(
        state
            .device_passwords
            .create(&user, &vault, request)
            .await?,
    ))
}

async fn revoke_device_password(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((user, vault, id)): Path<(String, String, String)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authorize_vault(
        &state,
        &headers,
        &user,
        &vault,
        crate::accounts::Capability::ReadWrite,
    )
    .await?;
    if !state.device_passwords.revoke(&user, &vault, &id).await? {
        return Err(ApiError(anyhow::anyhow!("not found: device password")));
    }
    Ok(Json(serde_json::json!({ "revoked": true })))
}

async fn authorize(
    state: &AppState,
    headers: &HeaderMap,
    requested_user: &str,
) -> Result<(), ApiError> {
    let auth = state.auth.verify_headers(headers).await?;
    tracing::debug!(subject = %auth.subject, user = %auth.user, requested_user = %requested_user, "authorized request");
    if auth.user != requested_user {
        return Err(ApiError(anyhow::anyhow!(
            "forbidden: token user {} cannot access {}",
            auth.user,
            requested_user
        )));
    }
    Ok(())
}

pub(crate) async fn authorize_vault(
    state: &AppState,
    headers: &HeaderMap,
    user: &str,
    vault: &str,
    capability: crate::accounts::Capability,
) -> Result<(), ApiError> {
    authorize_vault_client(state, headers, user, vault, capability, None).await
}
async fn authorize_vault_client(
    state: &AppState,
    headers: &HeaderMap,
    user: &str,
    vault: &str,
    capability: crate::accounts::Capability,
    client: Option<&str>,
) -> Result<(), ApiError> {
    if !state.vaults.uses_published_storage() {
        return authorize(state, headers, user).await;
    }
    let auth = state.auth.verify_headers(headers).await?;
    if auth.user != user {
        return Err(ApiError(anyhow::anyhow!("not found: share")));
    }
    let principal = state.auth.membership_principal(&auth)?;
    let publication = state.vaults.publication()?;
    if let Some(mapping) = publication
        .mappings
        .iter()
        .find(|m| m.user == user && m.vault == vault)
    {
        let client = client
            .or_else(|| {
                headers
                    .get("x-obsidisync-client-id")
                    .and_then(|value| value.to_str().ok())
            })
            .unwrap_or("namespace");
        crate::compatibility::record(
            &state.vaults.data_dir,
            mapping,
            "native",
            &crate::compatibility::client_id(client),
        )?;
    }
    publication.authorize_legacy(&state.vaults.data_dir, user, vault, &principal, capability)?;
    Ok(())
}

async fn authorized_feed(
    state: &AppState,
    auth: &crate::auth::AuthContext,
    legacy: bool,
) -> Result<Vec<ActivityFeedEntry>, ApiError> {
    if !state.vaults.uses_published_storage() {
        return Ok(state.vaults.activity_feed(&auth.user, 50).await?);
    }
    let publication = state.vaults.publication()?;
    let accounts = crate::accounts::AccountStore::load(&state.vaults.data_dir)?;
    let principal = state.auth.membership_principal(auth)?;
    let mut feed = vec![];
    for share in &accounts.shares {
        if !publication.available(&share.id) || accounts.capability(&share.id, &principal).is_none()
        {
            continue;
        }
        if legacy {
            let Some(mapping) = publication.mappings.iter().find(|m| {
                m.user == auth.user
                    && m.share_id == share.id
                    && m.native_enabled
                    && m.principals.contains(&principal)
            }) else {
                continue;
            };
            crate::compatibility::record(
                &state.vaults.data_dir,
                mapping,
                "native",
                &crate::compatibility::client_id("namespace"),
            )?;
        }
        let service = state.vaults.for_share(&share.id)?;
        let mut entries = service.vault_activity("share", &share.id, 50).await?;
        if legacy {
            let mapping = publication
                .mappings
                .iter()
                .find(|m| m.user == auth.user && m.share_id == share.id)
                .unwrap();
            for e in &mut entries {
                e.vault = mapping.vault.clone();
            }
        }
        feed.extend(entries);
    }
    feed.sort_by(|l, r| r.date.cmp(&l.date));
    feed.truncate(50);
    Ok(feed)
}

pub(crate) fn redirect_with_site_session(
    location: &str,
    access_token: &str,
    secure: bool,
) -> Response {
    let secure_attribute = if secure { "; Secure" } else { "" };
    (
        StatusCode::SEE_OTHER,
        [
            (header::LOCATION, location.to_string()),
            (
                header::SET_COOKIE,
                // Lax, not Strict: after an OIDC login the browser arrives here through a
                // cross-site redirect from the issuer, and Strict cookies are withheld on the
                // navigations that follow it, which would loop the login forever.
                format!(
                    "{SITE_SESSION_COOKIE}={}; Path=/; Max-Age={SITE_SESSION_COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax{secure_attribute}",
                    cookie_encode(access_token),
                ),
            ),
        ],
    )
        .into_response()
}

pub(crate) fn site_session_cookie_is_secure(headers: &HeaderMap) -> bool {
    header_contains_token(headers, "x-forwarded-proto", "https")
        || header_contains_token(headers, "x-forwarded-ssl", "on")
        || headers
            .get("forwarded")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value
                    .split([',', ';'])
                    .any(|part| part.trim().eq_ignore_ascii_case("proto=https"))
            })
}

fn header_contains_token(headers: &HeaderMap, name: &str, expected: &str) -> bool {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(',')
                .any(|part| part.trim().eq_ignore_ascii_case(expected))
        })
}

fn redirect_to_login() -> Response {
    (StatusCode::SEE_OTHER, [(header::LOCATION, "/login")]).into_response()
}

pub(crate) fn site_session_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find_map(|(name, value)| {
            (name == SITE_SESSION_COOKIE).then(|| cookie_decode(value).unwrap_or_default())
        })
        .filter(|value| !value.is_empty())
}

fn cookie_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

fn cookie_decode(value: &str) -> Option<String> {
    let mut output = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = value.get(index + 1..index + 3)?;
            output.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).ok()
}

fn inkvault_client(headers: &HeaderMap) -> bool {
    headers
        .get("x-obsidisync-client-features")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|f| f.trim() == crate::inkvault::FEATURE))
}
pub(crate) fn authorize_inkvault_path(headers: &HeaderMap, path: &str) -> Result<(), ApiError> {
    if crate::inkvault::is_source(path) && !inkvault_client(headers) {
        return Err(anyhow::anyhow!("InkNote source requires inkVaultNotesV1").into());
    }
    Ok(())
}

async fn resolve_inkvault(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path((user, vault)): Path<(String, String)>,
    Json(request): Json<SyncRequest>,
) -> Result<Json<SyncResponse>, ApiError> {
    authorize_vault_client(
        &state,
        &headers,
        &user,
        &vault,
        crate::accounts::Capability::ReadWrite,
        Some(&request.client_id),
    )
    .await?;
    if !inkvault_client(&headers) {
        return Err(anyhow::anyhow!("paired resolution requires inkVaultNotesV1").into());
    }
    Ok(Json(
        state
            .vaults
            .resolve_inkvault(&user, &vault, request)
            .await?,
    ))
}

#[cfg(test)]
mod password_throttle_route_tests {
    use super::*;
    use crate::auth_throttle::IP_FAILURE_LIMIT;
    use axum::body::Body;
    use tower::ServiceExt;

    async fn app() -> Router {
        let root = tempfile::tempdir().unwrap().keep();
        let auth = AuthVerifier::password("alice".to_string(), &root).unwrap();
        let mut accounts = crate::accounts::AccountStore::default();
        accounts
            .create_account("alice", "correct horse battery staple")
            .unwrap();
        accounts.save(&root).unwrap();
        router(
            AppState::new(
                VaultService::new_for_tests(root),
                auth,
                PublicAuthConfig::Password,
            ),
            1024 * 1024,
            Vec::new(),
        )
    }

    fn json_login(password: &str) -> axum::http::Request<Body> {
        axum::http::Request::builder()
            .method("POST")
            .uri("/v1/auth/password/login")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(format!(
                r#"{{"username":"alice","password":"{password}"}}"#
            )))
            .unwrap()
    }

    fn form_login(password: &str) -> axum::http::Request<Body> {
        axum::http::Request::builder()
            .method("POST")
            .uri("/login")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(Body::from(format!("username=alice&password={password}")))
            .unwrap()
    }

    async fn assert_lockout(
        app: Router,
        request: fn(&str) -> axum::http::Request<Body>,
        failure_status: StatusCode,
    ) {
        for _ in 0..IP_FAILURE_LIMIT - 1 {
            assert_eq!(
                app.clone()
                    .oneshot(request("wrong-password"))
                    .await
                    .unwrap()
                    .status(),
                failure_status
            );
        }
        let response = app
            .clone()
            .oneshot(request("wrong-password"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(response
            .headers()
            .get(header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .is_some_and(|v| v > 0));
    }

    async fn assert_success_resets(
        app: Router,
        request: fn(&str) -> axum::http::Request<Body>,
        failure_status: StatusCode,
    ) {
        for _ in 0..IP_FAILURE_LIMIT - 1 {
            let _ = app
                .clone()
                .oneshot(request("wrong-password"))
                .await
                .unwrap();
        }
        let response = app
            .clone()
            .oneshot(request("correct horse battery staple"))
            .await
            .unwrap();
        assert!(response.status().is_success() || response.status().is_redirection());
        let response = app
            .clone()
            .oneshot(request("wrong-password"))
            .await
            .unwrap();
        assert_eq!(response.status(), failure_status);
    }

    #[tokio::test]
    async fn password_json_login_is_throttled_and_success_resets() {
        assert_lockout(app().await, json_login, StatusCode::UNAUTHORIZED).await;
        assert_success_resets(app().await, json_login, StatusCode::UNAUTHORIZED).await;
    }

    #[tokio::test]
    async fn password_browser_form_is_throttled_and_success_resets() {
        assert_lockout(app().await, form_login, StatusCode::OK).await;
        assert_success_resets(app().await, form_login, StatusCode::OK).await;
    }
}
