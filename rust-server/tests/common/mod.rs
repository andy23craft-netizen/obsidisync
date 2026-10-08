//! Disposable published-storage fixtures shared by protocol regression suites.
use obsidian_git_sync_server::{
    accounts::{AccountStore, Capability, Membership, Principal},
    protocol::RegisterRequest,
    publication::{Mapping, Publication},
    vault::VaultService,
};
use std::path::Path;

pub fn initialize(root: &Path) {
    AccountStore::default().save(root).unwrap();
    obsidian_git_sync_server::migration::initialize(root).unwrap();
}

pub async fn publish_legacy(root: &Path, user: &str, vault: &str, principal: Principal) -> String {
    let mut accounts = AccountStore::load(root).unwrap();
    let id = accounts.create_share("Synthetic protocol fixture").unwrap();
    accounts
        .shares
        .last_mut()
        .unwrap()
        .members
        .push(Membership {
            principal: principal.clone(),
            capability: Capability::ReadWrite,
        });
    accounts.save(root).unwrap();
    VaultService::new(root.into())
        .prepare_share(
            &id,
            RegisterRequest {
                remote_url: String::new(),
                branch: "main".into(),
                author_name: "Test".into(),
                author_email: "test@example.invalid".into(),
            },
        )
        .await
        .unwrap();
    let mut publication = Publication::load(root).unwrap();
    publication.published.push(id.clone());
    publication.mappings.push(Mapping {
        user: user.into(),
        vault: vault.into(),
        share_id: id.clone(),
        principals: vec![principal],
        native_enabled: true,
        dav_enabled: true,
    });
    publication.generation += 1;
    publication.save(root).unwrap();
    id
}
