//! Can the launcher reach a server or cloud account, and what it costs: connection tests
//! (SSH / Proxmox API / AWS STS / Azure CLI), month-to-date spend and the budget check.

use super::*;

// --- reachability ---------------------------------------------------------

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

/// Checks a `terraform` binary is on PATH. Every cloud lab is provisioned with it, so a missing
/// Terraform fails every launch; this catches it before the user tries. Shared by all clouds.
async fn terraform_check() -> Check {
    match crate::exec::run("terraform", &["version"], None).await {
        Ok(_) => Check::ok("Terraform", "Installed. Labs are provisioned with it."),
        Err(Error::ToolMissing { .. }) => {
            Check::fail("Terraform", "Not installed. Every cloud lab is provisioned with Terraform, so install it before launching.")
        }
        Err(e) => {
            let e = e.to_string();
            Check::warn("Terraform", format!("Couldn't check Terraform ({}).", e.lines().last().unwrap_or_default()))
        }
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
            let denied = stderr.contains("InvalidClientTokenId")
                || stderr.contains("SignatureDoesNotMatch")
                || stderr.contains("AccessDenied")
                || stderr.contains("Unable to locate credentials")
                || stderr.contains("sso");
            checks.push(Check::fail(
                "Credentials",
                if denied {
                    "AWS rejected these credentials, or the profile isn't signed in.".to_string()
                } else {
                    format!("AWS check failed: {}", stderr.lines().last().unwrap_or_default())
                },
            ));
            return TestResult::from_checks(checks, Some(started.elapsed().as_millis() as u64));
        }
        Err(e) => {
            checks.push(Check::fail("Credentials", format!("Couldn't reach AWS: {e}")));
            return TestResult { reachable: false, ..TestResult::from_checks(checks, None) };
        }
    };

    // 2) Launch permission. A dry run creates nothing; it only checks ec2:RunInstances.
    let dry =
        aws_cmd(h, &env, &["ec2", "run-instances", "--dry-run", "--instance-type", "t3.micro", "--image-id", "ami-00000000000000000", "--output", "text"])
            .await;
    let stderr = match &dry {
        Err(Error::CommandFailed { stderr, .. }) => stderr.clone(),
        _ => String::new(),
    };
    if stderr.contains("UnauthorizedOperation") {
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

    TestResult::from_checks(checks, Some(started.elapsed().as_millis() as u64))
}

/// This month's AWS spend so far (USD) for a host, via Cost Explorer.
pub(super) async fn month_to_date_cost(h: &HostProfile, password: &str) -> Result<f64> {
    let env = terraform_env(h, password);
    let period = crate::cloud::month_period();
    let out = aws_cmd(
        h,
        &env,
        &[
            "ce",
            "get-cost-and-usage",
            "--time-period",
            period.as_str(),
            "--granularity",
            "MONTHLY",
            "--metrics",
            "UnblendedCost",
            "--query",
            "ResultsByTime[0].Total.UnblendedCost.Amount",
            "--output",
            "text",
        ],
    )
    .await?;
    out.trim().parse::<f64>().map_err(|_| Error::Invalid(format!("couldn't read the spend figure from Cost Explorer: {:?}", out.trim())))
}

/// The budget check for a launch. Blocks only when the spend is readable and over the limit;
/// when it can't be read (`Unverifiable`) the caller warns and launches anyway (best effort).
pub enum BudgetCheck {
    /// No budget set, under it, or not an AWS account.
    Ok,
    /// At or over the monthly budget: (spent, limit) in USD.
    Over(f64, f64),
    /// A budget is set but this month's spend couldn't be read (Cost Explorer off, no
    /// `ce:GetCostAndUsage`, Docker/CLI missing, transient error). Carries why.
    Unverifiable(String),
}

