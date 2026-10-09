//! Share native API. Authentication and capability precede all share storage access.
use crate::accounts::{AccountStore, Capability};
use crate::http::{ApiError, AppState};
use crate::protocol::*;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::{Json, Router};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateGrant {
    label: String,
    folder: String,
    #[serde(default = "default_grant_capability")]
    capability: Capability,
}
fn default_grant_capability() -> Capability {
    Capability::ReadWrite
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/v2/shares", get(list))
        .route("/v2/shares/:share/*path", any(handle))
}
async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let auth = state.auth.verify_headers(&headers).await?;
    let principal = state.auth.membership_principal(&auth)?;
    let publication = state.vaults.publication()?;
    let accounts = AccountStore::load(&state.vaults.data_dir)?;
    let shares: Vec<Value> = accounts
        .shares
        .iter()
        .filter_map(|s| {
            let capability = accounts.capability(&s.id, &principal)?;
            publication
                .available(&s.id)
                .then(|| json!({"shareId":s.id,"label":s.label,"capability":capability}))
        })
        .collect();
    Ok(Json(json!(shares)))
}
fn body<T: DeserializeOwned>(bytes: &Bytes) -> Result<T, ApiError> {
    serde_json::from_slice(bytes).map_err(|_| anyhow::anyhow!("invalid request body").into())
}
fn query<'a>(values: &'a HashMap<String, String>, name: &str) -> Result<&'a str, ApiError> {
    values
        .get(name)
        .map(String::as_str)
        .ok_or_else(|| anyhow::anyhow!("invalid query").into())
}
async fn handle(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    method: Method,
    Path((share, path)): Path<(String, String)>,
    Query(values): Query<HashMap<String, String>>,
    bytes: Bytes,
) -> Result<Response, ApiError> {
    let auth = state.auth.verify_headers(&headers).await?;
    let principal = state.auth.membership_principal(&auth)?;
    let publication = state.vaults.publication()?;
    publication.authorize(&state.vaults.data_dir, &share, &principal, Capability::Read)?;
    let read_sync =
        method == Method::POST && path == "sync" && body::<SyncRequest>(&bytes)?.changes.is_empty();
    let read_grant = method == Method::POST
        && path == "device-passwords"
        && serde_json::from_slice::<Value>(&bytes)
            .ok()
            .is_some_and(|value| value.get("capability").and_then(Value::as_str) == Some("read"));
    if method != Method::GET && method != Method::HEAD && !read_sync && !read_grant {
        publication.authorize(
            &state.vaults.data_dir,
            &share,
            &principal,
            Capability::ReadWrite,
        )?;
    }
    let service = state.vaults.for_share(&share)?;
    let native = headers
        .get("x-obsidisync-client-features")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h.split(',').any(|f| f.trim() == crate::inkvault::FEATURE));
    let parts: Vec<_> = path.split('/').collect();
    if matches!(
        parts.as_slice(),
        ["history"] | ["file"] | ["blob"] | ["files", "device-versions"]
    ) {
        if let Some(path) = values.get("path") {
            crate::http::authorize_inkvault_path(&headers, path)?;
        }
    }
    match (method.as_str(), parts.as_slice()) {
        ("GET", ["sync-state"]) => {
            let current = service.sync_state("share", &share).await?;
            Ok(Json(json!({"shareId":share,"serverHead":current.server_head,"branch":current.branch,
                "capability":AccountStore::load(&state.vaults.data_dir)?.capability(&share,&principal),"apiVersion":2})).into_response())
        }
        ("POST", ["sync"]) => {
            let request: SyncRequest = body(&bytes)?;
            let changed: Vec<String> = request
                .changes
                .iter()
                .map(|change| crate::vault::inkvault::change_path(change).to_string())
                .collect();
            let response = if read_sync {
                service.read_sync("share", &share, request, native).await?
            } else if native
                && request
                    .changes
                    .iter()
                    .any(|c| crate::inkvault::is_source(crate::vault::inkvault::change_path(c)))
            {
                service.sync_inkvault("share", &share, request).await?
            } else {
                service.sync_v2(&share, request, native).await?
            };
            if !read_sync {
                if let Some(mapping) = publication
                    .mappings
                    .iter()
                    .find(|mapping| mapping.share_id == share && mapping.dav_enabled)
                {
                    state
                        .tablet
                        .schedule(&mapping.user, &mapping.vault, changed);
                }
            }
            Ok(Json(response).into_response())
        }
        ("POST", ["uploads"]) => {
            Ok(Json(service.init_upload("share", &share, body(&bytes)?).await?).into_response())
        }
        ("POST", ["uploads", id, "chunk"]) => Ok(Json(
            service
                .append_upload_chunk("share", &share, id, body(&bytes)?)
                .await?,
        )
        .into_response()),
        ("POST", ["uploads", id, "complete"]) => {
            Ok(Json(service.complete_upload("share", &share, id).await?).into_response())
        }
        ("GET", ["history"]) => Ok(Json(
            service
                .history("share", &share, values.get("path").map(String::as_str))
                .await?,
        )
        .into_response()),
        ("GET", ["file"]) => Ok(Json(
            service
                .file_at_version(
                    "share",
                    &share,
                    query(&values, "path")?,
                    query(&values, "hash")?,
                )
                .await?,
        )
        .into_response()),
        ("GET", ["blob"]) | ("HEAD", ["blob"]) => {
            let (path, content) = service
                .file_bytes_at_version(
                    "share",
                    &share,
                    query(&values, "path")?,
                    query(&values, "hash")?,
                )
                .await?;
            let length = content.len();
            let range = match crate::webdav::parse_range(headers.get(header::RANGE), length as u64)
            {
                Ok(range) => range,
                Err(error) => return Ok(error.into_response()),
            };
            let mut response_headers = HeaderMap::new();
            response_headers.insert(
                header::CONTENT_TYPE,
                crate::webdav::content_type_for(&path).parse().unwrap(),
            );
            response_headers.insert(
                header::ETAG,
                format!("\"{}\"", crate::binary_store::sha256_hex(&content))
                    .parse()
                    .unwrap(),
            );
            response_headers.insert(header::CACHE_CONTROL, "private, max-age=0".parse().unwrap());
            response_headers.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
            let (status, download) = if let Some((start, end)) = range {
                response_headers.insert(
                    header::CONTENT_RANGE,
                    format!("bytes {start}-{end}/{length}").parse().unwrap(),
                );
                (
                    StatusCode::PARTIAL_CONTENT,
                    content[start as usize..=end as usize].to_vec(),
                )
            } else {
                (StatusCode::OK, content)
            };
            response_headers.insert(
                header::CONTENT_LENGTH,
                download.len().to_string().parse().unwrap(),
            );
            Ok((
                status,
                response_headers,
                if method == Method::HEAD {
                    vec![]
                } else {
                    download
                },
            )
                .into_response())
        }
        ("POST", ["resolve"]) => Ok(Json(
            service
                .resolve_with_sources("share", &share, body(&bytes)?, native)
                .await?,
        )
        .into_response()),
        ("POST", ["inkvault", "resolve"]) if native => Ok(Json(
            service
                .resolve_inkvault("share", &share, body(&bytes)?)
                .await?,
        )
        .into_response()),
        ("GET", ["devices"]) => {
            Ok(Json(service.list_devices("share", &share).await?).into_response())
        }
        ("GET", ["conflicts"]) => Ok(Json(
            service
                .pending_conflicts_for("share", &share, query(&values, "clientId")?)
                .await?,
        )
        .into_response()),
        ("GET", ["files", "device-versions"]) => Ok(Json(
            service
                .device_versions("share", &share, query(&values, "path")?)
                .await?,
        )
        .into_response()),
        ("GET", ["files", "version-metadata"]) => Ok(Json(
            crate::version_registry::read_version_metadata(
                &service
                    .storage_root("share", &share)?
                    .join("version-metadata.json"),
            )
            .await?,
        )
        .into_response()),
        ("POST", ["files", "version-metadata"]) => {
            service
                .set_version_metadata("share", &share, body(&bytes)?)
                .await?;
            Ok(Json(json!({})).into_response())
        }
        ("GET", ["feed"]) => {
            Ok(Json(service.vault_activity("share", &share, 50).await?).into_response())
        }
        ("GET", ["device-passwords"]) => {
            let store = crate::share_credentials::Store::load(&state.vaults.data_dir)?;
            let grants: Vec<Value> = store.credentials.iter().filter(|c| c.share_id == share).map(|c| json!({"id":c.id,
                "shareId":c.share_id,"folder":c.folder,"capability":c.capability,"label":c.label,"kind":c.kind,
                "lifecycle":if publication.activated.contains(&c.id) { "active" } else { "staged" }})).collect();
            Ok(Json(json!(grants)).into_response())
        }
        ("POST", ["device-passwords"]) => {
            let operations = crate::grants::operation_lock(&state.vaults.data_dir);
            let _mutation = operations.write().await;
            let request: CreateGrant = body(&bytes)?;
            let folder = crate::device_passwords::validate_device_folder(&request.folder)?;
            let accounts = AccountStore::load(&state.vaults.data_dir)?;
            let mut store = crate::share_credentials::Store::load(&state.vaults.data_dir)?;
            let (id, secret) = store.create(
                &accounts,
                &share,
                principal,
                &folder,
                request.capability,
                &request.label,
            )?;
            store.save(&state.vaults.data_dir)?;
            let dav_path = crate::device_passwords::webdav_path(&share, &folder);
            let nextcloud_path = format!(
                "/remote.php/dav/files/{}",
                dav_path.strip_prefix("/dav/").unwrap()
            );
            Ok(Json(
                json!({"id":id,"password":secret,"shareId":share,"username":share,
                "webdavPath":dav_path,"nextcloudPath":nextcloud_path,
                "capability":request.capability,"lifecycle":"staged"}),
            )
            .into_response())
        }
        ("DELETE", ["device-passwords", id]) => {
            let operations = crate::grants::operation_lock(&state.vaults.data_dir);
            let _revocation = operations.write().await;
            let mut store = crate::share_credentials::Store::load(&state.vaults.data_dir)?;
            if !store
                .credentials
                .iter()
                .any(|c| c.id == *id && c.share_id == share)
            {
                return Err(anyhow::anyhow!("not found: credential").into());
            }
            let mut next = state.vaults.publication()?;
            next.activated.retain(|c| c != id);
            next.generation += 1;
            next.save(&state.vaults.data_dir)?;
            store.revoke(id)?;
            store.save(&state.vaults.data_dir)?;
            Ok(Json(json!({"revoked":true})).into_response())
        }
        _ => Ok(StatusCode::METHOD_NOT_ALLOWED.into_response()),
    }
}
