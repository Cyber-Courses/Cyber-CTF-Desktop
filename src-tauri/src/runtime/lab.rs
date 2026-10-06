//! A lab's Isoloom side: every lab describes itself with an `isoloom.yml` at its root, and the
//! launcher generates the files of the target it runs on under the lab's `.isoloom/` (Compose,
//! Vagrant, Terraform) right before running them. Nothing is read from the lab besides the
//! spec and the files it names, so a lab is portable to every target Isoloom supports.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use isoloom_core::{Spec, Target};

use super::{Interface, Network, Runtime};
use crate::error::{Error, Result};

/// The lab's spec, checked (fields and the files it names).
pub fn spec(dir: &Path) -> Result<Spec> {
    let spec = isoloom_core::load(dir).map_err(|e| Error::Invalid(format!("this lab's isoloom.yml: {e}")))?;
    let problems: Vec<String> = isoloom_core::validate(&spec).into_iter().chain(isoloom_core::validate_files(&spec, dir)).map(|p| p.to_string()).collect();
    if !problems.is_empty() {
        return Err(Error::Invalid(format!("this lab's isoloom.yml has mistakes:\n{}", problems.join("\n"))));
    }
    Ok(spec)
}

/// Generates `target`'s files into the lab (overwriting the previous ones), and returns the
/// spec. Fails with Isoloom's own reason when the lab can't run there (e.g. Windows machines
/// on a target without Windows images).
pub fn prepare(dir: &Path, target: Target) -> Result<Spec> {
    let spec = spec(dir)?;
    let files = isoloom_core::generate(&spec, target).map_err(|e| Error::Invalid(format!("this lab can't run there: {e}")))?;
    for f in files {
        let path = dir.join(&f.path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, f.contents)?;
    }
    Ok(spec)
}

/// Each machine's lab interfaces and the lab's networks, from Isoloom's resolved snapshot of
/// the spec: addresses are static (declared in the lab), so the diagram of a VM lab comes from
/// here, without reaching into the guests or reading the generated files.
pub fn topology(spec: &Spec) -> (HashMap<String, Vec<Interface>>, Vec<Network>) {
    let snapshot = isoloom_core::resolved::resolve(spec);
    let networks: Vec<Network> = snapshot["networks"]
        .as_object()
        .map(|nets| {
            nets.iter()
                .map(|(name, n)| Network {
                    name: name.clone(),
                    subnet: n["cidr"].as_str().unwrap_or_default().to_string(),
                    // No internet declared: its machines have no route out.
                    internal: !n["internet"].as_bool().unwrap_or(true),
                })
                .collect()
        })
        .unwrap_or_default();
    let mut ifaces: HashMap<String, Vec<Interface>> = HashMap::new();
    if let Some(machines) = snapshot["machines"].as_object() {
        for (name, m) in machines {
            let list: Vec<Interface> = m["addresses"]
                .as_object()
                .map(|a| a.iter().filter_map(|(net, ip)| ip.as_str().map(|ip| Interface { network: net.clone(), ip: ip.to_string() })).collect())
                .unwrap_or_default();
            ifaces.insert(name.clone(), list);
        }
    }
    (ifaces, networks)
}

/// The lab's `message:` (where to start, the first step) with its placeholders filled from
/// the resolved spec; shown once the lab is up. None when the lab has none, or it names a
/// value the spec doesn't have (the lab's own mistake, not worth failing a launch over).
pub fn message(spec: &Spec) -> Option<String> {
    isoloom_core::resolved::render_message(spec, None).ok().flatten().map(|m| m.trim_end().to_string())
}

/// The lab's Compose file (local Docker, and inside "Docker on one VM").
pub const COMPOSE_FILE: &str = ".isoloom/docker/compose.yml";

/// The Compose file's service running the lab's checks (profile `check`).
pub const CHECK_SERVICE: &str = "isoloom-check";

/// Where the Vagrantfile of a local or ESXi run is: Docker on one VM for container labs, one
/// VM per machine for VM labs.
pub fn vagrant_dir(dir: &Path, runtime: Runtime) -> PathBuf {
    match runtime {
        Runtime::Docker => dir.join(".isoloom/docker-vm"),
        Runtime::Vm => dir.join(".isoloom/vagrant"),
    }
}

/// The Isoloom target of a Vagrant run.
pub fn vagrant_target(runtime: Runtime) -> Target {
    match runtime {
        Runtime::Docker => Target::DockerVm,
        Runtime::Vm => Target::Vagrant,
    }
}

