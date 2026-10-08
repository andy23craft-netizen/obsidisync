//! Disposable FEAT-03 fixtures: publication is exercised, never bypassed by the router.
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use obsidian_git_sync_server::{
    accounts::{AccountStore, Capability, Membership, Principal},
    auth::AuthVerifier,
    http::{router, AppState, PublicAuthConfig},
    migration::{self, Plan},
    protocol::RegisterRequest,
    publication::{Mapping, Publication},
    remote::RemotePolicy,
    vault::{UploadLimits, VaultService, VaultServiceOptions},
};
use serde_json::{json, Value};
use std::{fs, path::Path};
use tower::ServiceExt;

const PASSWORD: &str = "synthetic-fixture-password-123";
fn copy(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}
async fn request(
    app: &axum::Router,
    method: &str,
    path: &str,
    auth: &str,
    body: Value,
) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", auth)
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
fn options(root: &Path) -> VaultServiceOptions {
    VaultServiceOptions {
        data_dir: root.into(),
        remote_policy: RemotePolicy::default(),
        upload_limits: UploadLimits::default(),
    }
}

#[tokio::test]
async fn mapped_writable_v1_and_v2_share_one_root_and_independent_activated_grants() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().join("data");
    let backup = fixture.path().join("backup");
    let mut accounts = AccountStore::default();
    let alice = accounts.create_account("alice", PASSWORD).unwrap();
    let bob = accounts.create_account("bob", PASSWORD).unwrap();
    let share = accounts.create_share("Shared fixture").unwrap();
    let principal = Principal::Local {
        account_id: alice.clone(),
    };
    accounts.shares[0].members = vec![
        Membership {
            principal: principal.clone(),
            capability: Capability::ReadWrite,
        },
        Membership {
            principal: Principal::Local { account_id: bob },
            capability: Capability::Read,
        },
    ];
    accounts.save(&root).unwrap();
    let legacy = VaultService::legacy_for_fixture(root.clone());
    legacy
        .register(
            "alice",
            "notes",
            RegisterRequest {
                remote_url: String::new(),
                branch: "main".into(),
                author_name: "Synthetic".into(),
                author_email: "fixture@example.invalid".into(),
            },
        )
        .await
        .unwrap();
    legacy
        .register(
            "alice",
            "offline",
            RegisterRequest {
                remote_url: String::new(),
                branch: "main".into(),
                author_name: "Synthetic".into(),
                author_email: "fixture@example.invalid".into(),
            },
        )
        .await
        .unwrap();
    let excluded_grant =
        obsidian_git_sync_server::device_passwords::DevicePasswordStore::new(&root)
            .create(
                "alice",
                "offline",
                obsidian_git_sync_server::device_passwords::CreateDevicePasswordRequest {
                    label: "Excluded synthetic device".into(),
                    folder: "Private".into(),
                },
            )
            .await
            .unwrap();
    let initial=legacy.sync("alice","notes",serde_json::from_value(json!({"clientId":"migration-fixture","deviceName":"Synthetic",
        "baseHead":null,"clientManifest":[],"changes":[{"op":"upsert","path":"deleted.md","contentBase64":"aGlzdG9yeQo="},
        {"op":"upsert","path":"attachment.bin","contentBase64":"AAECAwQ="}]})).unwrap()).await.unwrap();
    let historical = initial.server_head.clone().unwrap();
    legacy.set_version_metadata("alice","notes",serde_json::from_value(json!({"path":"deleted.md","hash":historical,"name":"Synthetic historical version"})).unwrap()).await.unwrap();
    legacy.sync("alice","notes",serde_json::from_value(json!({"clientId":"migration-fixture","deviceName":"Synthetic",
        "baseHead":initial.server_head,"clientManifest":[],"changes":[{"op":"delete","path":"deleted.md"}]})).unwrap()).await.unwrap();
    let payload = b"synthetic partial upload";
    let upload = legacy
        .init_upload(
            "alice",
            "notes",
            obsidian_git_sync_server::protocol::UploadInitRequest {
                path: "partial.bin".into(),
                sha256: obsidian_git_sync_server::binary_store::sha256_hex(payload),
                size: payload.len() as u64,
            },
        )
        .await
        .unwrap();
    legacy
        .append_upload_chunk(
            "alice",
            "notes",
            &upload.upload_id,
            obsidian_git_sync_server::protocol::UploadChunkRequest {
                offset: 0,
                content_base64: base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    &payload[..5],
                ),
            },
        )
        .await
        .unwrap();
    fs::write(
        root.join("users/alice/vaults/notes/pending-conflicts.json"),
        json!({"pending.md":"synthetic-old-device"}).to_string(),
    )
    .unwrap();
    let mut credentials = obsidian_git_sync_server::share_credentials::Store::load(&root).unwrap();
    let (id, secret) = credentials
        .create(
            &accounts,
            &share,
            principal.clone(),
            "Tablet",
            Capability::ReadWrite,
            "Synthetic service",
        )
        .unwrap();
    credentials.save(&root).unwrap();
    let credential_bytes = fs::read(root.join("auth/share-device-passwords.json")).unwrap();
    copy(&root, &backup);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&backup, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let plan = Plan {
        version: 1,
        set_id: "fixture-set".into(),
        backup,
        mappings: vec![Mapping {
            user: "alice".into(),
            vault: "notes".into(),
            share_id: share.clone(),
            principals: vec![principal],
            native_enabled: true,
            dav_enabled: true,
        }],
        excluded: vec![migration::Excluded {
            user: "alice".into(),
            vault: "offline".into(),
        }],
    };
    migration::dry_run(&root, &plan).await.unwrap();
    assert!(!root.join("shares").exists());
    migration::apply(&root, plan, "approved".into(), "approved")
        .await
        .unwrap();
    let migrated = VaultService::published(options(&root));
    assert_eq!(
        migrated
            .file_bytes_at_version("alice", "notes", "deleted.md", &historical)
            .await
            .unwrap()
            .1,
        b"history\n"
    );
    assert_eq!(
        migrated
            .file_bytes_at_version("alice", "notes", "attachment.bin", &historical)
            .await
            .unwrap()
            .1,
        vec![0, 1, 2, 3, 4]
    );
    assert!(root
        .join("shares")
        .join(&share)
        .join(format!("uploads/{}.json", upload.upload_id))
        .exists());
    assert_eq!(
        migrated
            .pending_conflicts_for("alice", "notes", "synthetic-old-device")
            .await
            .unwrap()
            .len(),
        1
    );
    let auth = AuthVerifier::password(String::new(), &root).unwrap();
    let alice_session = auth.login_password("alice", PASSWORD).await.unwrap();
    let bob_session = auth.login_password("bob", PASSWORD).await.unwrap();
    let alice_auth = format!("Bearer {}", alice_session.access_token);
    let bob_auth = format!("Bearer {}", bob_session.access_token);
    let state = AppState::new(
        VaultService::published(options(&root)),
        auth,
        PublicAuthConfig::Password,
    );
    let app = router(state.clone(), 1024 * 1024, vec![]);
    assert_eq!(
        request(
            &app,
            "GET",
            "/v1/users/alice/vaults/offline/devices",
            &alice_auth,
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert!(obsidian_git_sync_server::grants::authenticate(
        &state,
        Some("alice"),
        &excluded_grant.password
    )
    .await
    .is_err());
    assert!(root.join("users/alice/vaults/offline/state.json").exists());
    let sync = json!({"clientId":"synthetic-client","deviceName":"Fixture","baseHead":null,"clientManifest":[],
        "changes":[{"op":"upsert","path":"hello.md","contentBase64":"aGVsbG8K"}]});
    let (status, response) = request(
        &app,
        "POST",
        "/v1/users/alice/vaults/notes/sync",
        &alice_auth,
        sync,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(
        fs::read(root.join("shares").join(&share).join("repo/hello.md")).unwrap(),
        b"hello\n"
    );
    assert!(!root.join("users/alice/vaults/notes/repo/hello.md").exists());
    let endpoint = format!("/v2/shares/{share}/sync-state");
    assert_eq!(
        request(&app, "GET", &endpoint, &bob_auth, Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/v1/users/alice/vaults/notes/devices",
            &bob_auth,
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let snapshot = fs::read(root.join("shares").join(&share).join("devices.json")).unwrap();
    assert_eq!(request(&app,"POST",&format!("/v2/shares/{share}/sync"),&bob_auth,
        json!({"clientId":"read-only","deviceName":"Reader","baseHead":null,"clientManifest":[],"changes":[]})).await.0,StatusCode::OK);
    assert_eq!(
        snapshot,
        fs::read(root.join("shares").join(&share).join("devices.json")).unwrap()
    );
    let change = |path: &str| {
        json!({"clientId":path,"deviceName":"Concurrent fixture","baseHead":response["serverHead"],"clientManifest":[],
        "changes":[{"op":"upsert","path":path,"contentBase64":"Y29uY3VycmVudAo="}]})
    };
    let v2_sync = format!("/v2/shares/{share}/sync");
    let (v1, v2) = tokio::join!(
        request(
            &app,
            "POST",
            "/v1/users/alice/vaults/notes/sync",
            &alice_auth,
            change("v1.md")
        ),
        request(&app, "POST", &v2_sync, &alice_auth, change("v2.md"))
    );
    assert_eq!(v1.0, StatusCode::OK, "{}", v1.1);
    assert_eq!(v2.0, StatusCode::OK, "{}", v2.1);
    for path in ["v1.md", "v2.md"] {
        assert!(root
            .join("shares")
            .join(&share)
            .join("repo")
            .join(path)
            .exists());
    }
    assert!(
        obsidian_git_sync_server::grants::authenticate(&state, Some(&share), &secret)
            .await
            .is_err()
    );
    obsidian_git_sync_server::admin::execute(
        &root,
        &["credential", "share", "activate", &id].map(String::from),
    )
    .await
    .unwrap();
    assert_eq!(
        credential_bytes,
        fs::read(root.join("auth/share-device-passwords.json")).unwrap()
    );
    accounts
        .accounts
        .iter_mut()
        .find(|a| a.id == alice)
        .unwrap()
        .enabled = false;
    accounts.shares[0].members.retain(|m| {
        m.principal
            != Principal::Local {
                account_id: alice.clone(),
            }
    });
    accounts.save(&root).unwrap();
    assert!(
        obsidian_git_sync_server::grants::authenticate(&state, Some(&share), &secret)
            .await
            .is_ok()
    );
    let bob_principal = accounts.shares[0].members[0].principal.clone();
    let bob_id = match &bob_principal {
        Principal::Local { account_id } => account_id.clone(),
        _ => unreachable!(),
    };
    assert!(obsidian_git_sync_server::admin::execute(
        &root,
        &["credential", "share", "rotate", &id, "local", &bob_id].map(String::from)
    )
    .await
    .is_err());
    accounts.shares[0].members[0].capability = Capability::ReadWrite;
    accounts.save(&root).unwrap();
    let rotated = obsidian_git_sync_server::admin::execute(
        &root,
        &["credential", "share", "rotate", &id, "local", &bob_id].map(String::from),
    )
    .await
    .unwrap();
    let new_secret = rotated["password"].as_str().unwrap();
    assert!(
        obsidian_git_sync_server::grants::authenticate(&state, Some(&share), &secret)
            .await
            .is_err()
    );
    assert!(
        obsidian_git_sync_server::grants::authenticate(&state, Some(&share), new_secret)
            .await
            .is_ok()
    );
    assert_eq!(
        obsidian_git_sync_server::share_credentials::Store::load(&root)
            .unwrap()
            .credentials[0]
            .rotation_actor,
        Some(bob_principal)
    );
    obsidian_git_sync_server::admin::execute(
        &root,
        &["credential", "share", "revoke", &id].map(String::from),
    )
    .await
    .unwrap();
    assert!(
        obsidian_git_sync_server::grants::authenticate(&state, Some(&share), &secret)
            .await
            .is_err()
    );
    assert!(
        obsidian_git_sync_server::grants::authenticate(&state, Some(&share), new_secret)
            .await
            .is_err()
    );
    Publication::load(&root).unwrap().validate(&root).unwrap();
    // Exercise an explicitly reviewed cutoff with synthetic, elapsed evidence.
    accounts
        .accounts
        .iter_mut()
        .find(|a| a.user == "alice")
        .unwrap()
        .enabled = true;
    accounts.shares[0].members.push(Membership {
        principal: Principal::Local {
            account_id: alice.clone(),
        },
        capability: Capability::ReadWrite,
    });
    accounts.save(&root).unwrap();
    let now = obsidian_git_sync_server::time_format::unix_now();
    let mut evidence = obsidian_git_sync_server::compatibility::load(&root)
        .unwrap()
        .unwrap();
    evidence.observed_since = now - 10;
    for activity in evidence.activity.values_mut() {
        activity.last_used = now - 20;
    }
    obsidian_git_sync_server::auth_storage::write(&root.join("auth/v1-activity.json"), &evidence)
        .unwrap();
    let review_path = fixture.path().join("cutoff.json");
    fs::write(
        &review_path,
        serde_json::to_vec(&obsidian_git_sync_server::compatibility::Review {
            observed_since: now - 10,
            observation_seconds: 5,
            consumers: evidence
                .activity
                .values()
                .filter(|activity| activity.protocol == "native")
                .map(
                    |activity| obsidian_git_sync_server::compatibility::Consumer {
                        share_id: share.clone(),
                        protocol: "native".into(),
                        client: activity.client.clone(),
                        required: true,
                        migrated: true,
                        reconciled: true,
                        verified: true,
                        retain: false,
                    },
                )
                .collect(),
        })
        .unwrap(),
    )
    .unwrap();
    let review = obsidian_git_sync_server::admin::execute(
        &root,
        &["compatibility", "dry-run", review_path.to_str().unwrap()].map(String::from),
    )
    .await
    .unwrap();
    assert!(obsidian_git_sync_server::admin::execute(
        &root,
        &[
            "compatibility",
            "cutoff",
            review_path.to_str().unwrap(),
            "wrong"
        ]
        .map(String::from)
    )
    .await
    .is_err());
    obsidian_git_sync_server::admin::execute(
        &root,
        &[
            "compatibility",
            "cutoff",
            review_path.to_str().unwrap(),
            review["reviewDigest"].as_str().unwrap(),
        ]
        .map(String::from),
    )
    .await
    .unwrap();
    assert_eq!(
        request(
            &app,
            "GET",
            "/v1/users/alice/vaults/notes/devices",
            &alice_auth,
            Value::Null
        )
        .await
        .0,
        StatusCode::GONE
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/v1/users/alice/vaults/notes/devices",
            &bob_auth,
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(&app, "GET", &endpoint, &bob_auth, Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    obsidian_git_sync_server::admin::execute(&root, &["share", "retire", &share].map(String::from))
        .await
        .unwrap();
    assert_eq!(
        request(&app, "GET", &endpoint, &bob_auth, Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert!(!Publication::load(&root).unwrap().available(&share));
}

#[test]
fn pending_publication_refuses_process_startup_and_ordinary_administration() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path();
    let mut accounts = AccountStore::default();
    accounts.create_account("fixture", PASSWORD).unwrap();
    accounts.save(root).unwrap();
    migration::initialize(root).unwrap();
    let before = fs::read(root.join("auth/accounts.json")).unwrap();
    fs::write(
        root.join(obsidian_git_sync_server::publication::PENDING),
        b"{}",
    )
    .unwrap();
    let binary = env!("CARGO_BIN_EXE_obsidian-git-sync-server");
    let output = std::process::Command::new(binary)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .env("OBSIDIAN_GIT_SYNC_AUTH_MODE", "password")
        .env("OBSIDIAN_GIT_SYNC_DATA_DIR", root)
        .env("OBSIDIAN_GIT_SYNC_LISTEN", "127.0.0.1:0")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("publication pending"));
    let output = std::process::Command::new(binary)
        .args(["admin", "--data-dir"])
        .arg(root)
        .args(["share", "create", "Blocked fixture"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(before, fs::read(root.join("auth/accounts.json")).unwrap());
}
