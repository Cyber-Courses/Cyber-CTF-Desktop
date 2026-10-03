# Home lab: VM labs on your own ESXi / Proxmox

The launcher can run a lab on the player's own hypervisor instead of this machine.
Hosts are added in the **Home lab** setup window; a lab's **Run on** choice picks the
host. VM labs launched from the website use the **default** host; Docker labs run here
unless a host is picked.

## Where things live

- Host profiles (non-secret): `<app data>/homelab.json`.
- Passwords: OS keychain, service `org.cyberctf.desktop`, account `homelab:<host id>`.
  Debug builds use `~/.cyberctf/dev-homelab-secrets.json` (0600) instead, as with the auth session.
- A lab started on a host gets `<lab dir>/.cyberctf-host` (the host id), so stop and
  status reach the same host. It survives a reinstall of the lab at a new commit.
- Terraform state: `<app data>/deployments/<lab id>/<target>/` (outside the lab folder).

Backend: `src-tauri/src/runtime/homelab.rs`. Commands: `homelab_list`, `homelab_save`,
`homelab_remove`, `homelab_set_default`, `homelab_test`, `homelab_open_setup`.

## How a lab reaches a host

Every lab comes from the **Lab-Template** (`Cyber-Courses/Lab-Template`): its
`docker-compose.yml` is the lab, and its `deploy/` layer runs that compose file on a
Debian "lab host" VM, configured by `deploy/ansible/site.yml` **inside** the VM.

| Lab | Host | Launcher runs |
| --- | --- | --- |
| Docker | ESXi | `vagrant up --provider vmware_esxi` in `deploy/vagrant` |
| Docker | Proxmox | `terraform apply` in `deploy/terraform/proxmox`, in the `hashicorp/terraform:1.16.5` container |
| VM (own Vagrantfile) | ESXi | `vagrant up --provider vmware_esxi` at the lab root |
| VM (own Vagrantfile) | Proxmox | not supported (no working Vagrant provider) |

Lab services have no host ports: the player attacks from the attack box, which the
launcher starts next to the lab on the lab host (`attackbox_image`, the Settings image).

### Vagrant (ESXi): environment

| Variable | Value |
| --- | --- |
| `CYBERCTF_REMOTE_PROVIDER`, `CYBERCTF_REMOTE_HOST` | `vmware_esxi`, hostname / IP |
| `CYBERCTF_ESXI_HOSTNAME`, `CYBERCTF_ESXI_HOSTPORT` | host, SSH port (22) |
| `CYBERCTF_ESXI_USERNAME`, `CYBERCTF_ESXI_PASSWORD` | e.g. `root`, password |
| `CYBERCTF_ESXI_DISK_STORE`, `CYBERCTF_ESXI_VIRTUAL_NETWORK` | optional datastore, port group |
| `CTF_API_URL`, `CTF_LAUNCH_TOKEN`, `CYBERCTF_ATTACKBOX_IMAGE` | evidence claim, attack box |

The Vagrantfile uses `esxi.esxi_password = "env:CYBERCTF_ESXI_PASSWORD"`.

### Terraform (Proxmox): `TF_VAR_*`, passed through the container environment

`proxmox_endpoint` (`https://host:8006/`), `proxmox_username` (`root@pam`),
`proxmox_password`, `proxmox_insecure` (the host's "Self-signed certificate" setting),
`proxmox_ssh_address` (the host as entered), `proxmox_node`, `proxmox_storage`,
`proxmox_bridge`; plus `lab_slug`, `lab_repository`, `lab_commit` (recorded at install),
`ctf_api_url`, `ctf_launch_token`, `attackbox_image`. The VM fetches the lab from GitHub
at that commit, so lab repositories must be public.

## Test

`homelab_test` checks the host without running anything on it:

- **ESXi**: TCP connect + SSH banner on the SSH port. The password is checked on first start.
- **Proxmox**: `POST /api2/json/access/ticket`, which verifies the credentials (accepting a
  self-signed certificate when the host is set to).

## Requirements on the host

- **ESXi**: SSH enabled; VMware `ovftool` on the launcher machine (vagrant-vmware-esxi).
- **Proxmox**: root SSH with the password (stock Proxmox allows it; Terraform uploads the
  cloud-init snippet over SSH), `snippets` + `iso` content on the `local` storage, a bridge
  with DHCP for the lab VM, KVM available (nested virtualization if Proxmox is itself a VM).

## Verified (2026-10-03)

- Lab host on a local VirtualBox VM via `deploy/vagrant` (Supplier Portal API): compose up,
  evidence claimed and placed, the attack box reads the invoice.
- `vagrant-vmware-esxi` 2.5.5 installs on Vagrant 2.4.9. `vagrant-proxmox` 0.0.10 (2016) does
  not (activesupport 4.0 vs Vagrant's i18n 1.14.7), hence Terraform for Proxmox.
- Terraform on a test Proxmox VE 8 (`dev/homelab-test/proxmox`), end to end: image download,
  snippet upload over SSH, VM, cloud-init, Ansible, compose healthy, the attack box reads the
  invoice; `destroy` removes VM, snippet and image. The test host has no nested KVM (VirtualBox
  on this Intel Mac), so the lab VM ran with `kvm: 0` and `cpu_type = x86-64-v2-AES` (plain
  `qemu64` lacks x86-64-v2, which `mysql:8.0` needs), slowly.
