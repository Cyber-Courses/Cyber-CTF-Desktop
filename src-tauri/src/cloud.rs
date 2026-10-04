//! Cloud account connection via each provider's own CLI auth (browser flow), so we don't
//! store long-lived cloud secrets. Terraform then uses the CLI's credential chain.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::error::Result;
use crate::exec::{run, stream};

/// Civil (year, month, day) for a Unix timestamp, UTC (Howard Hinnant's algorithm). Used to
/// build Cost Explorer date ranges without a date-crate dependency.
fn ymd_from_secs(secs: i64) -> (i64, u32, u32) {
    let z = secs.div_euclid(86400) + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Cloud {
    Aws,
    Azure,
    Gcp,
}

/// Signs in to a cloud provider using its CLI. AWS uses SSO (needs a configured SSO
/// profile); Azure and GCP open the browser. Streams the CLI output to the UI.
#[tauri::command]
pub async fn cloud_login(provider: Cloud, logs: Channel<String>) -> Result<()> {
    let on_line = move |line: String| {
        let _ = logs.send(line);
    };
    let (program, args): (&'static str, &[&str]) = match provider {
        Cloud::Aws => ("aws", &["sso", "login"]),
        Cloud::Azure => ("az", &["login"]),
        // One browser flow that authenticates the gcloud CLI (so `gcloud projects list` works)
        // AND writes Application Default Credentials (what Terraform's google provider reads).
        // Plain `auth application-default login` only does the latter, leaving the CLI unauthed.
        Cloud::Gcp => ("gcloud", &["auth", "login", "--update-adc"]),
    };
    on_line(format!("$ {program} {}", args.join(" ")));
    stream(program, args, None, &[], on_line).await
}

/// The identity the host AWS CLI resolves (for the given profile, or the default chain),
/// if any, so the cloud setup can show "signed in as …" and offer using the CLI instead of
/// pasting keys. None when the CLI is missing or that profile has no usable credentials.
#[tauri::command]
pub async fn aws_cli_identity(profile: Option<String>) -> Option<String> {
    let mut args = vec!["sts", "get-caller-identity", "--query", "Arn", "--output", "text"];
    if let Some(p) = profile.as_deref() {
        args.push("--profile");
        args.push(p);
    }
    run("aws", &args, None).await.ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// The Cost Explorer time period for this month so far: Start = the 1st, End = tomorrow
/// (End is exclusive, so tomorrow includes today's spend).
pub(crate) fn month_period() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (y, m, _) = ymd_from_secs(now);
    let (ey, em, ed) = ymd_from_secs(now + 86400);
    format!("Start={y:04}-{m:02}-01,End={ey:04}-{em:02}-{ed:02}")
}

/// This month's AWS spend so far in USD, from Cost Explorer, for the budget check. None
/// when the CLI or Cost Explorer isn't available (CE must be enabled on the account).
#[tauri::command]
pub async fn aws_month_to_date_cost(profile: Option<String>) -> Option<f64> {
    let period = month_period();
    let mut args = vec![
        "ce",
        "get-cost-and-usage",
        "--time-period",
        &period,
        "--granularity",
        "MONTHLY",
        "--metrics",
        "UnblendedCost",
        "--query",
        "ResultsByTime[0].Total.UnblendedCost.Amount",
        "--output",
        "text",
    ];
    if let Some(p) = profile.as_deref() {
        args.push("--profile");
        args.push(p);
    }
    run("aws", &args, None).await.ok().and_then(|s| s.trim().parse::<f64>().ok())
}

/// The AWS CLI profiles configured on this machine (`aws configure list-profiles`), so the
/// user can pick one when they have several. Empty when the CLI is missing or has none.
#[tauri::command]
pub async fn aws_profiles() -> Vec<String> {
    run("aws", &["configure", "list-profiles"], None)
        .await
        .ok()
        .map(|s| s.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
}

/// An Azure subscription the signed-in account can use.
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AzureSubscription {
    pub name: String,
    pub id: String,
    #[serde(default)]
    pub is_default: bool,
}

/// The Azure subscriptions the signed-in account can see (`az account list`), so the user can
/// pick one instead of pasting a GUID. Empty when the CLI is missing or not signed in.
#[tauri::command]
pub async fn azure_subscriptions() -> Vec<AzureSubscription> {
    run("az", &["account", "list", "--query", "[].{name:name,id:id,isDefault:isDefault}", "--output", "json"], None)
        .await
        .ok()
        .and_then(|out| serde_json::from_str::<Vec<AzureSubscription>>(&out).ok())
        .unwrap_or_default()
}

/// A GCP billing account the signed-in user can see.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GcpBillingAccount {
    pub id: String,
    pub name: String,
    pub open: bool,
}

/// A GCP organization the signed-in user belongs to.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GcpOrganization {
    pub id: String,
    pub name: String,
}

