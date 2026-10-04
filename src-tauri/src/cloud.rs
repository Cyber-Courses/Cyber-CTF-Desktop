//! Cloud account connection via each provider's own CLI auth (browser flow), so we don't
//! store long-lived cloud secrets. Terraform then uses the CLI's credential chain.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
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
        Cloud::Gcp => ("gcloud", &["auth", "application-default", "login"]),
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
