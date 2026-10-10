//! "Test connection" for cloud accounts: a checklist per cloud (credentials, what a launch
//! needs, Terraform), each failure worded as the thing to fix.

use std::time::Instant;

use super::budget::{budget_unverifiable_message, month_to_date_cost};
use super::checks::{Check, TestResult};
use super::contract::terraform_env;
use super::profile::HostProfile;
use crate::error::{Error, Result};

/// Runs an aws subcommand the way this host connects: the host CLI (CLI credentials), or the
/// official CLI container with the keys in its environment (Docker is the floor).
pub(super) async fn aws_cmd(h: &HostProfile, env: &[(String, String)], sub: &[&str]) -> Result<String> {
    if h.use_cli_creds {
        crate::exec::run_env("aws", sub, None, env).await
    } else {
        let mut args = vec!["run", "--rm", "-e", "AWS_ACCESS_KEY_ID", "-e", "AWS_SECRET_ACCESS_KEY", "-e", "AWS_REGION", "amazon/aws-cli:2.37.9"];
        args.extend_from_slice(sub);
        crate::exec::run_env("docker", &args, None, env).await
    }
}

/// The last line of a tool's output (where CLIs put the reason).
pub(super) fn last_line(s: &str) -> &str {
    s.lines().last().unwrap_or_default()
}

/// The detail of a CLI check the cloud refused: `refused` when stderr carries one of `markers`
/// (signed out, no access), else "<cloud> check failed: <last line>".
fn refusal(stderr: &str, markers: &[&str], refused: &str, cloud: &str) -> String {
    if markers.iter().any(|m| stderr.contains(m)) { refused.to_string() } else { format!("{cloud} check failed: {}", last_line(stderr)) }
}

/// Checks a `terraform` binary is on PATH. Every cloud lab is provisioned with it, so a missing
/// Terraform fails every launch; this catches it before the user tries. Shared by all clouds.
async fn terraform_check() -> Check {
    match crate::exec::run("terraform", &["version"], None).await {
        Ok(_) => Check::ok("Terraform", "Installed. Labs are provisioned with it."),
        Err(Error::ToolMissing { .. }) => {
            Check::fail("Terraform", "Not installed. Every cloud lab is provisioned with Terraform, so install it before launching.")
        }
        Err(e) => Check::warn("Terraform", format!("Couldn't check Terraform ({}).", last_line(&e.to_string()))),
    }
}

/// AWS: a checklist run before launch. Verifies the credentials (`sts get-caller-identity`), that
/// the identity can launch EC2 (`ec2 run-instances --dry-run`, which creates nothing), Terraform,
/// and the monthly budget when one is set.
pub(super) async fn test_aws(h: &HostProfile, password: &str) -> TestResult {
    let started = Instant::now();
    let env = terraform_env(h, password);
    let mut checks: Vec<Check> = Vec::new();

    // 1) Credentials.
    let arn = match aws_cmd(h, &env, &["sts", "get-caller-identity", "--query", "Arn", "--output", "text"]).await {
        Ok(a) => {
            let arn = a.trim().to_string();
            checks.push(Check::ok("Credentials", format!("Signed in as {arn}.")));
            arn
        }
        Err(Error::CommandFailed { stderr, .. }) => {
            let markers = ["InvalidClientTokenId", "SignatureDoesNotMatch", "AccessDenied", "Unable to locate credentials", "sso"];
            checks.push(Check::fail("Credentials", refusal(&stderr, &markers, "AWS rejected these credentials, or the profile isn't signed in.", "AWS")));
            return TestResult::timed(checks, started);
        }
        Err(e) => {
            checks.push(Check::fail("Credentials", format!("Couldn't reach AWS: {e}")));
            return TestResult::unreachable_checks(checks);
        }
    };

    // 2) Launch permission. A dry run creates nothing; it only checks ec2:RunInstances.
    let dry =
        aws_cmd(h, &env, &["ec2", "run-instances", "--dry-run", "--instance-type", "t3.micro", "--image-id", "ami-00000000000000000", "--output", "text"])
            .await;
    if matches!(&dry, Err(Error::CommandFailed { stderr, .. }) if stderr.contains("UnauthorizedOperation")) {
        checks.push(Check::fail("Launch permission", format!("{arn} can't launch EC2 (ec2:RunInstances is denied). Add EC2 permissions to it.")));
    } else {
        checks.push(Check::ok("Launch permission", "Able to launch EC2 instances."));
    }

    // 3) Terraform.
    checks.push(terraform_check().await);

    // 4) Budget, only when one is set.
    if let Some(limit) = h.monthly_limit.filter(|v| *v > 0.0) {
        match month_to_date_cost(h, password).await {
            Ok(spent) if spent >= limit => {
                checks.push(Check::fail("Budget", format!("Over budget: ${spent:.2} of ${limit:.0} this month. New labs here are blocked.")))
            }
            Ok(spent) => checks.push(Check::ok("Budget", format!("${spent:.2} of ${limit:.0} spent this month."))),
            Err(e) => checks.push(Check::warn(
                "Budget",
                format!("Set to ${limit:.0}/mo, but this month's spend couldn't be read: {}", budget_unverifiable_message(&e.to_string())),
            )),
        }
    }

    TestResult::timed(checks, started)
}

