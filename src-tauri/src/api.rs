//! CyberBackend access. The access token is attached here, on the Rust side, so it
//! never reaches the webview.

use serde_json::{Value, json};

use crate::auth;
use crate::config;
use crate::error::{Error, Result};

/// Runs a GraphQL operation as the logged-in player (anonymous if logged out
/// and `require_login` is false). Returns `data`, or the first error message.
pub async fn graphql(query: &str, variables: Value, require_login: bool) -> Result<Value> {
    let token = match auth::access_token().await {
        Ok(t) => Some(t),
        Err(e) if require_login => return Err(e),
        Err(_) => None,
    };
    let mut req = reqwest::Client::new().post(format!("{}/graphql", config::api_url())).json(&json!({ "query": query, "variables": variables }));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let res = req.send().await.map_err(|e| Error::Invalid(format!("API unreachable: {e}")))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| Error::Invalid(format!("API response interrupted: {e}")))?;
    // Platform errors (e.g. a timed-out cold start) are not GraphQL JSON.
    let body: Value = serde_json::from_str(&text).map_err(|_| {
        let excerpt: String = text.chars().take(160).collect();
        Error::Invalid(format!("API error (HTTP {status}): {excerpt}"))
    })?;
    if let Some(message) = body.pointer("/errors/0/message").and_then(Value::as_str) {
        return Err(Error::Invalid(message.to_string()));
    }
    Ok(body.get("data").cloned().unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn api_query(query: String, variables: Option<Value>) -> Result<Value> {
    graphql(&query, variables.unwrap_or(Value::Null), false).await
}

#[cfg(test)]
mod tests {
    /// Hits the real CyberBackend anonymously: `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore = "network"]
    async fn queries_the_api_anonymously() {
        let data = super::graphql("{ challenges { id } me { authId } }", serde_json::Value::Null, false).await.unwrap();
        assert!(data["challenges"].is_array());
        assert!(data["me"].is_null());
        let err = super::graphql("mutation { startLab(labId: \"x\") { labId } }", serde_json::Value::Null, true).await.unwrap_err();
        assert_eq!(err.to_string(), "not logged in");
    }
}
