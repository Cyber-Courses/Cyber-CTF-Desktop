import { Channel, invoke } from "@tauri-apps/api/core";

/** The identity the host AWS CLI resolves from its default credentials, or null if none. */
/** The identity the AWS CLI resolves for a profile (or the default chain), or null. */
export const awsCliIdentity = (profile?: string) => invoke<string | null>("aws_cli_identity", { profile: profile ?? null });

/** AWS CLI profiles configured on this machine. */
export const awsProfiles = () => invoke<string[]>("aws_profiles");

/** An Azure subscription the signed-in account can use. */
export type AzureSubscription = { name: string; id: string; isDefault: boolean };

/** Subscriptions the signed-in Azure account can see (`az account list`). Empty if not signed in. */
export const azureSubscriptions = () => invoke<AzureSubscription[]>("azure_subscriptions");

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

/** This month's AWS spend so far (USD) from Cost Explorer, or null if unavailable. */
export const awsMonthToDateCost = (profile?: string) => invoke<number | null>("aws_month_to_date_cost", { profile: profile ?? null });

/** Browser sign-in for an AWS profile (or the default) via `aws login`, streaming output. */
export function awsLogin(profile: string | null, onLog: (line: string) => void) {
  const logs = new Channel<string>();
  logs.onmessage = onLog;
  return invoke<void>("aws_login", { profile, logs });
}

export type CloudProvider = "aws" | "azure" | "gcp";

/** Signs in to a cloud provider using its CLI's own auth (browser flow). */
export function cloudLogin(provider: CloudProvider, onLog: (line: string) => void) {
  const logs = new Channel<string>();
  logs.onmessage = onLog;
  return invoke<void>("cloud_login", { provider, logs });
}