/// Azure: `az account show` for the subscription confirms the CLI is signed in and the
/// subscription is reachable. (az has no cheap VM-create dry-run like AWS.)
pub(super) async fn test_azure(h: &HostProfile) -> TestResult {
    let started = Instant::now();
    let mut checks: Vec<Check> = Vec::new();
    let args = ["account", "show", "--subscription", h.username.as_str(), "--query", "name", "--output", "tsv"];
    match crate::exec::run("az", &args, None).await {
        Ok(name) => checks.push(Check::ok("Subscription", format!("Signed in to subscription \"{}\".", name.trim()))),
        Err(Error::CommandFailed { stderr, .. }) => {
            let markers = ["az login", "not logged in", "AADSTS", "was not found"];
            let refused = "Not signed in to Azure, or no access to that subscription. Sign in and check the subscription id.";
            checks.push(Check::fail("Subscription", refusal(&stderr, &markers, refused, "Azure")));
            return TestResult::timed(checks, started);
        }
        Err(e) => {
            checks.push(Check::fail("Azure CLI", format!("Couldn't run the Azure CLI: {e}")));
            return TestResult::unreachable_checks(checks);
        }
    }
    checks.push(azure_capacity_check(h).await);
    checks.push(terraform_check().await);
    TestResult::timed(checks, started)
}

/// Free cores in a VM family's quota, from `az vm list-usage` (numbers come as strings or ints).
fn free_cores(usage: &[serde_json::Value], family: &str) -> Option<i64> {
    usage.iter().find(|x| x["name"]["value"].as_str().map(str::to_lowercase).as_deref() == Some(family)).map(|x| {
        let n = |v: &serde_json::Value| v.as_str().and_then(|s| s.parse::<i64>().ok()).or_else(|| v.as_i64()).unwrap_or(0);
        n(&x["limit"]) - n(&x["currentValue"])
    })
}

/// Azure: can this subscription create the lab VM size in the region? New subscriptions often
/// can't: a region refuses new customers, a size isn't offered to the subscription, or its
/// family has no core quota. All seen on real runs; each makes a launch fail late.
async fn azure_capacity_check(h: &HostProfile) -> Check {
    // The size labs use: the one set on the account, else Isoloom's default for a small lab.
    let size = h.datastore.clone().unwrap_or_else(|| "Standard_D2als_v6".into());
    let region = h.host.as_str();
    let sku = crate::exec::run(
        "az",
        &["vm", "list-skus", "--subscription", &h.username, "-l", region, "--size", &size, "--resource-type", "virtualMachines", "-o", "json"],
        None,
    )
    .await;
    let skus: Vec<serde_json::Value> = sku.ok().and_then(|o| serde_json::from_str(&o).ok()).unwrap_or_default();
    let Some(entry) = skus.iter().find(|k| k["name"].as_str() == Some(size.as_str())) else {
        return Check::fail("VM size", format!("{size} isn't offered in {region}. Try the region swedencentral, which accepts new subscriptions."));
    };
    if entry["restrictions"].as_array().is_some_and(|r| !r.is_empty()) {
        return Check::fail("VM size", format!("{size} isn't available to this subscription in {region}. Try the region swedencentral."));
    }
    let family = entry["family"].as_str().unwrap_or_default().to_lowercase();
    let usage = crate::exec::run("az", &["vm", "list-usage", "--subscription", &h.username, "-l", region, "-o", "json"], None).await;
    let free = usage.ok().and_then(|o| serde_json::from_str::<Vec<serde_json::Value>>(&o).ok()).and_then(|u| free_cores(&u, &family));
    match free {
        Some(f) if f >= 2 => Check::ok("VM size", format!("{size} is available in {region} ({f} cores of quota free).")),
        Some(_) => Check::fail(
            "VM size",
            format!("No core quota left for {size} in {region}. Request more in the Azure portal (Quotas), or try the region swedencentral."),
        ),
        None => Check::warn("VM size", format!("Couldn't read the core quota for {size} in {region}; a launch may still fail on it.")),
    }
}

/// GCP: `gcloud billing accounts describe` confirms gcloud is signed in and can see the billing
/// account the labs project is linked to. (No cheap VM-create dry-run like AWS.)
pub(super) async fn test_gcp(h: &HostProfile) -> TestResult {
    let started = Instant::now();
    let mut checks: Vec<Check> = Vec::new();
    let args = ["billing", "accounts", "describe", h.username.as_str(), "--format", "value(displayName)"];
    match crate::exec::run("gcloud", &args, None).await {
        Ok(name) => checks.push(Check::ok("Billing account", format!("Signed in; billing account \"{}\".", name.trim()))),
        Err(Error::CommandFailed { stderr, .. }) => {
            let markers = ["gcloud auth", "credentials", "does not have permission", "was not found", "PERMISSION_DENIED", "Permission denied"];
            let refused = "Not signed in to Google Cloud, or no access to that billing account. Sign in and check the billing account id.";
            checks.push(Check::fail("Billing account", refusal(&stderr, &markers, refused, "GCP")));
            return TestResult::timed(checks, started);
        }
        Err(e) => {
            checks.push(Check::fail("gcloud CLI", format!("Couldn't run the gcloud CLI: {e}")));
            return TestResult::unreachable_checks(checks);
        }
    }
    checks.push(terraform_check().await);
    TestResult::timed(checks, started)
}

