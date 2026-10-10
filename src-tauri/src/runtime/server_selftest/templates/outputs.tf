
output "ssh_user" { value = "debian" }
output "vm_id" { value = proxmox_virtual_environment_vm.labhost.vm_id }
output "ip" {
  value = try([for ip in flatten(proxmox_virtual_environment_vm.labhost.ipv4_addresses) : ip if ip != "127.0.0.1"][0], null)
}
