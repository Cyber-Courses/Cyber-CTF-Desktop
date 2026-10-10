import { invoke } from "@tauri-apps/api/core";
import { invokeStreaming } from "@/lib/tauri/stream";

export type CloudProvider = "aws" | "azure" | "gcp" | "digitalocean" | "linode" | "oci";

/** Signs in to a cloud provider using its CLI's own auth (browser flow). */
export const cloudLogin = (provider: CloudProvider, onLog: (line: string) => void) => invokeStreaming("cloud_login", { provider }, onLog);

// --- AWS ---

/** The identity the AWS CLI resolves for a profile (or the default chain), or null. */
export const awsCliIdentity = (profile?: string) => invoke<string | null>("aws_cli_identity", { profile: profile ?? null });

/** AWS CLI profiles configured on this machine. */
export const awsProfiles = () => invoke<string[]>("aws_profiles");

/** This month's AWS spend so far (USD) from Cost Explorer, or null if unavailable. */
export const awsMonthToDateCost = (profile?: string) => invoke<number | null>("aws_month_to_date_cost", { profile: profile ?? null });

/** Browser sign-in for an AWS profile (or the default) via `aws login`, streaming output. */
export const awsLogin = (profile: string | null, onLog: (line: string) => void) => invokeStreaming("aws_login", { profile }, onLog);

// --- Azure ---

/** An Azure subscription the signed-in account can use. */
export type AzureSubscription = { name: string; id: string; isDefault: boolean };

/** Subscriptions the signed-in Azure account can see (`az account list`). Empty if not signed in. */
export const azureSubscriptions = () => invoke<AzureSubscription[]>("azure_subscriptions");

// --- Google Cloud ---

/** A GCP billing account the signed-in user can see. */
export type GcpBillingAccount = { id: string; name: string; open: boolean };

/** A GCP organization the signed-in user belongs to. */
export type GcpOrganization = { id: string; name: string };

/** The active gcloud account email, or null if the CLI isn't signed in. */
export const gcpAccount = () => invoke<string | null>("gcp_account");

/** Billing accounts the signed-in GCP user can see (for the per-lab projects). */
export const gcpBillingAccounts = () => invoke<GcpBillingAccount[]>("gcp_billing_accounts");

/** Organizations the signed-in GCP user belongs to (empty = personal / no-org account). */
export const gcpOrganizations = () => invoke<GcpOrganization[]>("gcp_organizations");

// --- Oracle Cloud ---

/** What the launcher found in ~/.oci/config, to prefill the OCI setup. */
export type OciConfig = { configured: boolean; tenancy: string; region: string };

/** Reads ~/.oci/config (DEFAULT profile) for the OCI setup prefill. */
export const ociConfig = () => invoke<OciConfig>("oci_config");
