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

/// AWS: verify the credentials work (`sts get-caller-identity`) and that they can actually
/// launch EC2 (`ec2 run-instances --dry-run`, which creates nothing but checks the permission).
pub(super) async fn test_aws(h: &HostProfile, password: &str) -> TestResult {
    let started = Instant::now();
    let env = terraform_env(h, password);
    let arn = match aws_cmd(h, &env, &["sts", "get-caller-identity", "--query", "Arn", "--output", "text"]).await {
        Ok(a) => a.trim().to_string(),
        Err(Error::CommandFailed { stderr, .. }) => {
            let denied = stderr.contains("InvalidClientTokenId")
                || stderr.contains("SignatureDoesNotMatch")
                || stderr.contains("AccessDenied")
                || stderr.contains("Unable to locate credentials")
                || stderr.contains("sso");
            return TestResult {
                ok: false,
                reachable: true,
                authenticated: denied.then_some(false),
                latency_ms: None,
                message: if denied {
                    "AWS rejected these credentials, or the profile isn't signed in.".into()
                } else {
                    format!("AWS check failed: {}", stderr.lines().last().unwrap_or_default())
                },
            };
        }
        Err(e) => return TestResult { ok: false, reachable: false, authenticated: None, latency_ms: None, message: format!("AWS check failed: {e}") },
    };
    // Can this identity launch EC2? A dry run creates nothing; it only checks the permission.
    let dry =
        aws_cmd(h, &env, &["ec2", "run-instances", "--dry-run", "--instance-type", "t3.micro", "--image-id", "ami-00000000000000000", "--output", "text"])
            .await;
    let latency = Some(started.elapsed().as_millis() as u64);
    let stderr = match &dry {
        Err(Error::CommandFailed { stderr, .. }) => stderr.clone(),
        _ => String::new(),
    };
    if stderr.contains("UnauthorizedOperation") {
        return TestResult {
            ok: false,
            reachable: true,
            authenticated: Some(true),
            latency_ms: latency,
            message: format!("Signed in as {arn}, but this identity can't launch EC2 (ec2:RunInstances is denied). Add EC2 permissions to it."),
        };
    }
    TestResult {
        ok: true,
        reachable: true,
        authenticated: Some(true),
        latency_ms: latency,
        message: format!("Signed in as {arn}, and able to launch EC2. Labs run here are billed to this account."),
    }
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

/// The budget check for a launch. A limit that can't be verified fails closed (`Unverifiable`)
/// rather than silently letting the launch through.
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
            Err(_) => return BudgetCheck::Unverifiable("no stored credentials for this account".into()),
        }
    };
    match month_to_date_cost(&host, &password).await {
        Ok(spent) if spent >= limit => BudgetCheck::Over(spent, limit),
        Ok(_) => BudgetCheck::Ok,
        Err(e) => BudgetCheck::Unverifiable(e.to_string()),
    }
}

/// Azure: `az account show` for the subscription confirms the CLI is signed in and the
/// subscription is reachable. (az has no cheap VM-create dry-run like AWS.)
pub(super) async fn test_azure(h: &HostProfile) -> TestResult {
    let started = Instant::now();
    let args = ["account", "show", "--subscription", h.username.as_str(), "--query", "name", "--output", "tsv"];
    match crate::exec::run("az", &args, None).await {
        Ok(name) => TestResult {
            ok: true,
            reachable: true,
            authenticated: Some(true),
            latency_ms: Some(started.elapsed().as_millis() as u64),
            message: format!("Signed in to Azure subscription \"{}\". Labs run here are billed to it.", name.trim()),
        },
        Err(Error::CommandFailed { stderr, .. }) => {
            let not_in = stderr.contains("az login") || stderr.contains("not logged in") || stderr.contains("AADSTS") || stderr.contains("was not found");
            TestResult {
                ok: false,
                reachable: true,
                authenticated: Some(false),
                latency_ms: None,
                message: if not_in {
                    "Not signed in to Azure, or no access to that subscription. Sign in and check the subscription id.".into()
                } else {
                    format!("Azure check failed: {}", stderr.lines().last().unwrap_or_default())
                },
            }
        }
        Err(e) => TestResult { ok: false, reachable: false, authenticated: None, latency_ms: None, message: format!("Azure check failed: {e}") },
    }
}

