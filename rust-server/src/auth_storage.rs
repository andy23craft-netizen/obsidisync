//! Private, durable JSON persistence and whole-data-directory process exclusion.
use anyhow::{bail, Context, Result};
use serde::{de::DeserializeOwned, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;

pub fn read<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    crate::paths::reject_storage_links(path)?;
    match fs::read(path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes).map_err(|_| {
            anyhow::anyhow!(
                "auth store is corrupt or unsupported; restore a protected backup offline"
            )
        })?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => bail!("auth store cannot be read; check ownership and permissions offline"),
    }
}

pub fn write<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    write_with_checkpoints(path, value, |_| Ok(()))
}

pub(crate) fn write_with_checkpoints<T: Serialize>(
    path: &Path,
    value: &T,
    checkpoint: impl Fn(&str) -> Result<()>,
) -> Result<()> {
    let parent = path.parent().context("store requires a parent directory")?;
    crate::paths::reject_storage_links(path)?;
    fs::create_dir_all(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    }
    let temp = path.with_extension("json.tmp");
    // Exclusive entrypoints own the directory; a leftover temporary file is never promoted.
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(&temp)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    checkpoint("before-rename")?;
    fs::rename(&temp, path)?;
    checkpoint("after-rename")?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

pub struct DataDirectoryLock {
    _file: File,
}

impl DataDirectoryLock {
    pub fn acquire(directory: &Path) -> Result<Self> {
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;
            use std::os::unix::fs::OpenOptionsExt;
            fs::create_dir_all(directory)?;
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .mode(0o600)
                .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
                .open(directory.join(".obsidisync.lock"))?;
            let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
            // SAFETY: valid descriptor and correctly sized output buffer.
            if unsafe { libc::fstatfs(file.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
                bail!("cannot determine data filesystem lock support");
            }
            // SAFETY: fstatfs initialized the structure on success.
            let magic = unsafe { stat.assume_init() }.f_type;
            if ![
                libc::EXT4_SUPER_MAGIC,
                libc::XFS_SUPER_MAGIC,
                libc::BTRFS_SUPER_MAGIC,
                libc::OVERLAYFS_SUPER_MAGIC,
                libc::TMPFS_MAGIC,
            ]
            .contains(&magic)
            {
                bail!("unsupported data filesystem; use local Linux ext4, XFS, Btrfs, overlayfs, or tmpfs");
            }
            // SAFETY: valid owned descriptor; flock does not take ownership.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                bail!("data directory is busy or locking is unsupported; stop the server/admin process first");
            }
            Ok(Self { _file: file })
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = directory;
            bail!("exclusive administration requires a supported local Linux filesystem");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    #[test]
    fn interrupted_write_preserves_committed_state_and_never_promotes_temp() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("auth/accounts.json");
        write(&path, &json!({"version":1,"fixture":"old"})).unwrap();
        let before = fs::read(&path).unwrap();
        let failure =
            write_with_checkpoints(&path, &json!({"version":1,"fixture":"new"}), |stage| {
                if stage == "before-rename" {
                    bail!("fixture interruption");
                }
                Ok(())
            });
        assert!(failure.is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(read::<Value>(&path).unwrap().unwrap()["fixture"], "old");
        let failure =
            write_with_checkpoints(&path, &json!({"version":1,"fixture":"new"}), |stage| {
                if stage == "after-rename" {
                    bail!("fixture interruption");
                }
                Ok(())
            });
        assert!(failure.is_err());
        assert_eq!(read::<Value>(&path).unwrap().unwrap()["fixture"], "new");
        // Recovery reads only the complete committed JSON, regardless of an old temp file.
        fs::write(path.with_extension("json.tmp"), b"{broken").unwrap();
        assert_eq!(read::<Value>(&path).unwrap().unwrap()["fixture"], "new");
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
