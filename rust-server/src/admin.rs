//! Offline CLI. The entrypoint holds DataDirectoryLock before dispatching here.
use crate::accounts::{
    import_legacy, validate_label, AccountStore, Capability, Membership, Principal,
};
use crate::device_passwords::{
    CreateDevicePasswordRequest, CreateSaberDevice, DevicePasswordStore,
};
use crate::share_credentials;
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::io::{self, BufRead, IsTerminal, Write};
use std::path::Path;

pub const HELP: &str = "Offline commands (stop server first):
admin --data-dir PATH validate
admin --data-dir PATH auth import-legacy [--dry-run]
admin --data-dir PATH account create USER | account disable ID | account list
admin --data-dir PATH share create LABEL | share rename ID LABEL | share list
admin --data-dir PATH membership grant SHARE local ID read|read-write
admin --data-dir PATH membership grant SHARE oidc ISSUER SUBJECT read|read-write
admin --data-dir PATH membership grant SHARE development USER read|read-write
admin --data-dir PATH membership revoke SHARE development USER
admin --data-dir PATH membership revoke SHARE local ID | membership revoke SHARE oidc ISSUER SUBJECT
admin --data-dir PATH membership list SHARE
admin --data-dir PATH credential share create SHARE local ID FOLDER read|read-write LABEL
admin --data-dir PATH credential share create SHARE oidc ISSUER SUBJECT FOLDER read|read-write LABEL
admin --data-dir PATH credential share create SHARE development USER FOLDER read|read-write LABEL
admin --data-dir PATH credential share rotate ID | credential share revoke ID | credential share list
admin --data-dir PATH credential share activate ID
admin --data-dir PATH credential share rotate ID local ACTOR_ID
admin --data-dir PATH credential share rotate ID oidc ACTOR_ISSUER ACTOR_SUBJECT
admin --data-dir PATH credential share rotate ID development ACTOR_USER
admin --data-dir PATH publication initialize | share setup SHARE CONFIG_JSON | share retire SHARE
admin --data-dir PATH publication recover-grants
admin --data-dir PATH migration inventory | migration dry-run PLAN_JSON
admin --data-dir PATH migration apply PLAN_JSON REVIEW_DIGEST
admin --data-dir PATH migration inspect | migration resume | migration abandon REVIEW_DIGEST
admin --data-dir PATH compatibility observe | compatibility status
admin --data-dir PATH compatibility dry-run REVIEW_JSON | compatibility cutoff REVIEW_JSON REVIEW_DIGEST
admin --data-dir PATH credential legacy create USER VAULT FOLDER LABEL
admin --data-dir PATH credential legacy create-saber USER VAULT FOLDER PDF_FOLDER LABEL
admin --data-dir PATH credential legacy rotate USER VAULT ID | credential legacy revoke USER VAULT ID
admin --data-dir PATH credential legacy list USER VAULT
Passwords are read without echo from a terminal or from protected stdin, never arguments/environment.
Account disable rejects login/refresh; existing access tokens last at most 24 hours.
Share credentials require explicit activation after publication; disabling a creator does not revoke grants.";

fn secret(prompt: &str) -> Result<String> {
    if io::stdin().is_terminal() {
        return Ok(rpassword::prompt_password(prompt)?);
    }
    let mut line = String::new();
    io::stdin().lock().read_line(&mut line)?;
    if line.ends_with('\n') {
        line.pop();
        if line.ends_with('\r') {
            line.pop();
        }
    }
    Ok(line)
}
fn capability(text: &str) -> Result<Capability> {
    match text {
        "read" => Ok(Capability::Read),
        "read-write" => Ok(Capability::ReadWrite),
        _ => bail!("invalid capability"),
    }
}
fn principal(args: &[String]) -> Result<(Principal, usize)> {
    match args.first().map(String::as_str) {
        Some("development") if args.len() >= 2 => Ok((
            Principal::Development {
                user: args[1].clone(),
            },
            2,
        )),
        Some("local") if args.len() >= 2 => Ok((
            Principal::Local {
                account_id: args[1].clone(),
            },
            2,
        )),
        Some("oidc") if args.len() >= 3 => Ok((
            Principal::Oidc {
                issuer: args[1].clone(),
                subject: args[2].clone(),
            },
            3,
        )),
        _ => bail!("explicit local ID, oidc ISSUER SUBJECT, or development USER required"),
    }
}
fn staged_view(
    c: &share_credentials::Credential,
    publication: Option<&crate::publication::Publication>,
) -> Value {
    json!({"id":c.id,"shareId":c.share_id,"folder":c.folder,"capability":c.capability,
        "creator":c.creator,"rotationActor":c.rotation_actor,"label":c.label,"kind":c.kind,"lifecycle":
            if publication.is_some_and(|p| !p.available(&c.share_id)) { "unavailable" }
            else if publication.is_some_and(|p| p.activated.contains(&c.id)) { "active" } else { "staged" }})
}
fn legacy_actor(root: &Path, args: &[String], user: &str, vault: &str) -> Result<()> {
    if !root.join(crate::publication::AUTHORITY).exists() && args.is_empty() {
        return Ok(());
    }
    let (actor,count)=principal(args).map_err(|_| anyhow!("published legacy issuance/rotation requires an explicit acting local ID, oidc ISSUER SUBJECT, or development USER"))?;
    if args.len() != count {
        bail!("invalid legacy acting principal arguments");
    }
    let publication = crate::publication::Publication::load(root)?;
    let share = publication.mapping(user, vault)?.share_id.clone();
    publication.authorize(root, &share, &actor, Capability::ReadWrite)
}