/// What the launcher found in ~/.oci/config (DEFAULT profile), to prefill the OCI setup.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OciConfig {
    pub configured: bool,
    pub tenancy: String,
    pub region: String,
}

/// Reads the OCI config (OCI_CLI_CONFIG_FILE, else ~/.oci/config) DEFAULT profile, so the setup
/// can show whether it's configured and prefill the tenancy (as the compartment) and region.
#[tauri::command]
pub async fn oci_config() -> OciConfig {
    let path = std::env::var_os("OCI_CLI_CONFIG_FILE")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(|h| std::path::PathBuf::from(h).join(".oci").join("config")));
    let Some(path) = path else { return OciConfig::default() };
    let Ok(text) = std::fs::read_to_string(&path) else { return OciConfig::default() };
    let (mut tenancy, mut region) = (String::new(), String::new());
    let mut in_default = false;
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            in_default = l.eq_ignore_ascii_case("[DEFAULT]");
            continue;
        }
        if !in_default {
            continue;
        }
        if let Some((k, val)) = l.split_once('=') {
            match k.trim() {
                "tenancy" => tenancy = val.trim().to_string(),
                "region" => region = val.trim().to_string(),
                _ => {}
            }
        }
    }
    OciConfig { configured: true, tenancy, region }
}

/// The active gcloud account email, or None if the CLI isn't signed in. Reliable even when
/// `projects list` is empty or the Resource Manager API is off, so the UI can show "signed in".
#[tauri::command]
pub async fn gcp_account() -> Option<String> {
    run("gcloud", &["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], None)
        .await
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// The GCP billing accounts the signed-in user can see (`gcloud billing accounts list`), so they
/// pick one for the per-lab projects. Empty when the CLI is missing or not signed in.
#[tauri::command]
pub async fn gcp_billing_accounts() -> Vec<GcpBillingAccount> {
    run("gcloud", &["billing", "accounts", "list", "--format", "json"], None)
        .await
        .ok()
        .and_then(|out| serde_json::from_str::<Vec<serde_json::Value>>(&out).ok())
        .map(|arr| {
            arr.into_iter()
                .map(|v| GcpBillingAccount {
                    id: v["name"].as_str().unwrap_or_default().trim_start_matches("billingAccounts/").to_string(),
                    name: v["displayName"].as_str().unwrap_or_default().to_string(),
                    open: v["open"].as_bool().unwrap_or(false),
                })
                .filter(|b| !b.id.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// The GCP organizations the signed-in user belongs to (`gcloud organizations list`). Empty for
/// a personal / no-org account, so the user can create projects without a parent.
#[tauri::command]
pub async fn gcp_organizations() -> Vec<GcpOrganization> {
    run("gcloud", &["organizations", "list", "--format", "json"], None)
        .await
        .ok()
        .and_then(|out| serde_json::from_str::<Vec<serde_json::Value>>(&out).ok())
        .map(|arr| {
            arr.into_iter()
                .map(|v| GcpOrganization {
                    id: v["name"].as_str().unwrap_or_default().trim_start_matches("organizations/").to_string(),
                    name: v["displayName"].as_str().unwrap_or_default().to_string(),
                })
                .filter(|o| !o.id.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Signs in to AWS in the browser (`aws login`, AWS CLI >= 2.32.0): console credentials for
/// root / IAM / federation, temporary credentials for up to 12 hours, no SSO setup needed.
/// Streams the CLI output.
#[tauri::command]
pub async fn aws_login(profile: Option<String>, logs: Channel<String>) -> Result<()> {
    let on_line = move |line: String| {
        let _ = logs.send(line);
    };
    let mut args = vec!["login"];
    if let Some(p) = profile.as_deref() {
        args.push("--profile");
        args.push(p);
    }
    on_line(format!("$ aws {}", args.join(" ")));
    stream("aws", &args, None, &[], on_line).await
}
