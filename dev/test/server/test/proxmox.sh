#!/bin/sh
# The launcher's Proxmox path: the lab's deploy/terraform/proxmox in the Terraform
# container, cloud-init + Ansible in the VM, then "Open shell" over SSH with a test key.
#   test/proxmox.sh             # PVE_HOST (default the test host 192.168.56.10), KEEP=1
#   test/proxmox.sh destroy
# NO_KVM=1 for a Proxmox host without nested virtualization (the VirtualBox test host on
# an Intel Mac): creates the VM stopped, then starts it in software emulation (slow).
set -eu
SERVER_TEST=$(cd "$(dirname "$0")/.." && pwd); . "$SERVER_TEST/lib.sh"
secret PVE_ROOT_PASSWORD
HOST=${PVE_HOST:-192.168.56.10}
LAB=$(lab_dir)
RUN="$STATE/runs/proxmox"; mkdir -p "$RUN"
rm -rf "$RUN/deploy"; cp -R "$LAB/deploy" "$RUN/"
[ -z "${NO_KVM:-}" ] || printf 'resource "proxmox_virtual_environment_vm" "labhost" {\n  started = false\n}\n' > "$RUN/deploy/terraform/proxmox/test_override.tf"
KEY=$(test_key)
tf() {
  docker run --rm --entrypoint sh -v "$RUN/deploy:/deploy" -v "$RUN:/state" -w /deploy/terraform/proxmox \
    -e TF_DATA_DIR=/state/.terraform \
    -e TF_VAR_proxmox_endpoint="https://$HOST:8006/" -e TF_VAR_proxmox_username=root@pam -e TF_VAR_proxmox_password="$PVE_ROOT_PASSWORD" \
    -e TF_VAR_proxmox_insecure=true -e TF_VAR_proxmox_ssh_address="$HOST" -e TF_VAR_proxmox_storage="${PVE_STORAGE:-local}" \
    -e TF_VAR_cpu_type="${PVE_CPU:-$([ -n "${NO_KVM:-}" ] && echo x86-64-v2-AES || echo host)}" \
    -e TF_VAR_lab_slug=invoice-portal-api -e TF_VAR_lab_repository=CyberCTF/invoice-portal-api -e TF_VAR_lab_commit="$(git -C "$LAB" rev-parse HEAD)" \
    -e TF_VAR_attackbox_image=debian:12-slim -e TF_VAR_ssh_public_key="$(cat "$KEY.pub")" \
    "$TERRAFORM_IMAGE" -c "terraform init -input=false -no-color -backend-config=path=/state/terraform.tfstate >/dev/null && terraform $1 -auto-approve -input=false -no-color"
}
if [ "${1:-apply}" = destroy ]; then tf destroy; exit; fi
tf apply
NODE="$SERVER_TEST/proxmox"   # the VirtualBox test host: commands on the node via vagrant ssh
VMID=$(docker run --rm -v "$RUN:/state" --entrypoint sh "$TERRAFORM_IMAGE" -c "grep -o '\"vm_id\": *[0-9]*' /state/terraform.tfstate | head -1 | grep -o '[0-9]*$'")
if [ -n "${NO_KVM:-}" ]; then (cd "$NODE" && vagrant ssh -c "sudo qm set $VMID --kvm 0 >/dev/null && sudo qm start $VMID"); fi
echo "Waiting for cloud-init + Ansible in VM $VMID..."
until (cd "$NODE" && vagrant ssh -c "sudo qm guest exec $VMID -- test -f /var/lib/cyberctf-lab-ready" 2>/dev/null) | grep -q '"exitcode" : 0'; do sleep 30; done
IP=$(cd "$NODE" && vagrant ssh -c "sudo qm guest cmd $VMID network-get-interfaces" 2>/dev/null | grep -o '"ip-address" : "10\.10\.10\.[0-9]*' | grep -o '10\.10\.10\.[0-9]*' | head -1)
echo "== Open shell (the launcher's ssh command) from the node -> debian@$IP"
(cd "$NODE" && vagrant upload "$KEY" /tmp/cyberctf-testkey >/dev/null && vagrant ssh -c "chmod 600 /tmp/cyberctf-testkey; ssh -i /tmp/cyberctf-testkey -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/kh -o LogLevel=ERROR debian@$IP \"sudo docker exec attacker sh -c 'echo SHELL-OK \\\$(hostname); getent hosts web database'\"; rm -f /tmp/cyberctf-testkey /tmp/kh")
[ -n "${KEEP:-}" ] || tf destroy
