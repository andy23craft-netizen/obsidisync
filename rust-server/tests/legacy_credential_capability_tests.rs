//! The additive header describes legacy management, never selected-v2 membership.
mod common;
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use obsidian_git_sync_server::{
    accounts::{AccountStore, Capability, Principal},
    auth::AuthVerifier,
    http::{router, AppState, PublicAuthConfig, LEGACY_GRANT_MANAGEMENT_HEADER},
    vault::{UploadLimits, VaultService, VaultServiceOptions},
};
use tower::ServiceExt;

#[tokio::test]
async fn inventory_header_uses_original_mapping_capability_and_cors_exposes_it() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path();
    common::initialize(root);
    let principal = Principal::Development {
        user: "synthetic".into(),
    };
    let legacy = common::publish_legacy(root, "synthetic", "original", principal.clone()).await;
    let selected = common::publish_legacy(root, "synthetic", "selected", principal).await;
    for (legacy_cap, selected_cap, expected) in [
        (Capability::Read, Capability::ReadWrite, "denied"),
        (Capability::ReadWrite, Capability::Read, "allowed"),
    ] {
        let mut accounts = AccountStore::load(root).unwrap();
        for share in &mut accounts.shares {
            share.members[0].capability = if share.id == legacy {
                legacy_cap
            } else {
                selected_cap
            };
        }
        accounts.save(root).unwrap();
        for origins in [vec!["*".into()], vec!["app://obsidian.md".into()]] {
            let app = router(
                AppState::new(
                    VaultService::published(VaultServiceOptions {
                        data_dir: root.into(),
                        remote_policy: Default::default(),
                        upload_limits: UploadLimits::default(),
                    }),
                    AuthVerifier::StaticTokenForDev {
                        token: "synthetic-token".into(),
                        user: "synthetic".into(),
                    },
                    PublicAuthConfig::Token,
                ),
                1024 * 1024,
                origins,
            );
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri("/v1/users/synthetic/vaults/original/device-passwords")
                        .header("Authorization", "Bearer synthetic-token")
                        .header("Origin", "app://obsidian.md")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[LEGACY_GRANT_MANAGEMENT_HEADER], expected);
            assert!(response.headers()["access-control-expose-headers"]
                .to_str()
                .unwrap()
                .contains(LEGACY_GRANT_MANAGEMENT_HEADER));
            assert_eq!(
                to_bytes(response.into_body(), 1024).await.unwrap().as_ref(),
                b"[]"
            );
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("OPTIONS")
                        .uri("/v1/users/synthetic/vaults/original/device-passwords/id")
                        .header("Origin", "app://obsidian.md")
                        .header("Access-Control-Request-Method", "DELETE")
                        .header("Access-Control-Request-Headers", "authorization")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert!(response.headers()["access-control-allow-methods"]
                .to_str()
                .unwrap()
                .contains("DELETE"));
            for (path, token) in [
                (
                    "/v1/users/other/vaults/original/device-passwords",
                    "synthetic-token",
                ),
                (
                    "/v1/users/synthetic/vaults/unmapped/device-passwords",
                    "synthetic-token",
                ),
                (
                    "/v1/users/synthetic/vaults/original/device-passwords",
                    "invalid",
                ),
            ] {
                let response = app
                    .clone()
                    .oneshot(
                        Request::builder()
                            .uri(path)
                            .header("Authorization", format!("Bearer {token}"))
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert!(!response.status().is_success());
                assert!(!response
                    .headers()
                    .contains_key(LEGACY_GRANT_MANAGEMENT_HEADER));
            }
            // A forged client header never grants write capability.
            if expected == "denied" {
                let response = app
                    .clone()
                    .oneshot(
                        Request::builder()
                            .method("POST")
                            .uri("/v1/users/synthetic/vaults/original/device-passwords")
                            .header("Authorization", "Bearer synthetic-token")
                            .header("Content-Type", "application/json")
                            .header(LEGACY_GRANT_MANAGEMENT_HEADER, "allowed")
                            .body(Body::from(r#"{"label":"Synthetic","folder":"Tablet"}"#))
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert!(!response.status().is_success());
            }
        }
    }
    assert_ne!(legacy, selected);
    let mut publication = obsidian_git_sync_server::publication::Publication::load(root).unwrap();
    publication
        .mappings
        .iter_mut()
        .find(|mapping| mapping.share_id == legacy)
        .unwrap()
        .native_enabled = false;
    publication.generation += 1;
    publication.save(root).unwrap();
    let app = router(
        AppState::new(
            VaultService::published(VaultServiceOptions {
                data_dir: root.into(),
                remote_policy: Default::default(),
                upload_limits: UploadLimits::default(),
            }),
            AuthVerifier::StaticTokenForDev {
                token: "synthetic-token".into(),
                user: "synthetic".into(),
            },
            PublicAuthConfig::Token,
        ),
        1024 * 1024,
        vec![],
    );
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v1/users/synthetic/vaults/original/device-passwords")
                .header("Authorization", "Bearer synthetic-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::GONE);
    assert!(!response
        .headers()
        .contains_key(LEGACY_GRANT_MANAGEMENT_HEADER));
}
