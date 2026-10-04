import { type CloudProvider, type ServerHostInput, type RemoteProvider } from "@/lib/tauri";

// The server setup flow, a step-by-step wizard shown in its own window (src/app/server-setup).
// Matches the "Set up this machine" wizard (components/machine/machine-setup.tsx).

export const KIND: Record<RemoteProvider, { label: string; note: string; port: number; user: string; plugin: string }> = {
  proxmox: { label: "Proxmox VE", note: "Signs in to the Proxmox API", port: 8006, user: "root@pam", plugin: "vagrant-proxmox" },
  vmware_esxi: { label: "VMware ESXi", note: "Drives the host over SSH", port: 22, user: "root", plugin: "vagrant-vmware-esxi" },
  aws: { label: "AWS", note: "EC2 in your own account", port: 443, user: "AKIA…", plugin: "" },
  azure: { label: "Azure", note: "VMs in your own subscription", port: 443, user: "subscription id", plugin: "" },
};

/** Server hypervisors, as opposed to cloud accounts. */
export const SERVER_KINDS: RemoteProvider[] = ["proxmox", "vmware_esxi"];

export const EMPTY_HOST: ServerHostInput = {
  id: null,
  name: "",
  provider: "proxmox",
  host: "",
  port: null,
  username: "",
  password: null,
  datastore: null,
  network: null,
  node: null,
  // Proxmox ships with a self-signed certificate.
  insecureTls: true,
  autoStopHours: null,
};

/** A new AWS account: region + access keys. */
export const EMPTY_CLOUD: ServerHostInput = { ...EMPTY_HOST, provider: "aws", host: "eu-west-3", useCliCreds: true, insecureTls: false, autoStopHours: 4 };

/** Common AWS regions for the cloud setup dropdown (code, human name). */
export const AWS_REGIONS: [string, string][] = [
  ["us-east-1", "US East (N. Virginia)"],
  ["us-east-2", "US East (Ohio)"],
  ["us-west-2", "US West (Oregon)"],
  ["eu-west-1", "Europe (Ireland)"],
  ["eu-west-3", "Europe (Paris)"],
  ["eu-central-1", "Europe (Frankfurt)"],
  ["ap-southeast-1", "Asia Pacific (Singapore)"],
  ["ap-northeast-1", "Asia Pacific (Tokyo)"],
];

/** Common Azure locations for the cloud setup dropdown (id, human name). */
export const AZURE_LOCATIONS: [string, string][] = [
  ["westeurope", "West Europe (Netherlands)"],
  ["northeurope", "North Europe (Ireland)"],
  ["francecentral", "France Central (Paris)"],
  ["uksouth", "UK South (London)"],
  ["germanywestcentral", "Germany West Central"],
  ["eastus", "East US (Virginia)"],
  ["westus2", "West US 2 (Washington)"],
  ["southeastasia", "Southeast Asia (Singapore)"],
];

export type StepKey = "provider" | "hypervisor" | "tools" | "connection" | "placement" | "account" | "credentials" | "options" | "connect" | "test";
/** Cloud providers offered in the cloud setup. AWS is the supported target; Azure and GCP
 *  connect via their CLI's own sign-in (no lab provisioning yet). */
export const CLOUD_META: Record<CloudProvider, { label: string; cli: string; color: string; ready: boolean }> = {
  aws: { label: "Amazon Web Services", cli: "aws", color: "#ff9900", ready: true },
  azure: { label: "Microsoft Azure", cli: "az", color: "#3b8eea", ready: true },
  gcp: { label: "Google Cloud", cli: "gcloud", color: "#34a853", ready: false },
};

/** The provider picker. Only AWS is a real target today; the rest are coming soon.
 *  `logo` marks the ones with an SVG in public/brands (others fall back to a cloud icon). */
export const CLOUD_PICKER: { id: string; label: string; ready: boolean; logo: boolean }[] = [
  { id: "aws", label: "Amazon Web Services", ready: true, logo: true },
  { id: "azure", label: "Microsoft Azure", ready: true, logo: true },
  { id: "gcp", label: "Google Cloud", ready: false, logo: true },
  { id: "digitalocean", label: "DigitalOcean", ready: false, logo: true },
  { id: "linode", label: "Linode", ready: false, logo: true },
  { id: "oracle", label: "Oracle Cloud", ready: false, logo: true },
];
