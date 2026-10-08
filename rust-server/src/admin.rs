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
admin --data-dir PATH membership revoke SHARE local ID | membership revoke SHARE oidc ISSUER SUBJECT
admin --data-dir PATH membership list SHARE
admin --data-dir PATH credential share create SHARE local ID FOLDER read|read-write LABEL
admin --data-dir PATH credential share create SHARE oidc ISSUER SUBJECT FOLDER read|read-write LABEL
admin --data-dir PATH credential share rotate ID | credential share revoke ID | credential share list
admin --data-dir PATH credential legacy create USER VAULT FOLDER LABEL
admin --data-dir PATH credential legacy create-saber USER VAULT FOLDER PDF_FOLDER LABEL
admin --data-dir PATH credential legacy rotate USER VAULT ID | credential legacy revoke USER VAULT ID
admin --data-dir PATH credential legacy list USER VAULT
Passwords are read without echo from a terminal or from protected stdin, never arguments/environment.
Account disable rejects login/refresh; existing access tokens last at most 24 hours.
Share credentials are staged: network access unavailable until FEAT-03.";

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
        _ => bail!("explicit local ID or oidc ISSUER SUBJECT required"),
    }
}
fn staged_view(c: &share_credentials::Credential) -> Value {
    json!({"id":c.id,"shareId":c.share_id,"folder":c.folder,"capability":c.capability,
        "creator":c.creator,"label":c.label,"kind":c.kind,"lifecycle":"staged: network access unavailable until FEAT-03"})
}

pub async fn execute(root: &Path, args: &[String]) -> Result<Value> {
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut accounts = AccountStore::load(root)?;
    let devices = DevicePasswordStore::new(root);
    devices.validate().await?;
    let mut staged = share_credentials::Store::load(root)?;
    match words.as_slice() {
        ["validate"] => Ok(json!({"valid":true})),
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
            accounts.save(root)?;
            Ok(
                json!({"disabled":id,"message":"existing access tokens expire within 24 hours; legacy device passwords require separate revocation"}),
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
                    principal: p,
                    capability: capability(&args[3 + count])?,
                });
            }
            accounts.save(root)?;
            Ok(json!({"shareId":id,"operation":operation}))
        }
        ["credential", "share", "list"] => Ok(json!(staged
            .credentials
            .iter()
            .map(staged_view)
            .collect::<Vec<_>>())),
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
            let password = staged.rotate(id)?;
            staged.save(root)?;
            Ok(
                json!({"id":id,"password":password,"lifecycle":"staged: network access unavailable until FEAT-03"}),
            )
        }
        ["credential", "share", "revoke", id] => {
            staged.revoke(id)?;
            staged.save(root)?;
            Ok(json!({"revoked":id}))
        }
        ["credential", "legacy", "list", user, vault] => {
            Ok(json!(devices.list(user, vault).await?))
        }
        ["credential", "legacy", "create", user, vault, folder, label] => Ok(json!(
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
        )),
        ["credential", "legacy", "create-saber", user, vault, folder, pdf, label] => Ok(json!(
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
        )),
        ["credential", "legacy", "rotate", user, vault, id] => {
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
