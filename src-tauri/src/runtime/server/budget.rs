//! What an AWS account has cost this month (Cost Explorer), and the budget check run before a
//! cloud launch. AWS-only: the other clouds have no cost read yet, and never persist a limit.

use tauri::AppHandle;

use super::cloud_checks::{aws_cmd, last_line};
use super::contract::terraform_env;
use super::profile::HostProfile;
use super::secrets::host_secret;
use super::store::load_host;
use crate::error::{Error, Result};
use crate::runtime::providers::Provider;

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

/// Checks an account against its monthly budget before a launch.
pub async fn check_budget(app: &AppHandle, id: &str) -> BudgetCheck {
    let Ok(host) = load_host(app, id) else { return BudgetCheck::Ok };
    if host.provider != Provider::Aws {
        return BudgetCheck::Ok;
    }
    let Some(limit) = host.monthly_limit.filter(|v| *v > 0.0) else { return BudgetCheck::Ok };
    let Ok(password) = host_secret(&host) else {
        return BudgetCheck::Unverifiable("No stored credentials for this account. Re-enter its access keys, then launch again.".into());
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
pub(super) fn budget_unverifiable_message(err: &str) -> String {
    let lower = err.to_lowercase();
    let auth = ["expired", "aws login", "invalidclienttokenid", "unable to locate credentials", "sso", "not logged in", "tokenrefresh", "credentials"]
        .iter()
        .any(|m| lower.contains(m));
    if auth {
        "the AWS session has expired or isn't signed in.".into()
    } else if lower.contains("cost explorer") || lower.contains("not enabled") {
        "Cost Explorer isn't enabled on this account (enable it in the AWS Billing console).".into()
    } else {
        format!("couldn't read this month's spend ({}).", last_line(err))
    }
}

#[cfg(test)]
mod tests {
    use super::budget_unverifiable_message;

    #[test]
    fn budget_message_calls_out_an_expired_session_first() {
        // Auth-shaped failures win, whatever else is in the text.
        for err in ["The security token included in the request is expired", "Unable to locate credentials", "Error loading SSO Token", "InvalidClientTokenId"]
        {
            assert_eq!(budget_unverifiable_message(err), "the AWS session has expired or isn't signed in.", "{err}");
        }
    }

    #[test]
    fn budget_message_explains_cost_explorer_when_disabled() {
        let msg = budget_unverifiable_message("Cost Explorer is not enabled for this account");
        assert!(msg.contains("Cost Explorer isn't enabled"), "{msg}");
    }

    #[test]
    fn budget_message_falls_back_to_the_last_line() {
        let msg = budget_unverifiable_message("something odd\nthe real reason here");
        assert!(msg.contains("the real reason here"), "{msg}");
    }
}