/// The Terraform module and its Isoloom target for a server or cloud (`tf` is the launcher's
/// Terraform target: `proxmox`, `aws`, `azure`, `gcp`, `digitalocean`, `linode`, `oci`).
pub fn terraform(dir: &Path, runtime: Runtime, tf: &str) -> Result<(PathBuf, Target)> {
    Ok(match (runtime, tf) {
        (Runtime::Docker, "proxmox") => (dir.join(".isoloom/docker-vm/proxmox"), Target::DockerVm),
        (Runtime::Vm, "proxmox") => (dir.join(".isoloom/proxmox"), Target::Proxmox),
        (Runtime::Docker, cloud) => (dir.join(".isoloom/cloud-docker").join(cloud), Target::CloudDocker),
        // Isoloom generates a cloud-vm module per cloud it can model the lab on; a cloud a lab
        // doesn't support has no module, and the run surfaces that when the directory is missing.
        (Runtime::Vm, cloud) => (dir.join(".isoloom/cloud-vm").join(cloud), Target::CloudVm),
    })
}

/// The module to destroy a lab's Terraform resources with: its Isoloom module, or, for a lab
/// started before labs moved to Isoloom (still installed at that commit), its old
/// `deploy/terraform/<target>` module, so those resources can still be removed.
pub fn terraform_to_destroy(dir: &Path, runtime: Runtime, tf: &str) -> Result<PathBuf> {
    let legacy = dir.join("deploy/terraform").join(tf);
    if !dir.join(".isoloom").is_dir() && legacy.is_dir() {
        return Ok(legacy);
    }
    Ok(terraform(dir, runtime, tf)?.0)
}

