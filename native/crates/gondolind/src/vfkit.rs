//! Apple Virtualization backend using vfkit and guest-initiated vsock channels.

use crate::qemu::ChardevPaths;
use gondolin_proto::session::VmConfig;

pub fn is_vfkit(vm: &VmConfig) -> bool {
    vm.vmm.as_deref() == Some("vfkit")
}

pub fn binary_path(vm: &VmConfig) -> String {
    vm.vfkit_path.clone().filter(|p| !p.is_empty()).unwrap_or_else(|| "vfkit".into())
}

pub fn prepare(vm: &mut VmConfig) -> Result<(), String> {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return Err("vfkit requires an Apple Silicon macOS host".into());
    }
    if vm.cpus == 0 || vm.cpus > 255 {
        return Err("vfkit requires 1..255 vCPUs".into());
    }
    let cache = gondolin_assets::store::gondolin_cache_dir().join("vfkit-kernels");
    vm.kernel_path =
        crate::firecracker::uncompressed_kernel(std::path::Path::new(&vm.kernel_path), &cache)?
            .display()
            .to_string();
    Ok(())
}

fn path_value(path: &str) -> Result<&str, String> {
    if path.contains([',', '\n', '\r']) {
        return Err(format!("vfkit paths cannot contain commas or newlines: {path:?}"));
    }
    Ok(path)
}

pub fn args(vm: &VmConfig, append: &str, channels: &ChardevPaths) -> Result<Vec<String>, String> {
    let memory = crate::firecracker::memory_mib(vm)?;
    let mut cmdline = format!("{append} gondolin.vsock");
    if let Some(disk) = &vm.root_disk {
        if disk.snapshot {
            cmdline.push_str(" gondolin.overlay");
        }
        if disk.read_only {
            cmdline.push_str(" ro");
        }
    }
    let cmdline = cmdline.replace('\\', "\\\\").replace('"', "\\\"");
    let mut args = vec![
        "--cpus".into(),
        vm.cpus.to_string(),
        "--memory".into(),
        memory.to_string(),
        "--bootloader".into(),
        format!(
            "linux,kernel={},initrd={},cmdline=\"{cmdline}\"",
            path_value(&vm.kernel_path)?,
            path_value(&vm.initrd_path)?
        ),
    ];
    if let Some(disk) = &vm.root_disk {
        if disk.format != "raw" {
            return Err("vfkit requires a raw root disk".into());
        }
        args.extend([
            "--device".into(),
            format!(
                "virtio-blk,path={}{}",
                path_value(&disk.path)?,
                if disk.read_only || disk.snapshot { ",readonly" } else { "" }
            ),
        ]);
    }
    for (port, path) in [
        (1024, &channels.control),
        (1025, &channels.fs),
        (1026, &channels.ssh),
        (1027, &channels.ingress),
    ] {
        args.extend([
            "--device".into(),
            format!(
                "virtio-vsock,port={port},socketURL={}",
                path_value(path.to_str().ok_or("vfkit socket path must be UTF-8")?)?
            ),
        ]);
    }
    args.extend(["--device".into(), "virtio-rng".into()]);
    // Keep hvc0 present even for quiet boots: init opens /dev/console.
    // vfkit's interactive stdio mode requires a TTY; the daemon uses pipes.
    let console = if vm.console.as_deref() == Some("stdio") { "/dev/stdout" } else { "/dev/null" };
    args.extend(["--device".into(), format!("virtio-serial,logFilePath={console}")]);
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_ambiguous_device_paths() {
        assert!(path_value("/tmp/a,b").is_err());
        assert!(path_value("/tmp/a\nb").is_err());
        assert_eq!(path_value("/tmp/a b").unwrap(), "/tmp/a b");
    }

    #[test]
    fn arguments_preserve_readonly_disk_and_all_channels() {
        let mut vm = crate::tests::test_vm();
        vm.vmm = Some("vfkit".into());
        vm.root_disk = Some(gondolin_proto::session::RootDisk {
            path: "/root.raw".into(),
            format: "raw".into(),
            read_only: true,
            snapshot: false,
            mode: None,
            size: None,
        });
        let paths = ChardevPaths {
            control: "/c".into(),
            fs: "/f".into(),
            ssh: "/s".into(),
            ingress: "/i".into(),
        };
        let args = args(&vm, "console=hvc0", &paths).unwrap();
        assert!(args.iter().any(|a| a == "virtio-blk,path=/root.raw,readonly"));
        for port in 1024..=1027 {
            assert!(args.iter().any(|a| a.starts_with(&format!("virtio-vsock,port={port},"))));
        }
        assert!(args.iter().any(|a| a.contains("gondolin.vsock ro")));
        assert!(!args.iter().any(|a| a.starts_with("virtio-net")));
        assert!(args.iter().any(|a| a == "virtio-serial,logFilePath=/dev/null"));
    }
}
