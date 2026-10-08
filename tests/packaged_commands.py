"""Offline packaged-command regression fixtures. Uses unique volumes, synthetic secrets and no network."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument("--image", default="localhost/obsidisync-feat03:test")
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
target = repo / "rust-server" / "target"
base = ["podman", "--root", str(target / "container-storage-absolute"),
        "--runroot", str(target / "container-run-absolute")]
volume = "feat03-fixture-" + uuid.uuid4().hex
backup_volume = volume + "-backup"
server = volume + "-server"

def run(arguments, input=None, check=True):
    result = subprocess.run(base + arguments, input=input, text=True, capture_output=True)
    if check and result.returncode:
        raise RuntimeError(result.stderr)
    return result

with tempfile.TemporaryDirectory(prefix="packaged-feat03-", dir=target) as scratch:
    fixtures = Path(scratch)
    os.chmod(fixtures, 0o755)
    mounts = ["-v", volume + ":/data", "-v", backup_volume + ":/backup",
              "-v", str(fixtures) + ":/fixtures:ro"]

    def admin(arguments, input=None, check=True):
        return run(["run", "--rm", "-i", "--network", "none", "--user", "10001:10001"] + mounts +
                   [args.image, "admin", "--data-dir", "/data"] + arguments, input, check)

    def shell(script, *arguments, user="10001:10001"):
        return run(["run", "--rm", "--network", "none", "--user", user, "--entrypoint", "/bin/sh"] +
                   mounts + [args.image, "-eu", "-c", script, "fixture"] + list(arguments))

    run(["volume", "create", volume])
    run(["volume", "create", backup_volume])
    try:
        shell("chown 10001:10001 /backup; chmod 700 /backup", user="0:0")
        account = json.loads(admin(["account", "create", "fixture-user"], "synthetic-password-123456\n").stdout)
        share = json.loads(admin(["share", "create", "Synthetic household"]).stdout)
        admin(["membership", "grant", share["id"], "local", account["id"], "read-write"])
        grant = json.loads(admin(["credential", "share", "create", share["id"], "local", account["id"],
                                  "Household", "read-write", "Synthetic service"]).stdout)
        registration = {"remoteUrl": "", "branch": "main", "authorName": "Synthetic",
                        "authorEmail": "fixture@example.invalid"}
        mapping = {"user": "fixture-user", "vault": "notes", "share_id": share["id"],
                   "principals": [{"kind": "local", "account_id": account["id"]}],
                   "native_enabled": True, "dav_enabled": True}
        (fixtures / "setup.json").write_text(json.dumps({"registration": registration, "mapping": mapping}))
        (fixtures / "state.json").write_text(json.dumps(dict(registration, user="fixture-user", vault="notes")))
        admin(["publication", "initialize"])
        admin(["share", "setup", share["id"], "/fixtures/setup.json"])
        image = json.loads(run(["image", "inspect", args.image]).stdout)[0]
        assert "OBSIDIAN_GIT_SYNC_AUTH_MODE=oidc" in image["Config"]["Env"]
        # Actual production entrypoint with no explicit mode, including an injected dev token,
        # must demand OIDC configuration rather than starting a development listener.
        for env in [[], ["-e", "OBSIDIAN_GIT_SYNC_DEV_TOKEN=synthetic-packaged-dev-token"]]:
            rejected = run(["run", "--rm", "--network", "none"] + mounts + env + [args.image], check=False)
            assert rejected.returncode != 0 and "OIDC_ISSUER" in rejected.stderr
        before = shell("sha256sum /data/auth/share-device-passwords.json").stdout
        admin(["credential", "share", "activate", grant["id"]])
        assert shell("sha256sum /data/auth/share-device-passwords.json").stdout == before
        listed = admin(["credential", "share", "list"]).stdout
        assert grant["password"] not in listed and "password_hash" not in listed
        assert json.loads(listed)[0]["lifecycle"] == "active"
        admin(["membership", "revoke", share["id"], "local", account["id"]])
        assert json.loads(admin(["credential", "share", "list"]).stdout)[0]["lifecycle"] == "active"
        assert admin(["credential", "share", "rotate", grant["id"]], check=False).returncode != 0
        admin(["membership", "grant", share["id"], "local", account["id"], "read-write"])
        admin(["credential", "share", "rotate", grant["id"], "local", account["id"]])
        admin(["credential", "share", "revoke", grant["id"]])
        # Create an old-layout fixture from an empty, configured repository; no server is running.
        shell('mkdir -p /data/users/fixture-user/vaults; cp -a "/data/shares/$1" /data/users/fixture-user/vaults/notes; '
              'cp /fixtures/state.json /data/users/fixture-user/vaults/notes/state.json; '
              'rm -rf "/data/shares/$1"; rm /data/auth/share-publication.json; '
              'cp -a /data/auth /data/users /backup/', share["id"])
        plan = {"version": 1, "set_id": "packaged-fixture", "backup": "/backup", "mappings": [mapping], "excluded": []}
        (fixtures / "plan.json").write_text(json.dumps(plan))
        review = json.loads(admin(["migration", "dry-run", "/fixtures/plan.json"]).stdout)
        assert admin(["migration", "apply", "/fixtures/plan.json", "wrong"], check=False).returncode != 0
        admin(["migration", "apply", "/fixtures/plan.json", review["reviewDigest"]])
        admin(["validate"])
        run(["run", "--detach", "--rm", "--name", server, "--network", "none", "--user", "10001:10001"] +
            mounts + ["-e", "OBSIDIAN_GIT_SYNC_AUTH_MODE=password",
                      "-e", "OBSIDIAN_GIT_SYNC_DEV_TOKEN=synthetic-packaged-dev-token", args.image])
        for _ in range(30):
            if admin(["validate"], check=False).returncode != 0:
                assert run(["inspect", "--format", "{{.State.Running}}", server]).stdout.strip() == "true"
                break
            time.sleep(0.1)
        else:
            raise AssertionError("packaged server did not hold the directory lock")
        def request_status(path):
            # Network disabled outside the container; use its loopback socket. Return only HTTP status.
            script = ('exec 3<>/dev/tcp/127.0.0.1/8787; '
                      'printf "GET %s HTTP/1.1\\r\\nHost: localhost\\r\\nAuthorization: Bearer synthetic-packaged-dev-token\\r\\nConnection: close\\r\\n\\r\\n" "$1" >&3; '
                      'IFS= read -r line <&3; printf "%s" "$line"')
            return run(["exec", server, "/bin/bash", "-c", script, "fixture", path]).stdout
        assert " 401 " in request_status("/v2/shares/" + share["id"] + "/sync-state")
        run(["stop", "--time", "1", server])
        admin(["validate"])
        dev_share = json.loads(admin(["share", "create", "Synthetic development"]).stdout)["id"]
        admin(["membership", "grant", dev_share, "development", "dev-fixture", "read-write"])
        dev_mapping = dict(mapping, user="dev-fixture", share_id=dev_share,
                           principals=[{"kind": "development", "user": "dev-fixture"}])
        (fixtures / "dev-setup.json").write_text(json.dumps({"registration": registration, "mapping": dev_mapping}))
        admin(["share", "setup", dev_share, "/fixtures/dev-setup.json"])
        run(["run", "--detach", "--rm", "--name", server, "--network", "none"] + mounts +
            ["-e", "OBSIDIAN_GIT_SYNC_AUTH_MODE=dev", "-e", "OBSIDIAN_GIT_SYNC_DEV_USER=dev-fixture",
             "-e", "OBSIDIAN_GIT_SYNC_DEV_TOKEN=synthetic-packaged-dev-token", args.image])
        for _ in range(30):
            if admin(["validate"], check=False).returncode != 0:
                assert run(["inspect", "--format", "{{.State.Running}}", server]).stdout.strip() == "true"
                break
            time.sleep(0.1)
        else:
            raise AssertionError("explicit development server did not start")
        assert " 200 " in request_status("/v1/users/dev-fixture/vaults/notes/devices")
        assert " 404 " in request_status("/v2/shares/" + share["id"] + "/sync-state")
        run(["stop", "--time", "1", server])
        admin(["share", "retire", share["id"]])
        admin(["validate"])
        print("Packaged fixtures passed: setup, activation preservation, independent lifecycle, rotation/revocation, "
              "migration approval/publication, server exclusion/restart and retirement, production default/dev-token "
              "rejection and explicit development membership/mapping; network disabled.")
    finally:
        run(["rm", "--force", server], check=False)
        run(["volume", "rm", volume])
        run(["volume", "rm", backup_volume])