/// A token-authenticated cloud (DigitalOcean, Linode): the API token is valid when its
/// `account` endpoint returns 2xx. `instances` is what labs run as there.
async fn test_token_api(cloud: &str, account_url: &str, instances: &str, token: &str) -> TestResult {
    let started = Instant::now();
    let mut checks: Vec<Check> = Vec::new();
    match reqwest::Client::new().get(account_url).bearer_auth(token).send().await {
        Ok(resp) if resp.status().is_success() => checks.push(Check::ok("API token", format!("Token is valid. Labs run as {instances} in this account."))),
        Ok(resp) if resp.status() == reqwest::StatusCode::UNAUTHORIZED => {
            checks.push(Check::fail("API token", format!("{cloud} rejected this token. Create a new one with read/write scope.")));
            return TestResult::timed(checks, started);
        }
        Ok(resp) => {
            checks.push(Check::fail("API token", format!("{cloud} API returned {}.", resp.status())));
            return TestResult::timed(checks, started);
        }
        Err(e) => {
            checks.push(Check::fail("API token", format!("Can't reach {cloud}: {e}")));
            return TestResult::unreachable_checks(checks);
        }
    }
    checks.push(terraform_check().await);
    TestResult::timed(checks, started)
}

pub(super) async fn test_digitalocean(token: &str) -> TestResult {
    test_token_api("DigitalOcean", "https://api.digitalocean.com/v2/account", "droplets", token).await
}

pub(super) async fn test_linode(token: &str) -> TestResult {
    test_token_api("Linode", "https://api.linode.com/v4/account", "Linodes", token).await
}

/// OCI: if the OCI CLI is installed, a signed `iam compartment get` confirms ~/.oci/config +
/// the compartment. Terraform itself only needs ~/.oci/config, so a missing CLI isn't fatal.
pub(super) async fn test_oci(h: &HostProfile) -> TestResult {
    let started = Instant::now();
    let mut checks: Vec<Check> = Vec::new();
    match crate::exec::run("oci", &["iam", "compartment", "get", "--compartment-id", h.username.as_str(), "--query", "data.name", "--raw-output"], None).await {
        Ok(name) => checks.push(Check::ok("Compartment", format!("Reached compartment \"{}\". Labs run in your tenancy.", name.trim()))),
        // Terraform only needs ~/.oci/config, so a missing CLI isn't fatal; it just can't verify here.
        Err(Error::ToolMissing { .. }) => checks
            .push(Check::warn("Compartment", "Couldn't verify here (the OCI CLI isn't installed). Terraform will use ~/.oci/config when you launch a lab.")),
        Err(Error::CommandFailed { stderr, .. }) => {
            let markers = ["NotAuthenticated", "NotAuthorizedOrNotFound", "config", "private key", "401"];
            let refused = "OCI rejected the request. Check ~/.oci/config (API key) and the compartment OCID.";
            checks.push(Check::fail("Compartment", refusal(&stderr, &markers, refused, "OCI")));
            return TestResult::timed(checks, started);
        }
        Err(e) => {
            checks.push(Check::fail("Compartment", format!("OCI check failed: {e}")));
            return TestResult::unreachable_checks(checks);
        }
    }
    checks.push(terraform_check().await);
    TestResult::timed(checks, started)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusal_names_the_fix_or_quotes_the_cli() {
        let markers = ["az login", "AADSTS"];
        assert_eq!(refusal("ERROR: Please run 'az login' to setup account.", &markers, "Sign in.", "Azure"), "Sign in.");
        assert_eq!(refusal("WARNING: x\nERROR: quota exceeded", &markers, "Sign in.", "Azure"), "Azure check failed: ERROR: quota exceeded");
        assert_eq!(refusal("", &markers, "Sign in.", "OCI"), "OCI check failed: ");
    }

    #[test]
    fn free_cores_reads_string_or_number_quotas() {
        let usage = serde_json::json!([
            {"name": {"value": "standardDASv6Family"}, "limit": "10", "currentValue": "4"},
            {"name": {"value": "cores"}, "limit": 20, "currentValue": 19}
        ]);
        let usage = usage.as_array().unwrap();
        assert_eq!(free_cores(usage, "standarddasv6family"), Some(6));
        assert_eq!(free_cores(usage, "cores"), Some(1));
        assert_eq!(free_cores(usage, "other"), None);
    }
}
