//! Same-host Firecracker snapshots. The actor stops admitting work while the
//! guest is paused; in-flight exec, filesystem and forwarding work is refused.

use super::*;
use crate::firecracker_api::{object, request};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};

gondolin_wire::wire_struct! {
    #[derive(Clone)]
    pub(super) struct Restore {
        snapshot_path: String,
        mem_path: String,
        state_path: String,
    }
}
gondolin_wire::wire_struct! {
    struct Saved {
        version: u32,
        vm: ps::VmConfig,
        vfs: Option<Value>,
        fuse_mount: String,
        fuse_binds: Vec<String>,
    }
}

impl Session {
    fn snapshot_supported(&self) -> Result<(), String> {
        let cfg = self.configured.as_ref().ok_or("configure before using snapshots")?;
        if !crate::firecracker::is_firecracker(&cfg.vm) || cfg.vm.nitro.is_some() {
            return Err("VM-state snapshots require the Firecracker KVM backend".into());
        }
        if crate::jailer::settings(&cfg.vm)?.is_some() {
            return Err("VM-state snapshots are unavailable inside the Firecracker jailer".into());
        }
        if !matches!(self.net, NetSetup::None) {
            return Err(
                "VM-state snapshots require netEnabled=false; network state is not captured".into(),
            );
        }
        Ok(())
    }

    pub(super) async fn capture_snapshot(&mut self, msg: RawEnvelope) {
        let result = self.capture_snapshot_inner(&msg.p).await;
        match result {
            Ok(fields) => self.ctl.reply_ok(&msg.t, msg.id, fields),
            Err(e) => self.ctl.reply_err(&msg.t, msg.id, "snapshot_failed", &e),
        }
    }

