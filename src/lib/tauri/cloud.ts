import { Channel, invoke } from "@tauri-apps/api/core";

/** The identity the host AWS CLI resolves from its default credentials, or null if none. */
/** The identity the AWS CLI resolves for a profile (or the default chain), or null. */
export const awsCliIdentity = (profile?: string) => invoke<string | null>("aws_cli_identity", { profile: profile ?? null });

/** AWS CLI profiles configured on this machine. */
export const awsProfiles = () => invoke<string[]>("aws_profiles");

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