/// Checks an account against its monthly budget before a launch. AWS-only (the other clouds
/// have no cost read yet, and never persist a limit).
pub async fn check_budget(app: &AppHandle, id: &str) -> BudgetCheck {
    let Some(store) = load(app).ok() else { return BudgetCheck::Ok };
    let Ok(host) = find(&store, id) else { return BudgetCheck::Ok };
    if host.provider != Provider::Aws {
        return BudgetCheck::Ok;
    }
    let Some(limit) = host.monthly_limit.filter(|v| *v > 0.0) else { return BudgetCheck::Ok };
    let password = if host.use_cli_creds {
        String::new()
    } else {
        match get_secret(id) {
            Ok(p) => p,
            Err(_) => {
                return BudgetCheck::Unverifiable("No stored credentials for this account. Re-enter its access keys, then launch again.".into());
            }
        }
    };
    match month_to_date_cost(&host, &password).await {
        Ok(spent) if spent >= limit => BudgetCheck::Over(spent, limit),
        Ok(_) => BudgetCheck::Ok,
        Err(e) => BudgetCheck::Unverifiable(budget_unverifiable_message(&e.to_string())),
    }
}

/// Turns a Cost Explorer failure into actionable guidance. An expired / missing sign-in is the
/// common case (and the launch would fail on it too), so it gets a "reauthenticate" message
/// rather than the misleading "enable Cost Explorer".
fn budget_unverifiable_message(err: &str) -> String {
    let lower = err.to_lowercase();
    let auth = ["expired", "aws login", "invalidclienttokenid", "unable to locate credentials", "sso", "not logged in", "tokenrefresh", "credentials"]
        .iter()
        .any(|m| lower.contains(m));
    if auth {
        "the AWS session has expired or isn't signed in.".into()
    } else if lower.contains("cost explorer") || lower.contains("not enabled") {
        "Cost Explorer isn't enabled on this account (enable it in the AWS Billing console).".into()
    } else {
        format!("couldn't read this month's spend ({}).", err.lines().last().unwrap_or_default())
    }
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
            let not_in = stderr.contains("az login") || stderr.contains("not logged in") || stderr.contains("AADSTS") || stderr.contains("was not found");
            checks.push(Check::fail(
                "Subscription",
                if not_in {
                    "Not signed in to Azure, or no access to that subscription. Sign in and check the subscription id.".to_string()
                } else {
                    format!("Azure check failed: {}", stderr.lines().last().unwrap_or_default())
                },
            ));
            return TestResult::from_checks(checks, Some(started.elapsed().as_millis() as u64));
        }
        Err(e) => {
            checks.push(Check::fail("Azure CLI", format!("Couldn't run the Azure CLI: {e}")));
            return TestResult { reachable: false, ..TestResult::from_checks(checks, None) };
        }
    }
    checks.push(azure_capacity_check(h).await);
    checks.push(terraform_check().await);
    TestResult::from_checks(checks, Some(started.elapsed().as_millis() as u64))
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
    let free = usage.ok().and_then(|o| serde_json::from_str::<Vec<serde_json::Value>>(&o).ok()).and_then(|u| {
        u.into_iter().find(|x| x["name"]["value"].as_str().map(str::to_lowercase).as_deref() == Some(family.as_str())).map(|x| {
            let n = |v: &serde_json::Value| v.as_str().and_then(|s| s.parse::<i64>().ok()).or_else(|| v.as_i64()).unwrap_or(0);
            n(&x["limit"]) - n(&x["currentValue"])
        })
    });
    match free {
        Some(f) if f >= 2 => Check::ok("VM size", format!("{size} is available in {region} ({f} cores of quota free).")),
        Some(_) => Check::fail(
            "VM size",
            format!("No core quota left for {size} in {region}. Request more in the Azure portal (Quotas), or try the region swedencentral."),
        ),
        None => Check::warn("VM size", format!("Couldn't read the core quota for {size} in {region}; a launch may still fail on it.")),
    }
}

