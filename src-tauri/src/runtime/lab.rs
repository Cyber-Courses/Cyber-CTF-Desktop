//! A lab's Isoloom side: every lab describes itself with an `isoloom.yml` at its root, and the
//! launcher generates the files of the target it runs on under the lab's `.isoloom/` (Compose,
//! Vagrant, Terraform) right before running them. Nothing is read from the lab besides the
//! spec and the files it names, so a lab is portable to every target Isoloom supports.

use std::path::{Path, PathBuf};

use isoloom_core::{Spec, Target};

use super::Runtime;
use crate::error::{Error, Result};

/// The lab's spec, checked (fields and the files it names).
pub fn spec(dir: &Path) -> Result<Spec> {
    let spec = isoloom_core::load(dir).map_err(|e| Error::Invalid(format!("this lab's isoloom.yml: {e}")))?;
    let problems: Vec<String> =
        isoloom_core::validate(&spec).into_iter().chain(isoloom_core::validate_files(&spec, dir)).map(|p| p.to_string()).collect();
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
        (Runtime::Vm, _) => return Err(Error::Invalid("VM labs can't run in the cloud yet: run them on this machine, an ESXi host or Proxmox.".into())),
    })
}

/// The lab's inputs found in `env`, as the JSON object Terraform's `inputs` variable takes.
pub fn inputs_json(spec: &Spec, env: &[(String, String)]) -> Option<String> {
    if spec.inputs.is_empty() {
        return None;
    }
    let map: serde_json::Map<String, serde_json::Value> = spec
        .inputs
        .iter()
        .filter_map(|name| env.iter().find(|(k, _)| k == name).map(|(_, v)| (name.clone(), serde_json::Value::String(v.clone()))))
        .collect();
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
    fn picks_the_module_for_each_run() {
        let d = Path::new("/l");
        assert_eq!(terraform(d, Runtime::Docker, "aws").unwrap(), (PathBuf::from("/l/.isoloom/cloud-docker/aws"), Target::CloudDocker));
        assert_eq!(terraform(d, Runtime::Docker, "proxmox").unwrap().0, PathBuf::from("/l/.isoloom/docker-vm/proxmox"));
        assert_eq!(terraform(d, Runtime::Vm, "proxmox").unwrap().1, Target::Proxmox);
        assert!(terraform(d, Runtime::Vm, "aws").is_err());
    }
}
