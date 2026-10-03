# Home lab: VM labs on your own ESXi / Proxmox

The launcher can run a VM lab on the player's own hypervisor instead of this machine.
Hosts are managed on the **Home lab** screen; a VM lab's **Run on** choice picks the
host. Labs launched from the website use the **default** host.

## Where things live

- Host profiles (non-secret): `<app data>/homelab.json`.
- Passwords: OS keychain, service `org.cyberctf.desktop`, account `homelab:<host id>`.
  Debug builds use `~/.cyberctf/dev-homelab-secrets.json` (0600) instead, as with the auth session.
- A VM lab started on a host gets `<lab dir>/.cyberctf-host` (the host id), so
  `vagrant destroy` / `vagrant status` get the same connection.

Backend: `src-tauri/src/runtime/homelab.rs`. Commands: `homelab_list`, `homelab_save`,
`homelab_remove`, `homelab_set_default`, `homelab_test`.

## The Vagrantfile contract

Neither `vagrant-vmware-esxi` nor `vagrant-proxmox` reads environment variables on its own.
The launcher runs `vagrant up --provider <vmware_esxi|proxmox>` with the variables below,
and **the lab's Vagrantfile maps them** onto the provider config. A lab that supports a
home lab lists `vmware_esxi` and/or `proxmox` in its runtime `providers`.

| Variable | Set for | Value |
| --- | --- | --- |
| `CYBERCTF_REMOTE_PROVIDER` | both | `vmware_esxi` or `proxmox` |
| `CYBERCTF_REMOTE_HOST` | both | hostname / IP |
| `CYBERCTF_ESXI_HOSTNAME` | ESXi | hostname / IP |
| `CYBERCTF_ESXI_HOSTPORT` | ESXi | SSH port (default 22) |
| `CYBERCTF_ESXI_USERNAME` | ESXi | e.g. `root` |
| `CYBERCTF_ESXI_PASSWORD` | ESXi | password |
| `CYBERCTF_ESXI_DISK_STORE` | ESXi, optional | datastore |
| `CYBERCTF_ESXI_VIRTUAL_NETWORK` | ESXi, optional | port group |
| `CYBERCTF_PROXMOX_ENDPOINT` | Proxmox | `https://<host>:<port>/api2/json` (port default 8006) |
| `CYBERCTF_PROXMOX_USER_NAME` | Proxmox | `user@realm`, e.g. `root@pam` |
| `CYBERCTF_PROXMOX_PASSWORD` | Proxmox | password |
| `CYBERCTF_PROXMOX_NODE` | Proxmox, optional | node name |
| `CYBERCTF_PROXMOX_STORAGE` | Proxmox, optional | storage for disks |
| `CYBERCTF_PROXMOX_BRIDGE` | Proxmox, optional | bridge for NICs |

`CTF_API_URL` / `CTF_LAUNCH_TOKEN` are passed as for every lab.

```ruby
config.vm.provider :vmware_esxi do |esxi|
  esxi.esxi_hostname = ENV["CYBERCTF_ESXI_HOSTNAME"]
  esxi.esxi_hostport = Integer(ENV.fetch("CYBERCTF_ESXI_HOSTPORT", "22"))
  esxi.esxi_username = ENV.fetch("CYBERCTF_ESXI_USERNAME", "root")
  # The plugin reads the secret from the environment itself.
  esxi.esxi_password = "env:CYBERCTF_ESXI_PASSWORD"
  esxi.esxi_disk_store = ENV["CYBERCTF_ESXI_DISK_STORE"] if ENV["CYBERCTF_ESXI_DISK_STORE"]
  esxi.esxi_virtual_network = ENV["CYBERCTF_ESXI_VIRTUAL_NETWORK"] if ENV["CYBERCTF_ESXI_VIRTUAL_NETWORK"]
end

config.vm.provider :proxmox do |pve|
  pve.endpoint  = ENV["CYBERCTF_PROXMOX_ENDPOINT"]
  pve.user_name = ENV["CYBERCTF_PROXMOX_USER_NAME"]
  pve.password  = ENV["CYBERCTF_PROXMOX_PASSWORD"]
  pve.selected_node = ENV["CYBERCTF_PROXMOX_NODE"] if ENV["CYBERCTF_PROXMOX_NODE"]
  pve.qemu_storage  = ENV["CYBERCTF_PROXMOX_STORAGE"] if ENV["CYBERCTF_PROXMOX_STORAGE"]
  pve.qemu_bridge   = ENV["CYBERCTF_PROXMOX_BRIDGE"] if ENV["CYBERCTF_PROXMOX_BRIDGE"]
  pve.vm_type = :qemu
  # Lab-specific: template / ISO, vm_id_range, cores, memory, disk size.
end
```

## Test

`homelab_test` checks the host without running Vagrant:

- **ESXi**: TCP connect + SSH banner on the SSH port. The password is only checked by Vagrant on first start.
- **Proxmox**: `POST /api2/json/access/ticket`, which verifies the credentials. An untrusted
  (self-signed) certificate is reported, since Vagrant will reject it too.

## Status by hypervisor

- **ESXi: works through Vagrant.** `vagrant-vmware-esxi` 2.5.5 installs on Vagrant 2.4.9 (verified
  2026-10-03). It needs SSH enabled on ESXi and VMware `ovftool` on the launcher machine.
  `esxi_virtual_network` accepts an array for multi-NIC labs; the env carries one network.
- **Proxmox: hosts can be saved and tested, labs can't run yet.** `vagrant-proxmox` (0.0.10, 2016) is
  the only Vagrant provider and it **does not install** on Vagrant 2.4.9 / Ruby 3.3 (verified
  2026-10-03: `activesupport ~> 4.0.0` needs `i18n ~> 0.6`, Vagrant pins `i18n 1.14.7`). The launcher
  refuses Proxmox launches with a clear message. Proxmox needs its own driver (native API or
  Terraform `bpg/proxmox`); the host store, keychain secret and Run on picker stay as they are.
