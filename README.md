# Cyber CTF Desktop

Desktop launcher for Cyber CTF labs, built with [Tauri 2](https://tauri.app). It runs **Docker labs** (Docker Compose) and **VM labs** (Vagrant, on any supported hypervisor) on the player's machine. Replaces the Electron [Cyber-CTF-Launcher](https://github.com/Cyber-Courses/Cyber-CTF-Launcher).

## Architecture

- **UI:** Next.js as a **static export** (`output: "export"`) served by Tauri. There is no Next server, so no API routes, SSR or middleware. The UI only calls typed Rust commands ([`src/lib/tauri/`](src/lib/tauri/), one module per area).
  - [`src/features/`](src/features/): one folder per page with its parts and hooks: `labs` (catalogue, lab page, deployment steps, network diagram), `machine` (Machine page and the setup steps), `servers`, `cloud`, `settings`, `home`, `hosted`, `onboarding`, `account`.
  - [`src/components/ui/`](src/components/ui/): shared building blocks (Button, Panel, RadioRow, Segmented, ChoiceCard, StatusPill, LogConsole…); [`src/components/`](src/components/) holds the app shell.
  - [`src/lib/`](src/lib/): data access ([`tauri/`](src/lib/tauri/)), per-machine settings, formatting ([`format.ts`](src/lib/format.ts)) and small helpers.
- **Core (Rust, [`src-tauri/`](src-tauri/)):** everything privileged. Processes are spawned without a shell, lab ids are validated, and the UI never passes paths or command lines.
  - [`account/`](src-tauri/src/account/): Cyber Auth sign-in (`auth.rs`: authorization code + PKCE through the system browser, loopback redirect on `127.0.0.1:47290-47292/callback`; tokens in the OS keychain, refreshed automatically, never in the webview), CyberBackend GraphQL with the token attached on the Rust side (`api.rs`), and the agent that links the launcher to the website (`agent.rs`, `colocation.rs`).
  - [`labs.rs`](src-tauri/src/labs.rs): `lab_launch` calls `startLab`, then downloads `CyberCTF/*` at the pinned commit (full SHA only; archive paths checked), and starts the lab with `CTF_API_URL` and `CTF_LAUNCH_TOKEN`. The lab's `evidence` service exchanges the token for this player's evidence.
  - [`machine/`](src-tauri/src/machine/): what this machine can run (`system.rs`: Docker engines, Vagrant, hypervisors, package manager), the setup self-tests (`selftest.rs`) and the workloads/storage the Machine page shows (`workloads.rs`).
  - [`platform/`](src-tauri/src/platform/): the PATH a GUI launch is missing (`env_path.rs`) and one-click dependency installs (`install.rs`).
  - [`runtime/`](src-tauri/src/runtime/): lab lifecycle, with logs streamed to the UI over a Tauri channel
    - `docker/`: `docker compose -p cyberctf-<lab>`; stop removes volumes, so every start is a clean lab; status reports machines, interfaces, networks and declared services
    - `vm.rs`: `vagrant up --provider <p>`; stop destroys the VMs
    - `server.rs`, `proxmox.rs`, `terraform.rs`: labs on the player's own servers (ESXi, Proxmox) and cloud accounts
    - `providers.rs`: Vagrant providers. Local: VirtualBox, VMware Desktop, Hyper-V, Parallels, libvirt, QEMU, UTM. Remote: VMware ESXi, Proxmox.
  - `cloud.rs`, `provisioning.rs`: cloud CLIs and the Terraform/Ansible tooling; `exec.rs`, `error.rs`, `config.rs`: crate-wide basics.

The runtime layer knows nothing about CTFs: a lab is a directory with a `docker-compose.yml` or a `Vagrantfile`.

Labs live in `<app data>/labs/<lab id>/`.

### Platform notes

A VM lab runs natively only where its boxes exist for the host architecture. On Apple Silicon, ARM boxes run natively on UTM/QEMU (Apple Hypervisor). x86-only boxes such as pfSense run there only under QEMU emulation, which is several times slower; heavy x86 labs should use a remote x86 host (ESXi, Proxmox).

## Roadmap

- [x] System check, Docker/VM runtimes, provider detection
- [x] Login: system browser + PKCE against cyberauth.co, loopback redirect, tokens in the OS keychain
- [x] Lab catalogue from [CyberBackend](https://github.com/Cyber-Courses/CyberBackend); launch = `startLab`, download at the pinned commit, run with the launch token
- [x] Servers (ESXi/Proxmox, credentials in the keychain) and cloud accounts (AWS)
- [x] Attack box on the lab network (Cyber CTF image on Docker Hub, built by the attack-box workflow)
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

## Design

The UI follows the Cyber family design system, "Lit from within", at app density: tokens, modes
(Dark, Black, Light), primitives and patterns are documented in [`docs/DESIGN.md`](docs/DESIGN.md).
To preview the UI in a browser without the Rust core, run `pnpm dev` and open
`http://localhost:3000/?mock` (sample data, development builds only).

## Development

Requirements: Node 22+, pnpm, Rust (stable), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
pnpm install
pnpm tauri dev          # app with hot reload
pnpm tauri build        # installers in src-tauri/target/release/bundle
pnpm format             # Prettier (src/) + rustfmt (src-tauri/)
pnpm check              # formatting, types, lint, clippy
cd src-tauri && cargo test
cargo test -- --ignored --nocapture   # prints this machine's system report
```
