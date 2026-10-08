use anyhow::{anyhow, Result};
use std::path::Path;
use std::process::Stdio;
use tokio::process::Command;

#[derive(Debug)]
pub struct GitOutput {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

pub async fn git(repo: Option<&Path>, args: &[&str], allowed_codes: &[i32]) -> Result<GitOutput> {
    let mut command = Command::new("git");
    command
        .arg("-c")
        .arg("core.hooksPath=/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = repo {
        // A repository's historical core.worktree setting must not redirect a share's
        // bookkeeping into another share or the retained, offline legacy tree.
        if cwd.join(".git").is_dir() {
            crate::paths::reject_storage_links(&cwd.join(".git"))?;
            let root = std::fs::canonicalize(cwd)?;
            command.arg("--git-dir").arg(root.join(".git"));
            command.arg("--work-tree").arg(&root);
        }
        command.current_dir(cwd);
    }
    let output = command.args(args).output().await?;
    let code = output.status.code().unwrap_or(1);
    let result = GitOutput {
        code,
        stdout: output.stdout,
        stderr: output.stderr,
    };
    if allowed_codes.contains(&code) {
        Ok(result)
    } else {
        Err(anyhow!(
            "git {} failed with {code}: {}",
            args.join(" "),
            String::from_utf8_lossy(&result.stderr)
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn configured_worktree_cannot_redirect_share_writes() {
        let fixture = tempfile::tempdir().unwrap();
        let repo = fixture.path().join("share");
        let outside = fixture.path().join("other-share");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(repo.join("owned.md"), "synthetic owned").unwrap();
        std::fs::write(outside.join("private.md"), "synthetic private").unwrap();
        git(Some(&repo), &["init"], &[0]).await.unwrap();
        git(
            Some(&repo),
            &["config", "core.worktree", outside.to_str().unwrap()],
            &[0],
        )
        .await
        .unwrap();
        git(Some(&repo), &["add", "-A"], &[0]).await.unwrap();
        let files = git(Some(&repo), &["ls-files"], &[0]).await.unwrap();
        assert_eq!(String::from_utf8(files.stdout).unwrap(), "owned.md\n");
        assert_eq!(
            std::fs::read(outside.join("private.md")).unwrap(),
            b"synthetic private"
        );
    }
}

pub async fn git_strings(repo: &Path, args: &[String], allowed_codes: &[i32]) -> Result<GitOutput> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    git(Some(repo), &refs, allowed_codes).await
}