    async fn capture_snapshot_inner(
        &mut self,
        payload: &Value,
    ) -> Result<Vec<(Value, Value)>, String> {
        self.snapshot_supported()?;
        if self.status != State::Running
            || self.vm.child.is_none()
            || self.has_active_guest_activity()
        {
            return Err(
                "VM-state snapshot requires a running, idle VM with no open forwards".into()
            );
        }
        let cfg = self.configured.as_ref().unwrap();
        let rt = self.runtime.as_ref().ok_or("session is not started")?;
        if cfg.vm.root_disk.as_ref().is_some_and(|d| PathBuf::from(&d.path).starts_with(&rt.dir.0))
        {
            return Err(
                "VM-state snapshots require a persistent root disk or memory/readonly mode".into(),
            );
        }
        let boot = self.boot_config.as_ref().ok_or("guest is not booted")?;
        let dir =
            PathBuf::from(Fields::of(payload).text("directory").ok_or("directory is required")?);
        if !dir.is_absolute() {
            return Err("snapshot directory must be absolute".into());
        }
        // Never overwrite a previous snapshot. A private directory protects
        // memory (including guest credentials) before Firecracker creates it.
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&dir)
            .map_err(|e| format!("cannot create snapshot directory: {e}"))?;
        let state_path = dir.join("host.cbor");
        let snapshot_path = dir.join("vm.fc");
        let mem_path = dir.join("vm.mem");
        let api = rt.dir.0.join("firecracker-api.sock");
        request(&api, "PATCH", "/vm", &object([("state", Value::from("Paused"))])).await?;
        let captured = async {
            let saved = Saved {
                version: 1,
                vm: cfg.vm.clone(),
                vfs: self.vfs.as_ref().map(|v| v.snapshot_state()).transpose()?,
                fuse_mount: boot.fuse_mount.clone(),
                fuse_binds: boot.fuse_binds.clone(),
            };
            let bytes = gondolin_wire::cbor::encode(&saved.to_value());
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&state_path)
                .map_err(|e| e.to_string())?;
            file.write_all(&bytes).and_then(|()| file.sync_all()).map_err(|e| e.to_string())?;
            request(
                &api,
                "PUT",
                "/snapshot/create",
                &object([
                    ("snapshot_type", Value::from("Full")),
                    ("snapshot_path", Value::from(snapshot_path.display().to_string())),
                    ("mem_file_path", Value::from(mem_path.display().to_string())),
                ]),
            )
            .await?;
            for path in [&snapshot_path, &mem_path] {
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                    .map_err(|e| e.to_string())?;
            }
            Ok::<(), String>(())
        }
        .await;
        // A resume failure is never hidden: the caller must know the live VM
        // may still be paused even if its snapshot was written successfully.
        let resumed =
            request(&api, "PATCH", "/vm", &object([("state", Value::from("Resumed"))])).await;
        resumed?;
        captured?;
        Ok(vec![(Value::from("state_path"), Value::from(state_path.display().to_string()))])
    }

    pub(super) fn import_snapshot(&mut self, msg: RawEnvelope) {
        let result = self.import_snapshot_inner(&msg.p);
        match result {
            Ok(()) => self.ctl.reply_ok(&msg.t, msg.id, vec![]),
            Err(e) => self.ctl.reply_err(&msg.t, msg.id, "snapshot_failed", &e),
        }
    }

    fn import_snapshot_inner(&mut self, payload: &Value) -> Result<(), String> {
        self.snapshot_supported()?;
        if self.is_started() || self.snapshot_restore.is_some() {
            return Err("import one snapshot before start".into());
        }
        let restore: Restore = gondolin_wire::from_value(payload).map_err(|e| e.to_string())?;
        for path in [&restore.snapshot_path, &restore.mem_path, &restore.state_path] {
            if !PathBuf::from(path).is_absolute()
                || !std::fs::metadata(path).is_ok_and(|m| m.is_file())
            {
                return Err(format!("snapshot file must be an absolute regular file: {path}"));
            }
        }
        let bytes = std::fs::read(&restore.state_path).map_err(|e| e.to_string())?;
        let saved: Saved = gondolin_wire::decode(&bytes).map_err(|e| e.to_string())?;
        let cfg = self.configured.as_ref().unwrap();
        let same_disk = match (&cfg.vm.root_disk, &saved.vm.root_disk) {
            (Some(a), Some(b)) => crate::rootdisk::same_file(
                std::path::Path::new(&a.path),
                std::path::Path::new(&b.path),
            ),
            (None, None) => true,
            _ => false,
        };
        if saved.version != 1
            || cfg.vm.cpus != saved.vm.cpus
            || cfg.vm.memory != saved.vm.memory
            || !same_disk
        {
            return Err(
                "snapshot requires the original memory, CPU count and persistent root disk".into(),
            );
        }
        match (&self.vfs, &saved.vfs) {
            (Some(vfs), Some(state)) => vfs.restore_state(state)?,
            (None, None) => {}
            _ => return Err("snapshot VFS configuration changed".into()),
        }
        let boot = SandboxFsConfig { fuse_mount: saved.fuse_mount, fuse_binds: saved.fuse_binds };
        *self.boot_shared.lock().unwrap() = Some(boot.clone());
        self.boot_config = Some(boot);
        self.configured.as_mut().unwrap().vm.root_disk = saved.vm.root_disk;
        self.snapshot_restore = Some(restore);
        Ok(())
    }

    pub(super) fn start_snapshot_restore(&self, generation: u64) {
        let Some(restore) = self.snapshot_restore.clone() else { return };
        let Some(rt) = self.runtime.as_ref() else { return };
        let api = rt.dir.0.join("firecracker-api.sock");
        let vsock = crate::firecracker::vsock_uds(&rt.dir.0);
        let events = self.events.clone();
        tokio::spawn(async move {
            let result = async {
                crate::firecracker_api::wait_ready(&api).await?;
                request(
                    &api,
                    "PUT",
                    "/snapshot/load",
                    &object([
                        ("snapshot_path", Value::from(restore.snapshot_path)),
                        ("mem_file_path", Value::from(restore.mem_path)),
                        ("resume_vm", Value::Bool(true)),
                        (
                            "vsock_override",
                            object([("uds_path", Value::from(vsock.display().to_string()))]),
                        ),
                    ]),
                )
                .await
            }
            .await;
            let _ = events.send(Event::SnapshotLoaded { generation, result });
        });
    }
}
