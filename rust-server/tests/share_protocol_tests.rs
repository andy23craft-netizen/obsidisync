//! Protocol authorization matrix using published shares and synthetic credentials.
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use obsidian_git_sync_server::{
    accounts::{AccountStore, Capability, Membership, Principal},
    auth::AuthVerifier,
    http::{router, AppState, PublicAuthConfig},
    publication::Mapping,
    vault::{UploadLimits, VaultService, VaultServiceOptions},
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::Path};
use tower::ServiceExt;
const PASSWORD: &str = "synthetic-password-123456";

#[tokio::test]
async fn development_principals_require_explicit_membership_and_namespace_and_obey_revocation() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().join("data");
    let mut accounts = AccountStore::default();
    // A local account with the same username must never supply development membership.
    let local = accounts.create_account("dev-fixture", PASSWORD).unwrap();
    let dev = Principal::Development {
        user: "dev-fixture".into(),
    };
    let share = accounts.create_share("Development fixture").unwrap();
    let private = accounts.create_share("Other namespace").unwrap();
    accounts.shares[0].members.push(Membership {
        principal: dev.clone(),
        capability: Capability::ReadWrite,
    });
    accounts.shares[1].members.push(Membership {
        principal: Principal::Local { account_id: local },
        capability: Capability::ReadWrite,
    });
    accounts.save(&root).unwrap();
    assert_eq!(
        accounts.capability(
            &share,
            &Principal::Oidc {
                issuer: "https://fixture.example.invalid".into(),
                subject: "dev-fixture".into()
            }
        ),
        None
    );
    obsidian_git_sync_server::migration::initialize(&root).unwrap();
    for (id, vault, principal) in [
        (&share, "notes", dev.clone()),
        (
            &private,
            "private",
            accounts.shares[1].members[0].principal.clone(),
        ),
    ] {
        let path = fixture.path().join(format!("{vault}.json"));
        fs::write(&path, serde_json::to_vec(&json!({
            "registration":{"remoteUrl":"","branch":"main","authorName":"Synthetic","authorEmail":"fixture@example.invalid"},
            "mapping":Mapping { user:"dev-fixture".into(), vault:vault.into(), share_id:id.clone(), principals:vec![principal], native_enabled:true, dav_enabled:true }
        })).unwrap()).unwrap();
        obsidian_git_sync_server::admin::execute(
            &root,
            &["share", "setup", id, path.to_str().unwrap()].map(String::from),
        )
        .await
        .unwrap();
    }
    let service = || {
        VaultService::published(VaultServiceOptions {
            data_dir: root.clone(),
            remote_policy: Default::default(),
            upload_limits: UploadLimits::default(),
        })
    };
    let verifier = || AuthVerifier::StaticTokenForDev {
        token: "synthetic-dev-token".into(),
        user: "dev-fixture".into(),
    };
    let make_app = || {
        router(
            AppState::new(service(), verifier(), PublicAuthConfig::Token),
            1024 * 1024,
            vec![],
        )
    };
    let app = make_app();
    let bearer = "Bearer synthetic-dev-token";
    let registration = json!({"remoteUrl":"","branch":"main","authorName":"Synthetic","authorEmail":"fixture@example.invalid"});
    assert_eq!(
        call(
            &app,
            "POST",
            "/v1/users/dev-fixture/vaults/notes/register",
            bearer,
            registration.clone(),
            &[]
        )
        .await
        .0,
        StatusCode::OK
    );
    let changes = json!({"clientId":"synthetic-dev","deviceName":"Synthetic","baseHead":null,"clientManifest":[],"changes":[{"op":"upsert","path":"dev.md","contentBase64":"ZGV2Cg=="}]});
    assert_eq!(
        call(
            &app,
            "POST",
            "/v1/users/dev-fixture/vaults/notes/sync",
            bearer,
            changes.clone(),
            &[]
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(root
        .join("shares")
        .join(&share)
        .join("repo/dev.md")
        .exists());
    assert!(!root.join("users/dev-fixture/vaults/notes").exists());
    for path in [
        format!("/v2/shares/{private}/sync-state"),
        "/v1/users/dev-fixture/vaults/private/devices".into(),
        "/v1/users/dev-fixture/vaults/unmapped/devices".into(),
        "/v1/users/other/vaults/notes/devices".into(),
    ] {
        assert_eq!(
            call(&app, "GET", &path, bearer, json!({}), &[]).await.0,
            StatusCode::NOT_FOUND,
            "{path}"
        );
    }
    // An explicitly selected production verifier cannot authenticate a development token,
    // regardless of development memberships persisted in the account store.
    let password = AuthVerifier::password(String::new(), &root).unwrap();
    let local_session = password
        .login_password("dev-fixture", PASSWORD)
        .await
        .unwrap();
    let production = router(
        AppState::new(service(), password, PublicAuthConfig::Password),
        1024 * 1024,
        vec![],
    );
    assert_eq!(
        call(
            &production,
            "GET",
            &format!("/v2/shares/{share}/sync-state"),
            bearer,
            json!({}),
            &[]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &production,
            "GET",
            &format!("/v2/shares/{share}/sync-state"),
            &format!("Bearer {}", local_session.access_token),
            json!({}),
            &[]
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    accounts.shares[1].members.push(Membership {
        principal: dev.clone(),
        capability: Capability::ReadWrite,
    });
    accounts.save(&root).unwrap();
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/v2/shares/{private}/sync-state"),
            bearer,
            json!({}),
            &[]
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &app,
            "GET",
            "/v1/users/dev-fixture/vaults/private/devices",
            bearer,
            json!({}),
            &[]
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    accounts.shares[1].members.pop();
    accounts.shares[0].members[0].capability = Capability::Read;
    accounts.save(&root).unwrap();
    let before = snapshot(&root.join("shares"));
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/v2/shares/{share}/sync-state"),
            bearer,
            json!({}),
            &[]
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/v1/users/dev-fixture/vaults/notes/register",
            bearer,
            registration,
            &[]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/v2/shares/{share}/sync"),
            bearer,
            changes,
            &[]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(before, snapshot(&root.join("shares")));
    // Token rotation and restart preserve the distinct identity; neither recreates membership.
    let rotated = AuthVerifier::StaticTokenForDev {
        token: "synthetic-rotated-token".into(),
        user: "dev-fixture".into(),
    };
    let context = rotated
        .verify_bearer_token("synthetic-rotated-token")
        .await
        .unwrap();
    assert_eq!(rotated.membership_principal(&context).unwrap(), dev);
    assert!(rotated
        .verify_bearer_token("synthetic-dev-token")
        .await
        .is_err());
    let rotated_app = router(
        AppState::new(service(), rotated, PublicAuthConfig::Token),
        1024 * 1024,
        vec![],
    );
    assert_eq!(
        call(
            &rotated_app,
            "GET",
            &format!("/v2/shares/{share}/sync-state"),
            "Bearer synthetic-rotated-token",
            json!({}),
            &[]
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &rotated_app,
            "GET",
            &format!("/v2/shares/{share}/sync-state"),
            bearer,
            json!({}),
            &[]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    accounts.shares[0].members.clear();
    accounts.save(&root).unwrap();
    for candidate in [app, make_app()] {
        assert_eq!(
            call(
                &candidate,
                "GET",
                &format!("/v2/shares/{share}/sync-state"),
                bearer,
                json!({}),
                &[]
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            call(
                &candidate,
                "GET",
                "/v1/users/dev-fixture/vaults/notes/devices",
                bearer,
                json!({}),
                &[]
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
    }
}
fn snapshot(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn visit(root: &Path, path: &Path, result: &mut BTreeMap<String, Vec<u8>>) {
        for entry in fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                visit(root, &entry.path(), result);
            } else {
                result.insert(
                    entry
                        .path()
                        .strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    fs::read(entry.path()).unwrap(),
                );
            }
        }
    }
    let mut result = BTreeMap::new();
    visit(root, root, &mut result);
    result
}
async fn call(
    app: &axum::Router,
    method: &str,
    path: &str,
    auth: &str,
    body: Value,
    headers: &[(&str, &str)],
) -> (StatusCode, Vec<u8>) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", auth)
        .header("content-type", "application/json");
    for (name, value) in headers {
        req = req.header(*name, *value);
    }
    let response = app
        .clone()
        .oneshot(
            req.body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    (
        status,
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
}
#[tokio::test]
async fn every_share_route_denies_nonmembers_and_readonly_requests_preserve_storage() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().join("data");
    let mut accounts = AccountStore::default();
    let alice = accounts.create_account("alice", PASSWORD).unwrap();
    let bob = accounts.create_account("bob", PASSWORD).unwrap();
    let private = accounts.create_share("Private canary").unwrap();
    let shared = accounts.create_share("Shared fixture").unwrap();
    let alice_principal = Principal::Local { account_id: alice };
    let bob_principal = Principal::Local { account_id: bob };
    accounts.shares[0].members.push(Membership {
        principal: alice_principal.clone(),
        capability: Capability::ReadWrite,
    });
    accounts.shares[1].members = vec![
        Membership {
            principal: alice_principal.clone(),
            capability: Capability::ReadWrite,
        },
        Membership {
            principal: bob_principal,
            capability: Capability::Read,
        },
    ];
    accounts.save(&root).unwrap();
    obsidian_git_sync_server::migration::initialize(&root).unwrap();
    for (share, vault) in [(&private, "private"), (&shared, "shared")] {
        let path = fixture.path().join(format!("{vault}-setup.json"));
        fs::write(&path,serde_json::to_vec(&json!({"registration":{"remoteUrl":"","branch":"main","authorName":"Fixture","authorEmail":"fixture@example.invalid"},
            "mapping":Mapping {user:"alice".into(),vault:vault.into(),share_id:share.clone(),principals:vec![alice_principal.clone()],native_enabled:true,dav_enabled:true}})).unwrap()).unwrap();
        obsidian_git_sync_server::admin::execute(
            &root,
            &["share", "setup", share, path.to_str().unwrap()].map(String::from),
        )
        .await
        .unwrap();
    }
    let auth = AuthVerifier::password(String::new(), &root).unwrap();
    let alice_auth = format!(
        "Bearer {}",
        auth.login_password("alice", PASSWORD)
            .await
            .unwrap()
            .access_token
    );
    let bob_auth = format!(
        "Bearer {}",
        auth.login_password("bob", PASSWORD)
            .await
            .unwrap()
            .access_token
    );
    let state = AppState::new(
        VaultService::published(VaultServiceOptions {
            data_dir: root.clone(),
            remote_policy: Default::default(),
            upload_limits: UploadLimits::default(),
        }),
        auth,
        PublicAuthConfig::Password,
    );
    let app = router(state.clone(), 1024 * 1024, vec![]);
    let sync = json!({"clientId":"fixture-writer","deviceName":"Synthetic","baseHead":null,"clientManifest":[],"changes":[{"op":"upsert","path":"canary.md","contentBase64":"c3ludGhldGljIHByaXZhdGUgY2FuYXJ5Cg=="}]});
    let (status, result) = call(
        &app,
        "POST",
        &format!("/v2/shares/{private}/sync"),
        &alice_auth,
        sync.clone(),
        &[],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&result)
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/v2/shares/{shared}/sync"),
            &alice_auth,
            sync,
            &[]
        )
        .await
        .0,
        StatusCode::OK
    );
    let head: Value = serde_json::from_slice(&result).unwrap();
    let head = head["serverHead"].as_str().unwrap();
    let routes = [
        ("GET", "sync-state"),
        ("POST", "sync"),
        ("POST", "register"),
        ("POST", "uploads"),
        ("POST", "uploads/00000000000000000000000000000000/chunk"),
        ("POST", "uploads/00000000000000000000000000000000/complete"),
        ("GET", "history?path=canary.md"),
        (
            "GET",
            "file?path=canary.md&hash=0000000000000000000000000000000000000000",
        ),
        (
            "GET",
            "blob?path=canary.md&hash=0000000000000000000000000000000000000000",
        ),
        (
            "HEAD",
            "blob?path=canary.md&hash=0000000000000000000000000000000000000000",
        ),
        ("POST", "resolve"),
        ("POST", "inkvault/resolve"),
        ("GET", "devices"),
        ("GET", "conflicts?clientId=fixture"),
        ("GET", "files/device-versions?path=canary.md"),
        ("GET", "files/version-metadata"),
        ("POST", "files/version-metadata"),
        ("GET", "feed"),
        ("GET", "device-passwords"),
        ("POST", "device-passwords"),
        ("DELETE", "device-passwords/c_missing"),
    ];
    let before = snapshot(&root.join("shares").join(&private));
    for (method, path) in routes {
        let existing = call(
            &app,
            method,
            &format!("/v2/shares/{private}/{path}"),
            &bob_auth,
            Value::Null,
            &[],
        )
        .await;
        let missing = call(
            &app,
            method,
            &format!("/v2/shares/s_missing/{path}"),
            &bob_auth,
            Value::Null,
            &[],
        )
        .await;
        assert_eq!(
            existing.0,
            StatusCode::NOT_FOUND,
            "{method} {path}: {}",
            String::from_utf8_lossy(&existing.1)
        );
        assert_eq!(
            existing, missing,
            "inaccessible/nonexistent response equivalence: {method} {path}"
        );
        if path != "sync-state"
            && path != "feed"
            && !(method == "GET" && path == "files/version-metadata")
        {
            let payload = match path {
                "register" => {
                    json!({"remoteUrl":"","branch":"main","authorName":"Synthetic","authorEmail":"fixture@example.invalid"})
                }
                "sync" | "inkvault/resolve" => {
                    json!({"clientId":"synthetic","deviceName":"Synthetic","baseHead":null,"clientManifest":[],"changes":[]})
                }
                "resolve" => json!({"clientId":"synthetic","deviceName":"Synthetic","files":[]}),
                "uploads" => {
                    json!({"path":"synthetic.pdf","sha256":"0000000000000000000000000000000000000000000000000000000000000000","size":1})
                }
                "files/version-metadata" => {
                    json!({"path":"canary.md","hash":"0000000000000000000000000000000000000000"})
                }
                "device-passwords" if method == "POST" => {
                    json!({"label":"Synthetic","folder":"Tablet"})
                }
                _ if path.ends_with("/chunk") => json!({"offset":0,"contentBase64":"eA=="}),
                _ => Value::Null,
            };
            let denied = call(
                &app,
                method,
                &format!("/v1/users/alice/vaults/private/{path}"),
                &bob_auth,
                payload.clone(),
                &[],
            )
            .await;
            let absent = call(
                &app,
                method,
                &format!("/v1/users/alice/vaults/missing/{path}"),
                &bob_auth,
                payload,
                &[],
            )
            .await;
            assert_eq!(
                denied.0,
                StatusCode::NOT_FOUND,
                "v1 {method} {path}: {}",
                String::from_utf8_lossy(&denied.1)
            );
            assert_eq!(denied, absent, "v1 response equivalence: {method} {path}");
        }
    }
    assert_eq!(snapshot(&root.join("shares").join(&private)), before);
    let cookie = format!(
        "obsidisync_session={}",
        bob_auth.strip_prefix("Bearer ").unwrap()
    );
    let (browser_status, browser_feed) = call(
        &app,
        "GET",
        "/change-feed",
        &bob_auth,
        Value::Null,
        &[("cookie", &cookie)],
    )
    .await;
    assert_eq!(browser_status, StatusCode::OK);
    let browser_text = String::from_utf8_lossy(&browser_feed);
    assert!(browser_text.contains(&shared));
    assert!(!browser_text.contains("Private canary"));
    assert!(!browser_text.contains(&private));
    let (status, listed) = call(&app, "GET", "/v2/shares", &bob_auth, Value::Null, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!String::from_utf8_lossy(&listed).contains(&private));
    let before = snapshot(&root.join("shares").join(&shared));
    for path in [
        "sync-state",
        "history",
        "devices",
        "conflicts?clientId=reader",
        "files/device-versions?path=canary.md",
        "files/version-metadata",
        "feed",
        "device-passwords",
    ] {
        assert_eq!(
            call(
                &app,
                "GET",
                &format!("/v2/shares/{shared}/{path}"),
                &bob_auth,
                Value::Null,
                &[]
            )
            .await
            .0,
            StatusCode::OK,
            "{path}"
        );
    }
    let read = json!({"clientId":"reader","deviceName":"Synthetic","baseHead":null,"clientManifest":[],"changes":[]});
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/v2/shares/{shared}/sync"),
            &bob_auth,
            read,
            &[]
        )
        .await
        .0,
        StatusCode::OK
    );
    for path in [
        "register",
        "uploads",
        "uploads/00000000000000000000000000000000/chunk",
        "uploads/00000000000000000000000000000000/complete",
        "resolve",
        "inkvault/resolve",
        "files/version-metadata",
        "device-passwords",
    ] {
        assert_eq!(
            call(
                &app,
                "POST",
                &format!("/v2/shares/{shared}/{path}"),
                &bob_auth,
                Value::Null,
                &[]
            )
            .await
            .0,
            StatusCode::FORBIDDEN,
            "{path}"
        );
    }
    assert_eq!(snapshot(&root.join("shares").join(&shared)), before);
    let (_, file) = call(
        &app,
        "GET",
        &format!("/v2/shares/{private}/file?path=canary.md&hash={head}"),
        &alice_auth,
        Value::Null,
        &[],
    )
    .await;
    assert!(String::from_utf8_lossy(&file).contains("contentBase64"));
    let (status, issued) = call(
        &app,
        "POST",
        &format!("/v2/shares/{shared}/device-passwords"),
        &bob_auth,
        json!({"label":"Synthetic read-only device","folder":"/Folder/","capability":"read"}),
        &[],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&issued)
    );
    let issued: Value = serde_json::from_slice(&issued).unwrap();
    assert_eq!(issued["capability"], "read");
    assert_eq!(issued["username"], shared);
    assert_eq!(issued["webdavPath"], format!("/dav/{shared}/Folder/"));
    assert!(obsidian_git_sync_server::grants::authenticate(
        &state,
        Some(&shared),
        issued["password"].as_str().unwrap()
    )
    .await
    .is_err());
    let mut credentials = obsidian_git_sync_server::share_credentials::Store::load(&root).unwrap();
    let (id, secret) = credentials
        .create(
            &accounts,
            &shared,
            alice_principal,
            "Folder",
            Capability::Read,
            "Synthetic read grant",
        )
        .unwrap();
    credentials.save(&root).unwrap();
    obsidian_git_sync_server::admin::execute(
        &root,
        &["credential", "share", "activate", &id].map(String::from),
    )
    .await
    .unwrap();
    let basic = format!("Basic {}", STANDARD.encode(format!("{shared}:{secret}")));
    state
        .vaults
        .for_share(&shared)
        .unwrap()
        .dav_write(
            "share",
            &shared,
            "Folder/document.md",
            b"fixture document".to_vec(),
            &obsidian_git_sync_server::vault::dav::DavDevice {
                client_id: "synthetic".into(),
                name: "Synthetic".into(),
            },
        )
        .await
        .unwrap();
    let bearer_grant = format!("Bearer {secret}");
    for auth in [&basic, &bearer_grant] {
        let (status, bytes) = call(
            &app,
            "GET",
            &format!("/dav/{shared}/Folder/document.md"),
            auth,
            Value::Null,
            &[("range", "bytes=0-6")],
        )
        .await;
        assert_eq!(status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(bytes, b"fixture");
        let (status, ocs) = call(
            &app,
            "GET",
            "/ocs/v2.php/cloud/user",
            auth,
            Value::Null,
            &[],
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            serde_json::from_slice::<Value>(&ocs).unwrap()["ocs"]["data"]["id"],
            shared
        );
        assert_eq!(
            call(
                &app,
                "PROPFIND",
                &format!("/remote.php/dav/files/{shared}/Folder"),
                auth,
                Value::Null,
                &[("depth", "0")]
            )
            .await
            .0,
            StatusCode::MULTI_STATUS
        );
    }
    let before_attack = snapshot(&root.join("shares"));
    for path in [
        format!("/dav/{shared}/Folder/%2e%2e/canary.md"),
        format!("/remote.php/dav/files/{shared}/Folder/%2e%2e/canary.md"),
    ] {
        let (status, bytes) = call(&app, "GET", &path, &basic, Value::Null, &[]).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(!String::from_utf8_lossy(&bytes).contains("synthetic private canary"));
    }
    let mismatch = format!("Basic {}", STANDARD.encode(format!("alice:{secret}")));
    assert_eq!(
        call(
            &app,
            "PROPFIND",
            &format!("/dav/{shared}/Folder"),
            &mismatch,
            Value::Null,
            &[("depth", "0")]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(before_attack, snapshot(&root.join("shares")));
    assert_eq!(
        call(
            &app,
            "PROPFIND",
            &format!("/dav/{shared}/Folder"),
            &basic,
            Value::Null,
            &[("depth", "0")]
        )
        .await
        .0,
        StatusCode::MULTI_STATUS
    );
    for method in [
        "PUT",
        "DELETE",
        "MKCOL",
        "MOVE",
        "COPY",
        "PROPPATCH",
        "LOCK",
        "UNLOCK",
    ] {
        assert_eq!(
            call(
                &app,
                method,
                &format!("/dav/{shared}/Folder/file.md"),
                &basic,
                Value::Null,
                &[]
            )
            .await
            .0,
            StatusCode::FORBIDDEN,
            "{method}"
        );
    }
    for path in [
        format!("/dav/{private}/Folder"),
        format!("/remote.php/dav/files/{private}/Folder"),
    ] {
        assert_eq!(
            call(
                &app,
                "PROPFIND",
                &path,
                &basic,
                Value::Null,
                &[("depth", "0")]
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
    }
    let mut credentials = obsidian_git_sync_server::share_credentials::Store::load(&root).unwrap();
    let (writer_id, writer_secret) = credentials
        .create(
            &accounts,
            &shared,
            accounts.shares[1].members[0].principal.clone(),
            "Folder",
            Capability::ReadWrite,
            "Synthetic boundary writer",
        )
        .unwrap();
    credentials.save(&root).unwrap();
    obsidian_git_sync_server::admin::execute(
        &root,
        &["credential", "share", "activate", &writer_id].map(String::from),
    )
    .await
    .unwrap();
    let writer = format!(
        "Basic {}",
        STANDARD.encode(format!("{shared}:{writer_secret}"))
    );
    let before = snapshot(&root.join("shares"));
    for method in ["COPY", "MOVE"] {
        for target in [&private, "s_missing"] {
            assert_eq!(
                call(
                    &app,
                    method,
                    &format!("/dav/{shared}/Folder/document.md"),
                    &writer,
                    Value::Null,
                    &[("destination", &format!("/dav/{target}/Folder/import.md"))]
                )
                .await
                .0,
                StatusCode::NOT_FOUND
            );
        }
    }
    assert_eq!(before, snapshot(&root.join("shares")));
    assert_eq!(
        call(
            &app,
            "GET",
            "/v2/shares",
            &format!("Bearer {secret}"),
            Value::Null,
            &[]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
}
