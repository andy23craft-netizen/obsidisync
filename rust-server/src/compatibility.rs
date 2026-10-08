//! Persistent, content-free evidence for an explicit offline compatibility cutoff.
use crate::{
    auth_storage,
    publication::{Mapping, Publication},
};
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

const FILE: &str = "auth/v1-activity.json";
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Evidence {
    pub version: u32,
    pub observed_since: u64,
    pub activity: BTreeMap<String, Activity>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Activity {
    pub share_id: String,
    pub protocol: String,
    pub client: String,
    pub count: u64,
    pub last_used: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Consumer {
    pub share_id: String,
    pub protocol: String,
    pub client: String,
    #[serde(default = "required_by_default")]
    pub required: bool,
    pub migrated: bool,
    pub reconciled: bool,
    pub verified: bool,
    pub retain: bool,
}
fn required_by_default() -> bool {
    true
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Review {
    pub observed_since: u64,
    pub observation_seconds: u64,
    pub consumers: Vec<Consumer>,
}
#[derive(Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct GrantUsage {
    pub count: u64,
    pub last_used: u64,
}
pub fn share_usage(root: &Path) -> Result<BTreeMap<String, GrantUsage>> {
    Ok(auth_storage::read(&root.join("auth/share-grant-usage.json"))?.unwrap_or_default())
}
pub fn record_share_grant(root: &Path, id: &str) -> Result<()> {
    let mutex = lock(root);
    let _guard = mutex.lock().expect("activity lock poisoned");
    let mut usage = share_usage(root)?;
    let entry = usage.entry(id.into()).or_default();
    entry.count = entry.count.saturating_add(1);
    entry.last_used = crate::time_format::unix_now();
    auth_storage::write(&root.join("auth/share-grant-usage.json"), &usage)
}
fn lock(root: &Path) -> std::sync::Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<BTreeMap<PathBuf, std::sync::Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .expect("activity lock poisoned")
        .entry(root.into())
        .or_insert_with(|| std::sync::Arc::new(Mutex::new(())))
        .clone()
}
pub fn client_id(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
pub fn load(root: &Path) -> Result<Option<Evidence>> {
    let evidence: Option<Evidence> = auth_storage::read(&root.join(FILE))?;
    if evidence
        .as_ref()
        .is_some_and(|e| e.version != 1 || e.observed_since == 0)
    {
        bail!("invalid compatibility evidence; restart observation offline");
    }
    Ok(evidence)
}
pub fn observe(root: &Path) -> Result<u64> {
    let mutex = lock(root);
    let _guard = mutex.lock().expect("activity lock poisoned");
    let mut evidence = load(root)?.unwrap_or_default();
    evidence.version = 1;
    evidence.observed_since = crate::time_format::unix_now();
    auth_storage::write(&root.join(FILE), &evidence)?;
    Ok(evidence.observed_since)
}
pub fn record(root: &Path, mapping: &Mapping, protocol: &str, client: &str) -> Result<()> {
    let mutex = lock(root);
    let _guard = mutex.lock().expect("activity lock poisoned");
    let now = crate::time_format::unix_now();
    let mut evidence = load(root)?.unwrap_or(Evidence {
        version: 1,
        observed_since: now,
        activity: BTreeMap::new(),
    });
    let key = format!("{}:{protocol}:{client}", mapping.share_id);
    let entry = evidence.activity.entry(key).or_insert(Activity {
        share_id: mapping.share_id.clone(),
        protocol: protocol.into(),
        client: client.into(),
        count: 0,
        last_used: now,
    });
    entry.count = entry.count.saturating_add(1);
    entry.last_used = now;
    auth_storage::write(&root.join(FILE), &evidence)
}
pub fn validate_review(
    root: &Path,
    publication: &Publication,
    review: &Review,
    now: u64,
) -> Result<()> {
    let evidence =
        load(root)?.ok_or_else(|| anyhow!("missing telemetry; restart observation offline"))?;
    if review.observation_seconds == 0
        || review.observed_since != evidence.observed_since
        || now.saturating_sub(review.observed_since) < review.observation_seconds
    {
        bail!("observation interval incomplete or reset");
    }
    let mut consumers = std::collections::HashSet::new();
    for consumer in &review.consumers {
        if !publication.available(&consumer.share_id)
            || !matches!(consumer.protocol.as_str(), "native" | "dav" | "saber")
            || consumer.client.is_empty()
            || !consumers.insert((&consumer.share_id, &consumer.protocol, &consumer.client))
        {
            bail!("invalid or duplicate consumer inventory");
        }
        if consumer.retain && consumer.protocol == "native" {
            bail!("native clients must migrate before cutoff");
        }
        if !consumer.required && consumer.client == client_id("namespace") {
            bail!("unidentified namespace activity requires a quiet observation interval");
        }
        if !consumer.retain
            && !(consumer.verified
                && (!consumer.required || (consumer.migrated && consumer.reconciled)))
        {
            bail!("consumer migration/reconciliation unverified");
        }
    }
    for mapping in &publication.mappings {
        if mapping.native_enabled
            && !review
                .consumers
                .iter()
                .any(|c| c.share_id == mapping.share_id && c.protocol == "native")
        {
            bail!("missing required native client inventory");
        }
    }
    for activity in evidence.activity.values() {
        let consumer = review.consumers.iter().find(|c| {
            c.share_id == activity.share_id
                && c.protocol == activity.protocol
                && c.client == activity.client
        });
        if activity.client != client_id("namespace") && consumer.is_none() {
            bail!("observed client missing from reviewed inventory");
        }
        if activity.last_used >= review.observed_since
            && !consumer.is_some_and(|c| c.retain || !c.required)
        {
            bail!("required legacy activity observed; restart observation after client migration");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn review() -> Review {
        Review {
            observed_since: 100,
            observation_seconds: 60,
            consumers: vec![Consumer {
                share_id: "s_fixture".into(),
                protocol: "native".into(),
                client: client_id("fixture-client"),
                required: true,
                migrated: true,
                reconciled: true,
                verified: true,
                retain: false,
            }],
        }
    }
    fn publication() -> Publication {
        Publication {
            published: vec!["s_fixture".into()],
            mappings: vec![Mapping {
                user: "fixture".into(),
                vault: "notes".into(),
                share_id: "s_fixture".into(),
                principals: vec![],
                native_enabled: true,
                dav_enabled: true,
            }],
            ..Default::default()
        }
    }
    #[test]
    fn cutoff_requires_complete_inventory_persistent_interval_and_zero_required_activity() {
        let root = tempfile::tempdir().unwrap();
        let publication = publication();
        let review = review();
        assert!(validate_review(root.path(), &publication, &review, 200).is_err());
        auth_storage::write(
            &root.path().join(FILE),
            &Evidence {
                version: 1,
                observed_since: 100,
                activity: BTreeMap::new(),
            },
        )
        .unwrap();
        assert!(validate_review(root.path(), &publication, &review, 159).is_err());
        assert!(validate_review(
            root.path(),
            &publication,
            &Review {
                observed_since: 99,
                ..review.clone()
            },
            200
        )
        .is_err());
        let mut incomplete = review.clone();
        incomplete.consumers[0].verified = false;
        assert!(validate_review(root.path(), &publication, &incomplete, 200).is_err());
        let empty = Review {
            consumers: vec![],
            ..review.clone()
        };
        assert!(validate_review(root.path(), &publication, &empty, 200).is_err());
        validate_review(root.path(), &publication, &review, 200).unwrap();
        record(
            root.path(),
            &publication.mappings[0],
            "native",
            &client_id("returning-old-client"),
        )
        .unwrap();
        assert!(validate_review(root.path(), &publication, &review, 200).is_err());
        let persisted = load(root.path()).unwrap().unwrap();
        assert_eq!(persisted.activity.values().next().unwrap().count, 1);
        let new_epoch = observe(root.path()).unwrap();
        assert_ne!(new_epoch, review.observed_since);
        assert!(validate_review(root.path(), &publication, &review, new_epoch + 60).is_err());
    }
    #[test]
    fn retained_exceptions_are_protocol_and_grant_specific_and_do_not_expire_on_restart() {
        let root = tempfile::tempdir().unwrap();
        let mut publication = publication();
        let mut review = review();
        review.consumers.push(Consumer {
            share_id: "s_fixture".into(),
            protocol: "saber".into(),
            client: "legacy-fixture-id".into(),
            required: true,
            migrated: false,
            reconciled: false,
            verified: false,
            retain: true,
        });
        auth_storage::write(
            &root.path().join(FILE),
            &Evidence {
                version: 1,
                observed_since: 100,
                activity: BTreeMap::new(),
            },
        )
        .unwrap();
        record(
            root.path(),
            &publication.mappings[0],
            "saber",
            "legacy-fixture-id",
        )
        .unwrap();
        validate_review(root.path(), &publication, &review, 200).unwrap();
        publication.compatibility_cutoff = Some(review);
        assert!(publication
            .legacy_device("fixture", "notes", "legacy-fixture-id", "saber")
            .is_ok());
        assert!(publication
            .legacy_device("fixture", "notes", "legacy-fixture-id", "dav")
            .is_err());
        assert!(publication
            .legacy_device("fixture", "notes", "another-id", "saber")
            .is_err());
        let restarted: Publication =
            serde_json::from_slice(&serde_json::to_vec(&publication).unwrap()).unwrap();
        assert!(restarted
            .legacy_device("fixture", "notes", "legacy-fixture-id", "saber")
            .is_ok());
    }
}