/// GCP: `gcloud projects describe <project>` confirms gcloud's application-default login is
/// in place and the project is reachable. (No cheap VM-create dry-run like AWS.)
pub(super) async fn test_gcp(h: &HostProfile) -> TestResult {
    let started = Instant::now();
    // The username is the billing account id; confirm the signed-in CLI can see it (labs each
    // create their own project linked to this account).
    let args = ["billing", "accounts", "describe", h.username.as_str(), "--format", "value(displayName)"];
    match crate::exec::run("gcloud", &args, None).await {
        Ok(name) => TestResult {
            ok: true,
            reachable: true,
            authenticated: Some(true),
            latency_ms: Some(started.elapsed().as_millis() as u64),
            message: format!("Signed in to Google Cloud, billing account \"{}\". Each lab creates its own project, billed to it.", name.trim()),
        },
        Err(Error::CommandFailed { stderr, .. }) => {
            let not_in = stderr.contains("gcloud auth")
                || stderr.contains("credentials")
                || stderr.contains("does not have permission")
                || stderr.contains("was not found")
                || stderr.contains("PERMISSION_DENIED")
                || stderr.contains("Permission denied");
            TestResult {
                ok: false,
                reachable: true,
                authenticated: Some(false),
                latency_ms: None,
                message: if not_in {
                    "Not signed in to Google Cloud, or no access to that billing account. Sign in and check the billing account id.".into()
                } else {
                    format!("GCP check failed: {}", stderr.lines().last().unwrap_or_default())
                },
            }
        }
        Err(e) => TestResult { ok: false, reachable: false, authenticated: None, latency_ms: None, message: format!("GCP check failed: {e}") },
    }
}

/// DigitalOcean: the API token is valid when `GET /v2/account` returns 2xx.
pub(super) async fn test_digitalocean(token: &str) -> TestResult {
    let started = Instant::now();
    match reqwest::Client::new().get("https://api.digitalocean.com/v2/account").bearer_auth(token).send().await {
        Ok(resp) if resp.status().is_success() => TestResult {
            ok: true,
            reachable: true,
            authenticated: Some(true),
            latency_ms: Some(started.elapsed().as_millis() as u64),
            message: "DigitalOcean token is valid. Labs run as droplets in this account.".into(),
        },
        Ok(resp) if resp.status() == reqwest::StatusCode::UNAUTHORIZED => TestResult {
            ok: false,
            reachable: true,
            authenticated: Some(false),
            latency_ms: None,
            message: "DigitalOcean rejected this token. Create a new one with read/write scope.".into(),
        },
        Ok(resp) => TestResult {
            ok: false,
            reachable: true,
            authenticated: Some(false),
            latency_ms: None,
            message: format!("DigitalOcean API returned {}.", resp.status()),
        },
        Err(e) => TestResult { ok: false, reachable: false, authenticated: None, latency_ms: None, message: format!("Can't reach DigitalOcean: {e}") },
    }
}

pub(super) async fn test_host(h: &HostProfile, password: &str) -> TestResult {
    if h.provider == Provider::Aws {
        return test_aws(h, password).await;
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
            };
        }
        Err(_) => {
            return TestResult {
                ok: false,
                reachable: false,
                authenticated: None,
                latency_ms: None,
                message: format!("Timed out reaching {}:{}", h.host, h.port),
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
                },
                _ => TestResult {
                    ok: false,
                    reachable: true,
                    authenticated: None,
                    latency_ms,
                    message: format!("Port {} is open but doesn't answer as SSH. Enable SSH on the ESXi host.", h.port),
                },
            }
        }
        // Proxmox: sign in to the API (token or user + password), then check what a lab
        // launch needs (node, storage content, bridge, SSH key for token setups).
        Provider::Proxmox => {
            drop(stream);
            let r = crate::runtime::proxmox::test(h, password).await;
            TestResult { ok: r.ok, reachable: true, authenticated: r.authenticated, latency_ms, message: r.message }
        }
        _ => TestResult { ok: true, reachable: true, authenticated: None, latency_ms, message: "Reachable".into() },
    }
}
