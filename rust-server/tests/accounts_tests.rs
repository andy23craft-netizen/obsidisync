//! FEAT-02 tests operate only on disposable directories, never operator data.
use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use base64::{engine::general_purpose::STANDARD, Engine};
use obsidian_git_sync_server::accounts::{
    import_legacy, AccountStore, Capability, Membership, Principal,
};
use obsidian_git_sync_server::app_session::AppSessionStore;
use obsidian_git_sync_server::auth::{AuthContext, AuthVerifier};
use obsidian_git_sync_server::auth_storage::DataDirectoryLock;
use obsidian_git_sync_server::device_passwords::{CreateSaberDevice, DevicePasswordStore};
use obsidian_git_sync_server::http::{router, AppState, PublicAuthConfig};
use obsidian_git_sync_server::password_auth::hash_password;
use obsidian_git_sync_server::share_credentials;
use obsidian_git_sync_server::vault::VaultService;
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;
use tower::ServiceExt;

const PASSWORD: &str = "fixture-password-123456";
fn fixture() -> TempDir {
    let target = Path::new(env!("CARGO_MANIFEST_DIR")).join("target");
    fs::create_dir_all(&target).unwrap();
    tempfile::tempdir_in(target).unwrap()
}
fn command(root: &Path, args: &[&str]) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_obsidian-git-sync-server"));
    c.env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .args(["admin", "--data-dir"])
        .arg(root)
        .args(args);
    c
}
fn cli(root: &Path, args: &[&str], input: Option<&str>) -> Value {
    let mut c = command(root, args);
    c.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = c.spawn().unwrap();
    if let Some(text) = input {
        child
            .stdin
            .take()
            .unwrap()
            .write_all(text.as_bytes())
            .unwrap();
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "CLI failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn provision(root: &Path) -> (String, String) {
    let mut store = AccountStore::default();
    let andy = store.create_account("andy", PASSWORD).unwrap();
    let liz = store.create_account("liz", PASSWORD).unwrap();
    store.save(root).unwrap();
    (andy, liz)
}
fn password_router(root: &Path) -> axum::Router {
    router(
        AppState::new(
            VaultService::new(root.to_path_buf()),
            AuthVerifier::password(String::new(), root).unwrap(),
            PublicAuthConfig::Password,
        ),
        1024 * 1024,
        vec![],
    )
}
async fn json_response(r: axum::response::Response) -> Value {
    serde_json::from_slice(&to_bytes(r.into_body(), usize::MAX).await.unwrap()).unwrap()
}
async fn request(
    app: &axum::Router,
    method: &str,
    uri: &str,
    auth: Option<&str>,
    body: Value,
) -> axum::response::Response {
    let mut r = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(auth) = auth {
        r = r.header(header::AUTHORIZATION, auth);
    }
    app.clone()
        .oneshot(r.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap()
}

#[tokio::test]
async fn legacy_import_preserves_hash_files_and_retires_only_password_sessions() {
    let root = fixture();
    fs::create_dir(root.path().join("auth")).unwrap();
    fs::create_dir_all(root.path().join("users/andy/vaults/notes/repo")).unwrap();
    let note = root.path().join("users/andy/vaults/notes/repo/Note.md");
    fs::write(&note, "fixture unchanged\n").unwrap();
    let hash = hash_password(PASSWORD).unwrap();
    let legacy = json!({"user":"andy","password_hash":hash,"sessions":[]}).to_string();
    fs::write(root.path().join("auth/password.json"), &legacy).unwrap();
    let sessions = AppSessionStore::new(root.path());
    let old = sessions.issue("andy".into(), "andy".into()).await.unwrap();
    let oidc = sessions
        .issue("oidc-user".into(), "verified-sub".into())
        .await
        .unwrap();
    let before_sessions = fs::read(root.path().join("auth/sessions.json")).unwrap();
    assert!(AuthVerifier::password("andy".into(), root.path()).is_err());
    assert!(import_legacy(root.path(), Some("different"), false).is_err());
    let dry = import_legacy(root.path(), Some("Andy@example.com"), true).unwrap();
    assert!(dry.account_id.is_some());
    assert!(!root.path().join("auth/accounts.json").exists());
    let imported = import_legacy(root.path(), Some("andy"), false).unwrap();
    let store = AccountStore::load(root.path()).unwrap();
    assert_eq!(store.accounts[0].password_hash, hash);
    assert_eq!(store.accounts[0].user, "andy");
    assert_eq!(
        fs::read_to_string(root.path().join("auth/password.json")).unwrap(),
        legacy
    );
    assert_eq!(fs::read_to_string(&note).unwrap(), "fixture unchanged\n");
    assert_eq!(
        fs::read(root.path().join("auth/sessions.json")).unwrap(),
        before_sessions
    );
    let verifier = AuthVerifier::password("andy".into(), root.path()).unwrap();
    assert!(verifier
        .verify_bearer_token(&old.access_token)
        .await
        .is_err());
    assert!(verifier.refresh_session(&old.refresh_token).await.is_err());
    assert!(sessions
        .verify_access_token(&oidc.access_token)
        .await
        .is_ok());
    let fresh = verifier
        .login_password("Andy@example.com", PASSWORD)
        .await
        .unwrap();
    assert_eq!(Some(fresh.subject.clone()), imported.account_id);
    assert_eq!(fresh.user, "andy");
    let account_bytes = fs::read(root.path().join("auth/accounts.json")).unwrap();
    assert_eq!(
        import_legacy(root.path(), None, false).unwrap().account_id,
        imported.account_id
    );
    assert_eq!(
        fs::read(root.path().join("auth/accounts.json")).unwrap(),
        account_bytes
    );
    let restarted = AuthVerifier::password(String::new(), root.path()).unwrap();
    assert!(restarted
        .verify_bearer_token(&fresh.access_token)
        .await
        .is_ok());
    let renewed = restarted
        .refresh_session(&fresh.refresh_token)
        .await
        .unwrap();
    assert_ne!(renewed.refresh_token, fresh.refresh_token);
    assert!(restarted
        .refresh_session(&fresh.refresh_token)
        .await
        .is_err());
    let app = password_router(root.path());
    let expired_cookie = app
        .oneshot(
            Request::builder()
                .uri("/change-feed")
                .header(
                    header::COOKIE,
                    format!("obsidisync_session={}", old.access_token),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(expired_cookie.status(), StatusCode::SEE_OTHER);
    assert!(expired_cookie.headers()[header::LOCATION]
        .to_str()
        .unwrap()
        .starts_with("/login"));
}

#[tokio::test]
async fn disabled_refresh_and_local_namespaces_are_isolated() {
    let root = fixture();
    let (andy_id, liz_id) = provision(root.path());
    assert_ne!(andy_id, liz_id);
    let verifier = AuthVerifier::password("unused-legacy-selector".into(), root.path()).unwrap();
    let andy = verifier.login_password("andy", PASSWORD).await.unwrap();
    let liz = verifier.login_password("liz", PASSWORD).await.unwrap();
    assert_eq!(
        verifier
            .verify_bearer_token(&andy.access_token)
            .await
            .unwrap()
            .subject,
        andy_id
    );
    let app = password_router(root.path());
    let andy_auth = format!("Bearer {}", andy.access_token);
    let liz_auth = format!("Bearer {}", liz.access_token);
    let registration = json!({"remoteUrl":"","branch":"main","authorName":"Fixture","authorEmail":"fixture@example.test",
        "clientId":"fixture-device","deviceName":"Fixture"});
    let register = request(
        &app,
        "POST",
        "/v1/users/andy/vaults/notes/register",
        Some(&andy_auth),
        registration,
    )
    .await;
    assert_eq!(register.status(), StatusCode::OK);
    for (method, suffix) in [
        ("POST", "register"),
        ("POST", "sync"),
        ("POST", "uploads"),
        ("GET", "history"),
        ("GET", "file?path=Note.md&hash=deadbeef"),
        ("GET", "blob?path=Note.md&hash=deadbeef"),
        ("POST", "resolve"),
        ("GET", "device-passwords"),
        ("POST", "device-passwords"),
        ("GET", "devices"),
        ("GET", "conflicts?clientId=fixture"),
        ("GET", "files/device-versions?path=Note.md"),
        ("POST", "files/version-metadata"),
    ] {
        let r = request(&app,method,&format!("/v1/users/andy/vaults/notes/{suffix}"),Some(&liz_auth),json!({
            "label":"Fixture","folder":"Notes","changes":[],"baseHead":null,"clientId":"fixture",
            "deviceName":"Fixture","clientManifest":[],"hash":"deadbeef",
            "remoteUrl":"","branch":"main","authorName":"Fixture","authorEmail":"fixture@example.test",
            "path":"File.md","sha256":"a".repeat(64),"size":1,"files":[],"resolutions":[],"paths":[]})).await;
        assert_eq!(r.status(), StatusCode::FORBIDDEN, "{method} {suffix}");
    }
    let denied_feed = request(
        &app,
        "GET",
        "/v1/users/andy/feed",
        Some(&liz_auth),
        Value::Null,
    )
    .await;
    assert_eq!(denied_feed.status(), StatusCode::FORBIDDEN);
    let mut accounts = AccountStore::load(root.path()).unwrap();
    assert!(accounts
        .create_account("Andy@example.test", PASSWORD)
        .is_err());
    accounts
        .accounts
        .iter_mut()
        .find(|a| a.id == andy_id)
        .unwrap()
        .enabled = false;
    accounts.save(root.path()).unwrap();
    assert!(verifier.login_password("andy", PASSWORD).await.is_err());
    assert!(verifier
        .verify_bearer_token(&andy.access_token)
        .await
        .is_ok());
    assert!(verifier.refresh_session(&andy.refresh_token).await.is_err());
    // Existing refresh consumption removes the entire session, including its access token.
    assert!(verifier
        .verify_bearer_token(&andy.access_token)
        .await
        .is_err());
    assert!(verifier.refresh_session(&liz.refresh_token).await.is_ok());
}

#[tokio::test]
async fn empty_store_has_no_public_setup_and_corruption_fails_closed() {
    let root = fixture();
    let app = password_router(root.path());
    let config =
        json_response(request(&app, "GET", "/v1/auth/config", None, Value::Null).await).await;
    assert_eq!(config["passwordConfigured"], true);
    assert_eq!(config["loginAvailable"], false);
    assert_eq!(config["accountProvisioning"], "host-local");
    assert_eq!(
        request(&app, "POST", "/v1/auth/password/setup", None, json!({}))
            .await
            .status(),
        StatusCode::GONE
    );
    let unavailable = request(
        &app,
        "POST",
        "/v1/auth/password/login",
        None,
        json!({"username":"x","password":PASSWORD}),
    )
    .await;
    assert_eq!(unavailable.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(json_response(unavailable).await["error"]
        .as_str()
        .unwrap()
        .contains("operator"));
    assert!(!root.path().join("auth/accounts.json").exists());
    let post=app.clone().oneshot(Request::builder().method("POST").uri("/login")
        .header(header::CONTENT_TYPE,"application/x-www-form-urlencoded")
        .body(Body::from("username=andy&password=fixture-password-123456&password_confirm=fixture-password-123456")).unwrap()).await.unwrap();
    assert_eq!(post.status(), StatusCode::SERVICE_UNAVAILABLE);
    fs::create_dir_all(root.path().join("auth")).unwrap();
    fs::write(root.path().join("auth/accounts.json"), b"{corrupt").unwrap();
    fs::write(root.path().join("auth/accounts.json.tmp"), b"{}").unwrap();
    assert_eq!(
        request(&app, "GET", "/v1/auth/config", None, Value::Null)
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert!(AccountStore::load(root.path()).is_err());
    assert_eq!(
        fs::read(root.path().join("auth/accounts.json")).unwrap(),
        b"{corrupt"
    );
}

#[tokio::test]
async fn local_session_expiry_and_unknown_identity_fail_closed_after_restart() {
    let root = fixture();
    provision(root.path());
    let verifier = AuthVerifier::password(String::new(), root.path()).unwrap();
    let session = verifier.login_password("andy", PASSWORD).await.unwrap();
    assert_eq!(session.expires_in, 86_400);
    assert_eq!(session.refresh_expires_in, 15_552_000);
    let path = root.path().join("auth/sessions.json");
    let mut store: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    store["sessions"][0]["access_expires_at"] = json!(0);
    fs::write(&path, store.to_string()).unwrap();
    let restarted = AuthVerifier::password(String::new(), root.path()).unwrap();
    assert!(restarted
        .verify_bearer_token(&session.access_token)
        .await
        .is_err());
    let renewed = restarted
        .refresh_session(&session.refresh_token)
        .await
        .unwrap();
    assert!(restarted
        .refresh_session(&session.refresh_token)
        .await
        .is_err());
    let mut store: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    store["sessions"][0]["identity_version"] = json!("unsupported-v2");
    let corrupt = store.to_string();
    fs::write(&path, &corrupt).unwrap();
    assert!(restarted
        .verify_bearer_token(&renewed.access_token)
        .await
        .is_err());
    assert!(restarted
        .refresh_session(&renewed.refresh_token)
        .await
        .is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), corrupt);
    store["sessions"][0]["identity_version"] = json!("local-v1");
    store["sessions"][0]["refresh_expires_at"] = json!(0);
    fs::write(&path, store.to_string()).unwrap();
    assert!(restarted
        .refresh_session(&renewed.refresh_token)
        .await
        .is_err());
}

#[tokio::test]
async fn legacy_saber_roundtrip_rotation_preserves_grant_and_settings() {
    let root = fixture();
    let devices = DevicePasswordStore::new(root.path());
    let created = devices
        .create_saber(
            "andy",
            "notes",
            CreateSaberDevice {
                label: "Fixture Saber".into(),
                folder: "Tablet/.sync".into(),
                pdf_folder: "Tablet".into(),
                encryption_password: "fixture-encryption-password".into(),
            },
        )
        .await
        .unwrap();
    let before: Value =
        serde_json::from_slice(&fs::read(root.path().join("auth/device-passwords.json")).unwrap())
            .unwrap();
    let grant = devices
        .authenticate("andy", &created.password)
        .await
        .unwrap();
    let rotated = devices
        .rotate("andy", "notes", &created.entry.id)
        .await
        .unwrap();
    assert!(devices
        .authenticate_bearer(&created.password)
        .await
        .is_err());
    let next = devices
        .authenticate_bearer(&rotated.password)
        .await
        .unwrap();
    assert_eq!(grant, next);
    let after: Value =
        serde_json::from_slice(&fs::read(root.path().join("auth/device-passwords.json")).unwrap())
            .unwrap();
    for field in [
        "id",
        "user",
        "vault",
        "folder",
        "label",
        "created_at",
        "kind",
        "saber",
    ] {
        assert_eq!(before["passwords"][0][field], after["passwords"][0][field]);
    }
    let listed = serde_json::to_string(&devices.list("andy", "notes").await.unwrap()).unwrap();
    assert!(!listed.contains("fixture-encryption-password"));
    assert!(!listed.contains("password_hash"));
    let mut unsupported = after.clone();
    unsupported["passwords"][0]["unknown_secret_field"] = json!("fixture-secret");
    fs::write(
        root.path().join("auth/device-passwords.json"),
        unsupported.to_string(),
    )
    .unwrap();
    assert!(devices
        .rotate("andy", "notes", &created.entry.id)
        .await
        .is_err());
    assert_eq!(
        serde_json::from_slice::<Value>(
            &fs::read(root.path().join("auth/device-passwords.json")).unwrap()
        )
        .unwrap(),
        unsupported
    );
    fs::write(
        root.path().join("auth/device-passwords.json"),
        after.to_string(),
    )
    .unwrap();
    assert!(devices
        .revoke("andy", "notes", &created.entry.id)
        .await
        .unwrap());
    assert!(devices
        .authenticate_bearer(&rotated.password)
        .await
        .is_err());
}

#[tokio::test]
async fn staged_credentials_never_authenticate_on_legacy_network_paths() {
    let root = fixture();
    let (id, _) = provision(root.path());
    let mut accounts = AccountStore::load(root.path()).unwrap();
    let share = accounts.create_share("Harmony").unwrap();
    let p = Principal::Local { account_id: id };
    accounts.shares[0].members.push(Membership {
        principal: p.clone(),
        capability: Capability::ReadWrite,
    });
    accounts.save(root.path()).unwrap();
    let mut staged = share_credentials::Store::default();
    let (credential, secret) = staged
        .create(
            &accounts,
            &share,
            p,
            "Household",
            Capability::ReadWrite,
            "Harmony service",
        )
        .unwrap();
    staged.save(root.path()).unwrap();
    let app = password_router(root.path());
    for uri in [
        "/dav/notes/Household/",
        "/remote.php/webdav/Saber/",
        "/remote.php/dav/files/andy/Saber/",
        "/ocs/v2.php/cloud/user",
        "/v1/auth/session",
        "/v1/users/andy/feed",
    ] {
        for auth in [
            format!("Bearer {secret}"),
            format!("Basic {}", STANDARD.encode(format!("andy:{secret}"))),
        ] {
            assert_eq!(
                request(&app, "GET", uri, Some(&auth), Value::Null)
                    .await
                    .status(),
                StatusCode::UNAUTHORIZED,
                "{uri}"
            );
        }
    }
    for uri in ["/dav/notes/Household/", "/remote.php/webdav/Saber/"] {
        assert_eq!(
            request(
                &app,
                "PROPFIND",
                uri,
                Some(&format!("Bearer {secret}")),
                Value::Null
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let flow =
        json_response(request(&app, "POST", "/index.php/login/v2", None, Value::Null).await).await;
    let flow_url = url::Url::parse(flow["login"].as_str().unwrap()).unwrap();
    let rejected=app.clone().oneshot(Request::builder().method("POST").uri(flow_url.path())
        .header(header::CONTENT_TYPE,"application/x-www-form-urlencoded")
        .body(Body::from(format!("access_token={secret}&vault=notes&label=Harmony&folder=Household&pdf_folder=PDF"))).unwrap()).await.unwrap();
    assert_eq!(rejected.status(), StatusCode::SEE_OTHER);
    assert!(rejected.headers()[header::LOCATION]
        .to_str()
        .unwrap()
        .contains("error=Not"));
    assert!(!root.path().join("auth/device-passwords.json").exists());
    let old_hash = staged.credentials[0].password_hash.clone();
    let replacement = staged.rotate(&credential).unwrap();
    assert_ne!(replacement, secret);
    assert_ne!(staged.credentials[0].password_hash, old_hash);
    assert_eq!(staged.credentials[0].share_id, share);
    assert_eq!(staged.credentials[0].lifecycle, "staged");
    staged.save(root.path()).unwrap();
    let devices = DevicePasswordStore::new(root.path());
    assert!(devices.authenticate_bearer(&replacement).await.is_err());
    assert!(devices.list("andy", "notes").await.unwrap().is_empty());
    staged.revoke(&credential).unwrap();
    staged.save(root.path()).unwrap();
    assert!(share_credentials::Store::load(root.path())
        .unwrap()
        .credentials
        .is_empty());
}

#[test]
fn typed_memberships_cannot_collide_and_read_cannot_issue_writes() {
    let root = fixture();
    let (id, _) = provision(root.path());
    let mut accounts = AccountStore::load(root.path()).unwrap();
    let share = accounts.create_share("Harmony").unwrap();
    let local = Principal::Local {
        account_id: id.clone(),
    };
    let oidc = Principal::Oidc {
        issuer: "https://issuer.example.test".into(),
        subject: id.clone(),
    };
    let other = Principal::Oidc {
        issuer: "https://other.example.test".into(),
        subject: id,
    };
    accounts.shares[0].members.push(Membership {
        principal: local.clone(),
        capability: Capability::Read,
    });
    accounts.shares[0].members.push(Membership {
        principal: oidc.clone(),
        capability: Capability::ReadWrite,
    });
    accounts.save(root.path()).unwrap();
    assert_eq!(accounts.capability(&share, &local), Some(Capability::Read));
    assert_eq!(accounts.capability(&share, &other), None);
    assert_eq!(accounts.capability("missing", &oidc), None);
    assert!(share_credentials::Store::default()
        .create(
            &accounts,
            &share,
            local,
            "Notes",
            Capability::ReadWrite,
            "Fixture"
        )
        .is_err());
    let verifier = AuthVerifier::oidc(
        "https://issuer.example.test".into(),
        "aud".into(),
        None,
        "sub".into(),
        root.path(),
        None,
    )
    .unwrap();
    let ctx = AuthContext {
        user: "mutable-name".into(),
        subject: oidc_subject(&oidc),
    };
    assert_eq!(verifier.membership_principal(&ctx).unwrap(), oidc);
}
fn oidc_subject(p: &Principal) -> String {
    match p {
        Principal::Oidc { subject, .. } => subject.clone(),
        _ => unreachable!(),
    }
}

#[tokio::test]
async fn oidc_verified_login_discovery_exchange_and_legacy_refresh_remain_compatible() {
    use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
    let root = fixture();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let issuer = format!("http://{}", listener.local_addr().unwrap());
    let discovery = json!({"jwks_uri":format!("{issuer}/keys")});
    let jwks: Value = serde_json::from_str(include_str!("fixtures/oidc-test-jwks.json")).unwrap();
    let provider = axum::Router::new()
        .route(
            "/.well-known/openid-configuration",
            axum::routing::get(move || async move { axum::Json(discovery) }),
        )
        .route(
            "/keys",
            axum::routing::get(move || async move { axum::Json(jwks) }),
        );
    let task = tokio::spawn(async move {
        axum::serve(listener, provider).await.unwrap();
    });
    let verifier = AuthVerifier::oidc(
        issuer.clone(),
        "fixture-audience".into(),
        None,
        "preferred_username".into(),
        root.path(),
        None,
    )
    .unwrap();
    let old = AppSessionStore::new(root.path())
        .issue("old-oidc-name".into(), "verified-sub".into())
        .await
        .unwrap();
    assert!(verifier
        .verify_bearer_token(&old.access_token)
        .await
        .is_ok());
    assert_eq!(
        verifier
            .refresh_session(&old.refresh_token)
            .await
            .unwrap()
            .subject,
        "verified-sub"
    );
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some("fixture".into());
    let claims = json!({"iss":issuer,"aud":"fixture-audience","sub":"verified-sub","preferred_username":"Alice@example.test",
        "exp":obsidian_git_sync_server::time_format::unix_now()+300});
    let key = EncodingKey::from_rsa_pem(include_bytes!("fixtures/oidc-test-key.pem")).unwrap();
    let token = encode(&header, &claims, &key).unwrap();
    let app = router(
        AppState::new(
            VaultService::new(root.path().to_path_buf()),
            verifier.clone(),
            PublicAuthConfig::Oidc {
                issuer: issuer.clone(),
                client_id: "fixture-client".into(),
                scope: "openid profile".into(),
                audience: Some("fixture-audience".into()),
            },
        ),
        1024 * 1024,
        vec![],
    );
    let login = request(
        &app,
        "POST",
        "/v1/auth/oidc/login",
        None,
        json!({"accessToken":token}),
    )
    .await;
    assert_eq!(login.status(), StatusCode::OK);
    let body = json_response(login).await;
    assert_eq!(body["subject"], "verified-sub");
    assert_eq!(body["user"], "alice");
    let auth = verifier
        .verify_bearer_token(body["accessToken"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(
        verifier.membership_principal(&auth).unwrap(),
        Principal::Oidc {
            issuer,
            subject: "verified-sub".into()
        }
    );
    let mut wrong = claims.clone();
    wrong["aud"] = json!("wrong");
    let wrong_token = encode(&header, &wrong, &key).unwrap();
    assert_eq!(
        request(
            &app,
            "POST",
            "/v1/auth/oidc/login",
            None,
            json!({"accessToken":wrong_token})
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    task.abort();
}

#[test]
fn legacy_import_collision_corruption_unconfigured_source_and_backup_recovery() {
    let root = fixture();
    fs::create_dir_all(root.path().join("auth")).unwrap();
    let source = root.path().join("auth/password.json");
    fs::write(&source, b"{broken").unwrap();
    assert!(import_legacy(root.path(), None, false).is_err());
    assert_eq!(fs::read(&source).unwrap(), b"{broken");
    let legacy =
        json!({"user":"andy","password_hash":hash_password(PASSWORD).unwrap(),"sessions":[]})
            .to_string();
    fs::write(&source, &legacy).unwrap();
    provision(root.path());
    let destination = fs::read(root.path().join("auth/accounts.json")).unwrap();
    assert!(import_legacy(root.path(), None, false).is_err());
    assert_eq!(
        fs::read(root.path().join("auth/accounts.json")).unwrap(),
        destination
    );
    // This is disposable pre-write recovery, never an operator data restore.
    fs::remove_file(root.path().join("auth/accounts.json")).unwrap();
    let before = fs::read(&source).unwrap();
    let imported = cli(root.path(), &["auth", "import-legacy"], None);
    assert_eq!(imported["user"], "andy");
    fs::write(root.path().join("auth/accounts.json.tmp"), b"{partial").unwrap();
    assert_eq!(
        cli(root.path(), &["auth", "import-legacy"], None)["accountId"],
        imported["accountId"]
    );
    fs::remove_file(root.path().join("auth/accounts.json")).unwrap();
    fs::write(&source, before).unwrap();
    assert!(AuthVerifier::password("andy".into(), root.path()).is_err());
    fs::write(
        &source,
        json!({"user":"andy","password_hash":null}).to_string(),
    )
    .unwrap();
    assert!(import_legacy(root.path(), None, false)
        .unwrap()
        .account_id
        .is_none());
    assert!(AuthVerifier::password("andy".into(), root.path()).is_ok());
    cli(
        root.path(),
        &["account", "create", "andy"],
        Some(&format!("{PASSWORD}\n")),
    );
}

#[test]
fn cli_lifecycle_redaction_and_exclusivity() {
    let root = fixture();
    let a = cli(
        root.path(),
        &["account", "create", "andy"],
        Some(&format!("{PASSWORD}\n")),
    );
    let id = a["id"].as_str().unwrap();
    let share = cli(root.path(), &["share", "create", "Harmony"], None);
    let sid = share["id"].as_str().unwrap();
    cli(
        root.path(),
        &["membership", "grant", sid, "local", id, "read-write"],
        None,
    );
    let c = cli(
        root.path(),
        &[
            "credential",
            "share",
            "create",
            sid,
            "local",
            id,
            "Household",
            "read-write",
            "Harmony",
        ],
        None,
    );
    let cid = c["id"].as_str().unwrap();
    let listed = cli(root.path(), &["credential", "share", "list"], None).to_string();
    assert!(!listed.contains(c["password"].as_str().unwrap()));
    assert!(!listed.contains("password_hash"));
    cli(root.path(), &["credential", "share", "rotate", cid], None);
    cli(root.path(), &["credential", "share", "revoke", cid], None);
    cli(root.path(), &["share", "rename", sid, "Household"], None);
    cli(
        root.path(),
        &["membership", "revoke", sid, "local", id],
        None,
    );
    cli(root.path(), &["account", "disable", id], None);
    assert!(!cli(root.path(), &["account", "list"], None)
        .to_string()
        .contains(PASSWORD));
    cli(root.path(), &["validate"], None);
    let guard = DataDirectoryLock::acquire(root.path()).unwrap();
    let before = fs::read(root.path().join("auth/accounts.json")).unwrap();
    let failure = command(root.path(), &["share", "create", "Blocked"])
        .output()
        .unwrap();
    assert!(!failure.status.success());
    assert_eq!(
        fs::read(root.path().join("auth/accounts.json")).unwrap(),
        before
    );
    drop(guard);
    assert!(root.path().join(".obsidisync.lock").exists());
    cli(root.path(), &["validate"], None);
}

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn pending_admin_excludes_another_admin_and_server_without_writing() {
    let root = fixture();
    provision(root.path());
    let before = fs::read(root.path().join("auth/accounts.json")).unwrap();
    let mut pending = Process(
        command(root.path(), &["account", "create", "pending"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        assert!(pending.0.try_wait().unwrap().is_none());
        if root.path().join(".obsidisync.lock").exists()
            && DataDirectoryLock::acquire(root.path()).is_err()
        {
            break;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(10));
    }
    assert!(!command(root.path(), &["share", "create", "Blocked"])
        .output()
        .unwrap()
        .status
        .success());
    let server = Command::new(env!("CARGO_BIN_EXE_obsidian-git-sync-server"))
        .env_clear()
        .env("OBSIDIAN_GIT_SYNC_DATA_DIR", root.path())
        .env("OBSIDIAN_GIT_SYNC_AUTH_MODE", "password")
        .env("OBSIDIAN_GIT_SYNC_LISTEN", "127.0.0.1:0")
        .output()
        .unwrap();
    assert!(!server.status.success());
    assert_eq!(
        fs::read(root.path().join("auth/accounts.json")).unwrap(),
        before
    );
    pending.0.kill().unwrap();
    pending.0.wait().unwrap();
    cli(root.path(), &["validate"], None);
}
#[test]
fn running_server_excludes_admin_and_other_server_and_crash_releases_lock() {
    let root = fixture();
    let start = || {
        let mut c = Command::new(env!("CARGO_BIN_EXE_obsidian-git-sync-server"));
        c.env_clear()
            .env("PATH", std::env::var("PATH").unwrap())
            .env("OBSIDIAN_GIT_SYNC_DATA_DIR", root.path())
            .env("OBSIDIAN_GIT_SYNC_AUTH_MODE", "password")
            .env("OBSIDIAN_GIT_SYNC_LISTEN", "127.0.0.1:0")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        c
    };
    let mut server = Process(start().spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        assert!(
            server.0.try_wait().unwrap().is_none(),
            "server exited before locking"
        );
        if root.path().join(".obsidisync.lock").exists()
            && DataDirectoryLock::acquire(root.path()).is_err()
        {
            break;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(10));
    }
    assert!(!command(root.path(), &["validate"])
        .output()
        .unwrap()
        .status
        .success());
    assert!(!start().output().unwrap().status.success());
    server.0.kill().unwrap();
    server.0.wait().unwrap();
    cli(root.path(), &["validate"], None);
}