/// GCP: `gcloud projects describe <project>` confirms gcloud's application-default login is
/// in place and the project is reachable. (No cheap VM-create dry-run like AWS.)
pub(super) async fn test_gcp(h: &HostProfile) -> TestResult {
    let started = Instant::now();
    let mut checks: Vec<Check> = Vec::new();
    // The username is the billing account id; confirm the signed-in CLI can see it (labs each
    // create their own project linked to this account).
    let args = ["billing", "accounts", "describe", h.username.as_str(), "--format", "value(displayName)"];
    match crate::exec::run("gcloud", &args, None).await {
        Ok(name) => {
            checks.push(Check::ok("Billing account", format!("Signed in; billing account \"{}\".", name.trim())));
        }
        Err(Error::CommandFailed { stderr, .. }) => {
            let not_in = stderr.contains("gcloud auth")
                || stderr.contains("credentials")
                || stderr.contains("does not have permission")
                || stderr.contains("was not found")
                || stderr.contains("PERMISSION_DENIED")
                || stderr.contains("Permission denied");
            checks.push(Check::fail(
                "Billing account",
                if not_in {
                    "Not signed in to Google Cloud, or no access to that billing account. Sign in and check the billing account id.".to_string()
                } else {
                    format!("GCP check failed: {}", stderr.lines().last().unwrap_or_default())
                },
            ));
            return TestResult::from_checks(checks, Some(started.elapsed().as_millis() as u64));
        }
        Err(e) => {
            checks.push(Check::fail("gcloud CLI", format!("Couldn't run the gcloud CLI: {e}")));
            return TestResult { reachable: false, ..TestResult::from_checks(checks, None) };
        }
    }
    checks.push(terraform_check().await);
    TestResult::from_checks(checks, Some(started.elapsed().as_millis() as u64))
}

/// DigitalOcean: the API token is valid when `GET /v2/account` returns 2xx.
pub(super) async fn test_digitalocean(token: &str) -> TestResult {
    let started = Instant::now();
    let mut checks: Vec<Check> = Vec::new();
    match reqwest::Client::new().get("https://api.digitalocean.com/v2/account").bearer_auth(token).send().await {
        Ok(resp) if resp.status().is_success() => checks.push(Check::ok("API token", "Token is valid. Labs run as droplets in this account.")),
        Ok(resp) if resp.status() == reqwest::StatusCode::UNAUTHORIZED => {
            checks.push(Check::fail("API token", "DigitalOcean rejected this token. Create a new one with read/write scope."));
            return TestResult::from_checks(checks, Some(started.elapsed().as_millis() as u64));
        }
        Ok(resp) => {
            checks.push(Check::fail("API token", format!("DigitalOcean API returned {}.", resp.status())));
            return TestResult::from_checks(checks, Some(started.elapsed().as_millis() as u64));
        }
        Err(e) => {
            checks.push(Check::fail("API token", format!("Can't reach DigitalOcean: {e}")));
            return TestResult { reachable: false, ..TestResult::from_checks(checks, None) };
        }
    }
    checks.push(terraform_check().await);
    TestResult::from_checks(checks, Some(started.elapsed().as_millis() as u64))
}

