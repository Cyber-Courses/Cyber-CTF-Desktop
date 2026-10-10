
variable "proxmox_endpoint" { type = string }
variable "proxmox_username" { type = string }
variable "proxmox_password" {
  type      = string
  default   = ""
  sensitive = true
}
variable "proxmox_api_token" {
  type      = string
  default   = ""
  sensitive = true
}
variable "proxmox_ssh_username" {
  type    = string
  default = ""
}
variable "proxmox_ssh_private_key_file" {
  type    = string
  default = ""
}
variable "proxmox_insecure" {
  type    = bool
  default = false
}
variable "proxmox_ssh_address" {
  type    = string
  default = ""
}
variable "node" {
  type    = string
  default = "pve"
}
variable "datastore" {
  type    = string
  default = "local-lvm"
}
variable "image_datastore" {
  type    = string
  default = "local"
}
variable "snippets_datastore" {
  type    = string
  default = "local"
}
variable "uplink_bridge" {
  type    = string
  default = "vmbr0"
}
variable "ssh_public_key" {
  type    = string
  default = ""
}
variable "cpu_type" {
  type    = string
  default = "host"
}
variable "cores" {
  type    = number
  default = 1
}
variable "memory_mb" {
  type    = number
  default = 1536
}
variable "disk_gb" {
  type    = number
  default = 4
}