/// The lab's inputs found in `env`, as the JSON object Terraform's `inputs` variable takes.
pub fn inputs_json(spec: &Spec, env: &[(String, String)]) -> Option<String> {
    if spec.inputs.is_empty() {
        return None;
    }
    let map: serde_json::Map<String, serde_json::Value> =
        spec.inputs.iter().filter_map(|name| env.iter().find(|(k, _)| k == name).map(|(_, v)| (name.clone(), serde_json::Value::String(v.clone())))).collect();
    Some(serde_json::Value::Object(map).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPEC: &str = "version: 1\nname: t\nnetworks:\n  lab: { cidr: 10.30.0.0/24 }\ninputs: [CTF_LAUNCH_TOKEN]\nmachines:\n  web:\n    networks: { lab: 10 }\n    services: [{ port: 80, http: true }]\n    inputs: [CTF_LAUNCH_TOKEN]\n    docker: { image: nginx:1.27 }\n";

    fn lab(spec: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cyberctf-isoloom-{}", rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("isoloom.yml"), spec).unwrap();
        dir
    }

    #[test]
    fn generates_the_targets_files_into_the_lab() {
        let dir = lab(SPEC);
        prepare(&dir, Target::Docker).unwrap();
        let compose = std::fs::read_to_string(dir.join(COMPOSE_FILE)).unwrap();
        assert!(compose.contains("isoloom.service.80"));
        prepare(&dir, Target::CloudDocker).unwrap();
        assert!(dir.join(".isoloom/cloud-docker/aws/main.tf").is_file());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn explains_a_target_the_lab_cant_use() {
        let dir = lab(SPEC);
        // No `vm:` part: no VMs.
        let err = prepare(&dir, Target::Vagrant).unwrap_err().to_string();
        assert!(err.contains("can't run there"), "{err}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_a_broken_spec_with_its_problems() {
        let dir = lab("version: 1\nname: t\nmachines: {}\nbogus: 1\n");
        assert!(spec(&dir).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn passes_only_declared_inputs() {
        let dir = lab(SPEC);
        let spec = spec(&dir).unwrap();
        let env = vec![("CTF_LAUNCH_TOKEN".to_string(), "t0k".to_string()), ("OTHER".to_string(), "x".to_string())];
        assert_eq!(inputs_json(&spec, &env).unwrap(), r#"{"CTF_LAUNCH_TOKEN":"t0k"}"#);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn destroys_an_old_deploy_run_with_its_own_module() {
        let dir = std::env::temp_dir().join(format!("cyberctf-legacy-{}", rand::random::<u32>()));
        std::fs::create_dir_all(dir.join("deploy/terraform/azure")).unwrap();
        assert_eq!(terraform_to_destroy(&dir, Runtime::Docker, "azure").unwrap(), dir.join("deploy/terraform/azure"));
        std::fs::create_dir_all(dir.join(".isoloom")).unwrap();
        assert_eq!(terraform_to_destroy(&dir, Runtime::Docker, "azure").unwrap(), dir.join(".isoloom/cloud-docker/azure"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn vagrant_dir_and_target_differ_for_docker_and_vm() {
        let d = Path::new("/l");
        assert_eq!(vagrant_dir(d, Runtime::Docker), PathBuf::from("/l/.isoloom/docker-vm"));
        assert_eq!(vagrant_dir(d, Runtime::Vm), PathBuf::from("/l/.isoloom/vagrant"));
        assert_eq!(vagrant_target(Runtime::Docker), Target::DockerVm);
        assert_eq!(vagrant_target(Runtime::Vm), Target::Vagrant);
    }

    #[test]
    fn terraform_to_destroy_uses_isoloom_when_no_legacy_folder() {
        // A fresh lab with no deploy/terraform/<tf> falls through to the Isoloom module.
        let dir = std::env::temp_dir().join(format!("cyberctf-nolegacy-{}", rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(terraform_to_destroy(&dir, Runtime::Docker, "aws").unwrap(), dir.join(".isoloom/cloud-docker/aws"));
        // Even with .isoloom absent, a missing legacy folder still yields the Isoloom path.
        assert_eq!(terraform_to_destroy(&dir, Runtime::Vm, "proxmox").unwrap(), dir.join(".isoloom/proxmox"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn topology_and_message_come_from_the_resolved_spec() {
        let dir = lab(
            "version: 1\nname: t\nnetworks:\n  lab: { cidr: 10.30.0.0/24 }\n  back: { cidr: 10.31.0.0/24, internet: false }\nmachines:\n  web:\n    networks: { lab: 10, back: 10 }\n    services: [{ port: 80, http: true, publish: 8080 }]\n    docker: { image: nginx:1.27 }\n  db:\n    networks: { back: 20 }\n    docker: { image: redis:7 }\nmessage: |\n  Start at http://localhost:{{ machines.web.services.0.publish }}/ (web is {{ machines.web.addresses.lab }}).\n",
        );
        let spec = spec(&dir).unwrap();
        let (ifaces, networks) = topology(&spec);
        assert_eq!(
            networks.iter().map(|n| (n.name.as_str(), n.subnet.as_str(), n.internal)).collect::<Vec<_>>(),
            [("lab", "10.30.0.0/24", false), ("back", "10.31.0.0/24", true)]
        );
        assert_eq!(ifaces["web"].iter().map(|i| (i.network.as_str(), i.ip.as_str())).collect::<Vec<_>>(), [("lab", "10.30.0.10"), ("back", "10.31.0.10")]);
        assert_eq!(ifaces["db"].len(), 1);
        assert_eq!(message(&spec).as_deref(), Some("Start at http://localhost:8080/ (web is 10.30.0.10)."));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn inputs_json_is_none_when_the_spec_declares_no_inputs() {
        let dir = lab(
            "version: 1\nname: t\nnetworks:\n  lab: { cidr: 10.30.0.0/24 }\nmachines:\n  web:\n    networks: { lab: 10 }\n    services: [{ port: 80, http: true }]\n    docker: { image: nginx:1.27 }\n",
        );
        let spec = spec(&dir).unwrap();
        assert_eq!(inputs_json(&spec, &[("X".to_string(), "y".to_string())]), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn picks_the_module_for_each_run() {
        let d = Path::new("/l");
        assert_eq!(terraform(d, Runtime::Docker, "aws").unwrap(), (PathBuf::from("/l/.isoloom/cloud-docker/aws"), Target::CloudDocker));
        assert_eq!(terraform(d, Runtime::Docker, "proxmox").unwrap().0, PathBuf::from("/l/.isoloom/docker-vm/proxmox"));
        assert_eq!(terraform(d, Runtime::Vm, "proxmox").unwrap().1, Target::Proxmox);
        assert_eq!(terraform(d, Runtime::Vm, "aws").unwrap(), (PathBuf::from("/l/.isoloom/cloud-vm/aws"), Target::CloudVm));
        // Every cloud now has a cloud-vm module, not only AWS.
        assert_eq!(terraform(d, Runtime::Vm, "azure").unwrap(), (PathBuf::from("/l/.isoloom/cloud-vm/azure"), Target::CloudVm));
        assert_eq!(terraform(d, Runtime::Vm, "oci").unwrap(), (PathBuf::from("/l/.isoloom/cloud-vm/oci"), Target::CloudVm));
    }
}
