//! The lab status model: what a running lab looks like to the UI. Shared by every runtime
//! (Docker, VM, Terraform), kept apart from the command surface so adding a field here
//! doesn't touch command registration or dispatch.

use serde::Serialize;

/// A port the software inside a container binds: `target` is the port inside the
/// container, `published` is where it is reachable on 127.0.0.1 (0 = not published).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Port {
    pub published: u16,
    pub target: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    /// The container (a small computer on the lab network).
    pub name: String,
    pub state: String,
    /// The image = the software running inside the container, e.g. "mysql:8.0".
    #[serde(default)]
    pub image: String,
    /// The container's address on the lab network, e.g. "172.20.0.4" (empty if unknown).
    #[serde(default)]
    pub ip: String,
    /// Ports the software inside it binds (for the network diagram).
    #[serde(default)]
    pub ports: Vec<Port>,
    /// Every network the machine is plugged into, with its address there. A machine on
    /// two networks is a pivot (dual-homed); empty when the runtime can't tell.
    #[serde(default)]
    pub interfaces: Vec<Interface>,
    /// The services running inside, as the lab declares them (compose labels
    /// `cyberctf.service.<name>: "<kind>:<port>,<port>"`). A container may run several;
    /// empty when the lab declares none (never inferred).
    #[serde(default)]
    pub services: Vec<Service>,
}

/// One service inside a machine, as declared by the lab.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    /// The lab's name for it, e.g. "portal", "ssh".
    pub name: String,
    /// What it is, as declared: "web", "database", "cache", "worker", "ssh" or free text.
    pub kind: String,
    /// The ports it listens on inside the container.
    pub ports: Vec<u16>,
}

/// One network interface of a machine: the lab network it sits on and its address there.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Interface {
    /// The lab's own name for the network (the compose key, e.g. "dmz"), not Docker's.
    pub network: String,
    pub ip: String,
}

/// A network segment of the lab (a Docker network = a switch the machines plug into).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    /// The lab's own name for it (the compose key), e.g. "default", "dmz", "internal".
    pub name: String,
    /// CIDR, e.g. "172.20.0.0/16" (empty if Docker didn't report one).
    pub subnet: String,
    /// No route out (compose `internal: true`): its machines can't reach the internet.
    pub internal: bool,
}

/// Where a lab runs, for the UI: its own runtime here, a VM here, a server, or a cloud account.
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum Place {
    Container,
    LocalVm,
    Server,
    Cloud,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabStatus {
    pub running: bool,
    pub machines: Vec<Machine>,
    /// The lab's network segments (Docker labs); empty when the runtime doesn't report them.
    pub networks: Vec<Network>,
    /// Loopback URL where the lab is reachable on this machine, once running (Docker labs
    /// with a published port). None for VM labs or when nothing is published yet.
    pub url: Option<String>,
    /// Name of the server host a VM lab runs on; None when it runs on this machine.
    pub host: Option<String>,
    /// Unix time a cloud lab stops itself (auto-stop), if it does.
    pub expires_at: Option<u64>,
    /// Where it runs; set by the runtime dispatcher (None from the per-runtime probes).
    pub place: Option<Place>,
    /// The engine or hypervisor it runs on: "docker", or a Vagrant provider id ("virtualbox",
    /// "vmware_desktop", "parallels", ...), or a server/cloud provider. "On this machine" alone
    /// is misleading for a VM lab: this says which hypervisor to look in.
    pub provider: Option<String>,
}
