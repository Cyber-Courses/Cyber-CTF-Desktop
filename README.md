# CyberCTF Desktop

Desktop launcher for CyberCTF labs, built with [Tauri 2](https://tauri.app). It runs **Docker labs** (Docker Compose) and **VM labs** (Vagrant, on any supported hypervisor) on the player's machine. Replaces the Electron [Cyber-CTF-Launcher](https://github.com/Cyber-Courses/Cyber-CTF-Launcher).

## Architecture

- **UI:** Next.js as a **static export** (`output: "export"`) served by Tauri. There is no Next server, so no API routes, SSR or middleware. The UI only calls typed Rust commands ([`src/lib/tauri.ts`](src/lib/tauri.ts)).
- **Core (Rust, [`src-tauri/`](src-tauri/)):** everything privileged. Processes are spawned without a shell, lab ids are validated, and the UI never passes paths or command lines.
  - [`auth.rs`](src-tauri/src/auth.rs): OAuth authorization code + PKCE through the system browser, loopback redirect on `127.0.0.1:47290-47292/callback` (cyber-auth matches redirect URIs exactly, so the ports are fixed). Tokens are stored in the OS keychain and refreshed automatically; they never reach the webview.
  - [`api.rs`](src-tauri/src/api.rs): CyberBackend GraphQL, with the token attached on the Rust side
  - [`labs.rs`](src-tauri/src/labs.rs): `lab_launch` calls `startLab`, then downloads `CyberCTF/*` at the pinned commit (full SHA only; archive paths checked), and starts the lab with `CTF_API_URL` and `CTF_LAUNCH_TOKEN`. The lab's `evidence` service exchanges the token for this player's evidence.
  - [`system.rs`](src-tauri/src/system.rs): what this machine can run (Docker, Compose, Vagrant, VM providers)
  - [`runtime/`](src-tauri/src/runtime/): lab lifecycle, with logs streamed to the UI over a Tauri channel
    - `docker.rs`: `docker compose -p cyberctf-<lab>`; stop removes volumes, so every start is a clean lab
    - `vm.rs`: `vagrant up --provider <p>`; stop destroys the VMs
    - `providers.rs`: Vagrant providers. Local: VirtualBox, VMware Desktop, Hyper-V, Parallels, libvirt, QEMU, UTM. Remote: VMware ESXi, Proxmox.

The runtime layer knows nothing about CTFs: a lab is a directory with a `docker-compose.yml` or a `Vagrantfile`. This keeps it reusable for a future home-lab launcher.

Labs live in `<app data>/labs/<lab id>/`.

### Platform notes

A VM lab runs natively only where its boxes exist for the host architecture. On Apple Silicon, ARM boxes run natively on UTM/QEMU (Apple Hypervisor). x86-only boxes such as pfSense run there only under QEMU emulation, which is several times slower; heavy x86 labs should use a remote x86 host (ESXi, Proxmox).

## Roadmap

- [x] System check, Docker/VM runtimes, provider detection
- [x] Login: system browser + PKCE against cyberauth.co, loopback redirect, tokens in the OS keychain
- [x] Lab catalogue from [CyberBackend](https://github.com/Cyber-Courses/CyberBackend); launch = `startLab`, download at the pinned commit, run with the launch token
- [ ] Remote provider settings (ESXi/Proxmox host + credentials in the keychain)
- [ ] Exegol attacker box on the lab network
- [ ] VM lab provisioning (Ansible runner), replacing the PowerShell scripts of Lab-Starter-Pack-VM
- [ ] Signed builds + auto-update (GitHub Releases)

## Configuration

Production endpoints are built in ([`config.rs`](src-tauri/src/config.rs)). Each can be overridden at build or run time, e.g. to test against a local cyber-auth:

| Variable | Default |
|----------|---------|
| `CYBERCTF_AUTH_BASE` | `https://www.cyberauth.co/api/auth` |
| `CYBERBACKEND_URL` | `https://cyberbackend.com` (also the token audience) |
| `CYBERCTF_CLIENT_ID` | `cyberctf-desktop` |

The OAuth client in cyber-auth must be public (`token_endpoint_auth_method: none`), use the `authorization_code` and `refresh_token` grants, and have these redirect URIs: `http://127.0.0.1:47290/callback`, `http://127.0.0.1:47291/callback`, `http://127.0.0.1:47292/callback`.

## Development

Requirements: Node 22+, pnpm, Rust (stable), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
pnpm install
pnpm tauri dev          # app with hot reload
pnpm tauri build        # installers in src-tauri/target/release/bundle
cd src-tauri && cargo test
cargo test -- --ignored --nocapture   # prints this machine's system report
```