pub async fn execute(root: &Path, args: &[String]) -> Result<Value> {
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    // Recovery dispatch precedes all ordinary account/grant operations. A pending journal
    // freezes their inputs until the reviewed publication has been recovered offline.
    match words.as_slice() {
        ["publication", "initialize"] => {
            crate::migration::initialize(root)?;
            return Ok(json!({"initialized":true}));
        }
        ["migration", "inventory"] => return Ok(json!(crate::migration::inventory(root)?)),
        ["migration", "inspect"] => return crate::migration::inspect(root),
        ["migration", "resume"] => {
            crate::migration::resume(root).await?;
            return Ok(json!({"recovered":true}));
        }
        ["migration", "abandon", digest] => {
            crate::migration::abandon(root, digest)?;
            return Ok(
                json!({"abandoned":true,"message":"legacy sources and previous publication preserved"}),
            );
        }
        ["migration", "dry-run", path] => {
            let (plan, digest) = crate::migration::read_plan(Path::new(path))?;
            crate::migration::dry_run(root, &plan).await?;
            return Ok(json!({"valid":true,"reviewDigest":digest}));
        }
        ["migration", "apply", path, digest] => {
            let (plan, actual) = crate::migration::read_plan(Path::new(path))?;
            crate::migration::apply(root, plan, actual, digest).await?;
            return Ok(json!({"published":true}));
        }
        _ => {}
    }
    if root.join(crate::publication::PENDING).exists() {
        bail!(
            "publication pending; inspect/recover offline before administering accounts or grants"
        );
    }
    let mut accounts = AccountStore::load(root)?;
    let devices = DevicePasswordStore::new(root);
    devices.validate().await?;
    let mut staged = share_credentials::Store::load(root)?;
    match words.as_slice() {
        ["publication", "recover-grants"] => {
            let mut publication = crate::publication::Publication::read_for_recovery(root)?
                .ok_or_else(|| anyhow!("publication missing"))?;
            let removed: Vec<_> = publication
                .activated
                .iter()
                .filter(|id| !staged.credentials.iter().any(|c| &c.id == *id))
                .cloned()
                .collect();
            publication
                .activated
                .retain(|id| staged.credentials.iter().any(|c| &c.id == id));
            publication.generation += 1;
            publication.save(root)?;
            Ok(
                json!({"removedDanglingActivationIds":removed,"message":"no secrets or surviving grants changed"}),
            )
        }
        ["compatibility", "observe"] => {
            Ok(json!({"observedSince":crate::compatibility::observe(root)?,
            "message":"use an interval covering the longest required offline-client return; missing/reset telemetry restarts observation"}))
        }
        ["compatibility", "status"] => Ok(
            json!({"publication":crate::publication::Publication::load(root)?,
            "evidence":crate::compatibility::load(root)?,"independentGrantsRequireExplicitRevocation":true}),
        ),
        ["compatibility", operation @ ("dry-run" | "cutoff"), path, ..] => {
            if (*operation == "dry-run" && args.len() != 3)
                || (*operation == "cutoff" && args.len() != 4)
            {
                bail!("invalid cutoff review arguments");
            }
            let bytes = std::fs::read(path)?;
            let review: crate::compatibility::Review = serde_json::from_slice(&bytes)?;
            use sha2::{Digest, Sha256};
            let digest = format!("{:x}", Sha256::digest(&bytes));
            let mut publication = crate::publication::Publication::load(root)?;
            crate::compatibility::validate_review(
                root,
                &publication,
                &review,
                crate::time_format::unix_now(),
            )?;
            for mapping in &publication.mappings {
                for grant in devices.list(&mapping.user, &mapping.vault).await? {
                    if !review.consumers.iter().any(|c| {
                        c.share_id == mapping.share_id
                            && c.protocol == "dav"
                            && c.client == grant.id
                    }) {
                        bail!("legacy grant missing from reviewed consumer inventory");
                    }
                }
            }
            if *operation == "cutoff" {
                if args[3] != digest {
                    bail!("reviewed cutoff confirmation mismatch");
                }
                for mapping in &mut publication.mappings {
                    mapping.native_enabled = false;
                    mapping.dav_enabled = review.consumers.iter().any(|c| {
                        c.share_id == mapping.share_id
                            && c.retain
                            && matches!(c.protocol.as_str(), "dav" | "saber")
                    });
                }
                publication.compatibility_cutoff = Some(review.clone());
                publication.generation += 1;
                publication.save(root)?;
            }
            Ok(
                json!({"valid":true,"reviewDigest":digest,"committed":*operation=="cutoff",
                "retainedExceptions":review.consumers.iter().filter(|c| c.retain).count()}),
            )
        }
        ["validate"] => {
            if root.join(crate::publication::AUTHORITY).exists() {
                crate::publication::Publication::load(root)?.validate(root)?;
            }
            Ok(json!({"valid":true}))
        }
        ["auth", "import-legacy"] | ["auth", "import-legacy", "--dry-run"] => {
            let expected = std::env::var("OBSIDIAN_GIT_SYNC_PASSWORD_USER")
                .ok()
                .or_else(|| std::env::var("OBSIDIAN_GIT_SYNC_USER").ok());
            let result = import_legacy(root, expected.as_deref(), words.len() == 3)?;
            Ok(
                json!({"user":result.user,"accountId":result.account_id,"dryRun":words.len()==3,
                "message": if result.account_id.is_some() { "password sessions require re-login" }
                    else { "no configured legacy account; create an account offline" }}),
            )
        }
        ["account", "list"] => Ok(json!(accounts
            .accounts
            .iter()
            .map(|a| json!({"id":a.id,"user":a.user,"enabled":a.enabled}))
            .collect::<Vec<_>>())),
        ["account", "create", user] => {
            if root.join("auth/password.json").exists() && accounts.legacy_import.is_none() {
                bail!("import the legacy account offline before creating accounts");
            }
            let password = secret("New account password: ")?;
            let id = accounts.create_account(user, &password)?;
            accounts.save(root)?;
            Ok(json!({"id":id,"user":crate::auth::normalize_user_claim(user)?}))
        }
        ["account", "disable", id] => {
            let a = accounts
                .accounts
                .iter_mut()
                .find(|a| a.id == *id)
                .ok_or_else(|| anyhow!("account not found"))?;
            a.enabled = false;
            let namespace = a.user.clone();
            accounts.save(root)?;
            let surviving: Vec<_> = staged
                .credentials
                .iter()
                .filter(|c| {
                    c.creator
                        == Principal::Local {
                            account_id: id.to_string(),
                        }
                })
                .map(|c| c.id.clone())
                .collect();
            Ok(
                json!({"disabled":id,"survivingIndependentShareGrants":surviving,
                "survivingLegacyGrants":devices.inventory().await?.iter().filter(|grant| grant.username==namespace).map(|grant| grant.id.clone()).collect::<Vec<_>>(),
                "message":"existing access tokens expire within 24 hours; share and legacy device/service grants require separate explicit revocation"}),
            )
        }
        ["share", "list"] => Ok(json!(accounts
            .shares
            .iter()
            .map(|s| json!({"id":s.id,"label":s.label,"createdAt":s.created_at}))
            .collect::<Vec<_>>())),
        ["share", "create", label] => {
            let id = accounts.create_share(label)?;
            accounts.save(root)?;
            Ok(json!({"id":id,"label":label}))
        }
        ["share", "setup", id, path] => {
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Setup {
                registration: crate::protocol::RegisterRequest,
                mapping: Option<crate::publication::Mapping>,
            }
            let setup: Setup = serde_json::from_slice(&std::fs::read(path)?)?;
            let mut publication = crate::publication::Publication::load(root)?;
            if !accounts.shares.iter().any(|share| share.id == *id) {
                bail!("share not found");
            }
            if let Some(mapping) = &setup.mapping {
                if mapping.share_id != *id || mapping.principals.is_empty() {
                    bail!("setup requires explicit matching share and namespace principals");
                }
                for principal in &mapping.principals {
                    accounts.validate_principal(principal)?;
                    if accounts.capability(id, principal).is_none() {
                        bail!("mapped principal lacks membership");
                    }
                }
            }
            let service =
                crate::vault::VaultService::new_with_options(crate::vault::VaultServiceOptions {
                    data_dir: root.to_path_buf(),
                    remote_policy: crate::remote::RemotePolicy::default(),
                    upload_limits: crate::vault::UploadLimits::default(),
                });
            service.prepare_share(id, setup.registration).await?;
            publication.published.push(id.to_string());
            if let Some(mapping) = setup.mapping {
                publication.mappings.push(mapping);
            }
            publication.generation += 1;
            publication.save(root)?;
            Ok(json!({"published":id}))
        }
        ["share", "rename", id, label] => {
            validate_label(label)?;
            accounts
                .shares
                .iter_mut()
                .find(|s| s.id == *id)
                .ok_or_else(|| anyhow!("share not found"))?
                .label = label.to_string();
            accounts.save(root)?;
            Ok(json!({"id":id,"label":label}))
        }
        ["share", "retire", id] => {
            let mut publication = crate::publication::Publication::load(root)?;
            if !publication.published.iter().any(|share| share == id) {
                bail!("published share not found");
            }
            if !publication.retired.iter().any(|share| share == id) {
                publication.retired.push(id.to_string());
                publication.generation += 1;
                publication.save(root)?;
            }
            Ok(
                json!({"retired":id,"message":"all native, legacy and independent grants are unavailable; explicitly revoke/archive grants before deletion"}),
            )
        }
        ["membership", "list", id] => Ok(json!(
            accounts
                .shares
                .iter()
                .find(|s| s.id == *id)
                .ok_or_else(|| anyhow!("share not found"))?
                .members
        )),
        ["membership", operation @ ("grant" | "revoke"), id, ..] => {
            let (p, count) = principal(&args[3..])?;
            let required = 3 + count + usize::from(*operation == "grant");
            if args.len() != required {
                bail!("invalid membership arguments");
            }
            accounts.validate_principal(&p)?;
            let share = accounts
                .shares
                .iter_mut()
                .find(|s| s.id == *id)
                .ok_or_else(|| anyhow!("share not found"))?;
            share.members.retain(|m| m.principal != p);
            if *operation == "grant" {
                share.members.push(Membership {
                    principal: p.clone(),
                    capability: capability(&args[3 + count])?,
                });
            }
            accounts.save(root)?;
            let surviving: Vec<_> = staged
                .credentials
                .iter()
                .filter(|c| c.share_id == *id && c.creator == p)
                .map(|c| c.id.clone())
                .collect();
            Ok(
                json!({"shareId":id,"operation":operation,"survivingIndependentShareGrants":surviving,
                "message":"device/service grants are independent; review credential inventories and explicitly revoke unwanted grants"}),
            )
        }
        ["credential", "share", "list"] => {
            let publication = if root.join(crate::publication::AUTHORITY).exists() {
                Some(crate::publication::Publication::load(root)?)
            } else {
                None
            };
            let usage = crate::compatibility::share_usage(root)?;
            Ok(json!(staged
                .credentials
                .iter()
                .map(|c| {
                    let mut view = staged_view(c, publication.as_ref());
                    view["usage"] = json!(usage.get(&c.id));
                    view["shareLabel"] = json!(accounts
                        .shares
                        .iter()
                        .find(|s| s.id == c.share_id)
                        .map(|s| &s.label));
                    view
                })
                .collect::<Vec<_>>()))
        }
        ["credential", "share", "create", share, ..] => {
            let (p, count) = principal(&args[4..])?;
            if args.len() != 4 + count + 3 {
                bail!("invalid staged credential arguments");
            }
            let tail = &args[4 + count..];
            let (id, password) = staged.create(
                &accounts,
                share,
                p,
                &tail[0],
                capability(&tail[1])?,
                &tail[2],
            )?;
            staged.save(root)?;
            Ok(
                json!({"id":id,"password":password,"lifecycle":"staged: network access unavailable until FEAT-03"}),
            )
        }
        ["credential", "share", "rotate", id] => {
            let c = staged
                .credentials
                .iter()
                .find(|c| c.id == *id)
                .ok_or_else(|| anyhow!("credential not found"))?;
            if !accounts
                .capability(&c.share_id, &c.creator)
                .is_some_and(|cap| cap.permits(c.capability))
            {
                bail!("creator lacks required share capability");
            }
            let actor = c.creator.clone();
            if root.join(crate::publication::AUTHORITY).exists() {
                crate::publication::Publication::load(root)?.authorize(
                    root,
                    &c.share_id,
                    &actor,
                    c.capability,
                )?;
            }
            let password = staged.rotate_as(id, actor)?;
            staged.save(root)?;
            Ok(
                json!({"id":id,"password":password,"lifecycle":"staged: network access unavailable until FEAT-03"}),
            )
        }
        ["credential", "share", "rotate", id, ..] => {
            let (actor, count) = principal(&args[4..])?;
            if args.len() != 4 + count {
                bail!("invalid rotation actor arguments");
            }
            let grant = staged
                .credentials
                .iter()
                .find(|grant| grant.id == *id)
                .ok_or_else(|| anyhow!("credential not found"))?;
            if !accounts
                .capability(&grant.share_id, &actor)
                .is_some_and(|cap| cap.permits(grant.capability))
            {
                bail!("acting member lacks required share capability");
            }
            if root.join(crate::publication::AUTHORITY).exists() {
                crate::publication::Publication::load(root)?.authorize(
                    root,
                    &grant.share_id,
                    &actor,
                    grant.capability,
                )?;
            }
            let password = staged.rotate_as(id, actor.clone())?;
            staged.save(root)?;
            Ok(json!({"id":id,"password":password,"rotationActor":actor}))
        }
        ["credential", "share", "revoke", id] => {
            if root.join(crate::publication::AUTHORITY).exists() {
                let mut publication = crate::publication::Publication::load(root)?;
                publication.activated.retain(|active| active != id);
                publication.generation += 1;
                publication.save(root)?;
            }
            staged.revoke(id)?;
            staged.save(root)?;
            Ok(json!({"revoked":id}))
        }
        ["credential", "share", "activate", id] => {
            let grant = staged
                .credentials
                .iter()
                .find(|c| c.id == *id)
                .ok_or_else(|| anyhow!("credential not found"))?;
            let mut publication = crate::publication::Publication::load(root)?;
            publication.authorize(root, &grant.share_id, &grant.creator, grant.capability)?;
            if !publication.activated.iter().any(|active| active == id) {
                publication.activated.push(id.to_string());
                publication.generation += 1;
                publication.save(root)?;
            }
            Ok(json!({"activated":id,"shareId":grant.share_id,
                "message":"existing secret and scope preserved; independently revocable grant"}))
        }
        ["credential", "legacy", "list", user, vault] => {
            Ok(json!(devices.list(user, vault).await?))
        }
        ["credential", "legacy", "create", user, vault, folder, label, ..] => {
            legacy_actor(root, &args[7..], user, vault)?;
            Ok(json!(
                devices
                    .create(
                        user,
                        vault,
                        CreateDevicePasswordRequest {
                            label: label.to_string(),
                            folder: folder.to_string()
                        }
                    )
                    .await?
            ))
        }
        ["credential", "legacy", "create-saber", user, vault, folder, pdf, label, ..] => {
            legacy_actor(root, &args[8..], user, vault)?;
            Ok(json!(
                devices
                    .create_saber(
                        user,
                        vault,
                        CreateSaberDevice {
                            label: label.to_string(),
                            folder: folder.to_string(),
                            pdf_folder: pdf.to_string(),
                            encryption_password: secret(
                                "Saber encryption password (empty skips rendering): "
                            )?
                        }
                    )
                    .await?
            ))
        }
        ["credential", "legacy", "rotate", user, vault, id, ..] => {
            legacy_actor(root, &args[6..], user, vault)?;
            Ok(json!(devices.rotate(user, vault, id).await?))
        }
        ["credential", "legacy", "revoke", user, vault, id] => {
            if !devices.revoke(user, vault, id).await? {
                bail!("credential not found");
            }
            Ok(json!({"revoked":id}))
        }
        _ => bail!("invalid admin command; use admin --help (secrets must never be arguments)"),
    }
}

pub async fn run(root: &Path, args: &[String]) -> Result<()> {
    let value = execute(root, args).await?;
    writeln!(
        io::stdout().lock(),
        "{}",
        serde_json::to_string_pretty(&value)?
    )?;
    Ok(())
}