/// Linode: the API token is valid when `GET /v4/account` returns 2xx.
pub(super) async fn test_linode(token: &str) -> TestResult {
    let started = Instant::now();
    let mut checks: Vec<Check> = Vec::new();
    match reqwest::Client::new().get("https://api.linode.com/v4/account").bearer_auth(token).send().await {
        Ok(resp) if resp.status().is_success() => checks.push(Check::ok("API token", "Token is valid. Labs run as Linodes in this account.")),
        Ok(resp) if resp.status() == reqwest::StatusCode::UNAUTHORIZED => {
            checks.push(Check::fail("API token", "Linode rejected this token. Create a new one with read/write scope."));
            return TestResult::from_checks(checks, Some(started.elapsed().as_millis() as u64));
        }
        Ok(resp) => {
            checks.push(Check::fail("API token", format!("Linode API returned {}.", resp.status())));
            return TestResult::from_checks(checks, Some(started.elapsed().as_millis() as u64));
        }
        Err(e) => {
            checks.push(Check::fail("API token", format!("Can't reach Linode: {e}")));
            return TestResult { reachable: false, ..TestResult::from_checks(checks, None) };
        }
    }
    checks.push(terraform_check().await);
    TestResult::from_checks(checks, Some(started.elapsed().as_millis() as u64))
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
            let bad = stderr.contains("NotAuthenticated")
                || stderr.contains("NotAuthorizedOrNotFound")
                || stderr.contains("config")
                || stderr.contains("private key")
                || stderr.contains("401");
            checks.push(Check::fail(
                "Compartment",
                if bad {
                    "OCI rejected the request. Check ~/.oci/config (API key) and the compartment OCID.".to_string()
                } else {
                    format!("OCI check failed: {}", stderr.lines().last().unwrap_or_default())
                },
            ));
            return TestResult::from_checks(checks, Some(started.elapsed().as_millis() as u64));
        }
        Err(e) => {
            checks.push(Check::fail("Compartment", format!("OCI check failed: {e}")));
            return TestResult { reachable: false, ..TestResult::from_checks(checks, None) };
        }
    }
    checks.push(terraform_check().await);
    TestResult::from_checks(checks, Some(started.elapsed().as_millis() as u64))
}

pub(super) async fn test_host(h: &HostProfile, password: &str) -> TestResult {
    if h.provider == Provider::Aws {
        return test_aws(h, password).await;
    }
    if h.provider == Provider::Linode {
        return test_linode(password).await;
    }
    if h.provider == Provider::Oci {
        return test_oci(h).await;
    }
    if h.provider == Provider::Azure {
        return test_azure(h).await;
    }
    if h.provider == Provider::Gcp {
        return test_gcp(h).await;
    }
    if h.provider == Provider::DigitalOcean {
        return test_digitalocean(password).await;
    }
    let started = Instant::now();
    let connect = tokio::time::timeout(TEST_TIMEOUT, TcpStream::connect((h.host.as_str(), h.port))).await;
    let mut stream = match connect {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            return TestResult {
                ok: false,
                reachable: false,
                authenticated: None,
                latency_ms: None,
                message: format!("Can't reach {}:{}: {e}", h.host, h.port),
                checks: Vec::new(),
            };
        }
        Err(_) => {
            return TestResult {
                ok: false,
                reachable: false,
                authenticated: None,
                latency_ms: None,
                message: format!("Timed out reaching {}:{}", h.host, h.port),
                checks: Vec::new(),
            };
        }
    };
    let latency_ms = Some(started.elapsed().as_millis() as u64);

    match h.provider {
        // vagrant-vmware-esxi drives ESXi over SSH: check the port actually speaks SSH.
        Provider::VmwareEsxi => {
            let mut buf = [0u8; 64];
            let banner = tokio::time::timeout(TEST_TIMEOUT, stream.read(&mut buf)).await;
            match banner {
                Ok(Ok(n)) if buf[..n].starts_with(b"SSH-") => TestResult {
                    ok: true,
                    reachable: true,
                    authenticated: None,
                    latency_ms,
                    message: "SSH is up. Make sure SSH is enabled on the ESXi host; the password is checked on first lab start.".into(),
                    checks: Vec::new(),
                },
                _ => TestResult {
                    ok: false,
                    reachable: true,
                    authenticated: None,
                    latency_ms,
                    message: format!("Port {} is open but doesn't answer as SSH. Enable SSH on the ESXi host.", h.port),
                    checks: Vec::new(),
                },
            }
        }
        // Proxmox: sign in to the API (token or user + password), then check what a lab
        // launch needs (node, storage content, bridge, SSH key for token setups).
        Provider::Proxmox => {
            drop(stream);
            let r = crate::runtime::proxmox::test(h, password).await;
            TestResult { ok: r.ok, reachable: true, authenticated: r.authenticated, latency_ms, message: r.message, checks: Vec::new() }
        }
        _ => TestResult { ok: true, reachable: true, authenticated: None, latency_ms, message: "Reachable".into(), checks: Vec::new() },
    }
}
