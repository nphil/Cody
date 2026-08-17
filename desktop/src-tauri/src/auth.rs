//! Silent sign-in for the desktop shell.
//!
//! Zero new server code: `CODY_PASSWORD` in the env block materialises the
//! existing env-managed `cody` admin, the shell (not the WebView) posts the
//! existing login route once, and the resulting session cookie is placed in
//! the WebView's cookie store before the first navigation. If any step
//! fails, the WebView simply lands on Cody's normal first-run/login screen.

pub const COOKIE_NAME: &str = "cody_session";
pub const ACCOUNT: &str = "cody";
pub const LOGIN_PATH: &str = "/api/accounts/login";

/// The session TTL the server issues.
pub const SESSION_DAYS: i64 = 30;

/// Pull the session token out of a `Set-Cookie` header. Attributes are
/// ignored: the shell rebuilds them for the cookie store.
pub fn parse_session_cookie(header: &str) -> Option<String> {
    for part in header.split(';') {
        let part = part.trim();
        if let Some(value) = part.strip_prefix(concat!("cody_session", "=")) {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

#[cfg(windows)]
pub use imp::*;

#[cfg(windows)]
mod imp {
    use super::*;
    use std::time::Duration;
    use tauri::webview::Cookie;
    use tauri::Runtime;

    /// Posts the existing login route with the env-managed account and
    /// returns the session token.
    pub fn sign_in(port: u16, password: &str) -> Result<String, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| e.to_string())?;
        let body = serde_json::json!({ "username": ACCOUNT, "password": password });
        let response = client
            .post(format!("http://127.0.0.1:{port}{LOGIN_PATH}"))
            .json(&body)
            .send()
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("Sign-in was refused ({}).", response.status()));
        }
        response
            .headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .find_map(parse_session_cookie)
            .ok_or_else(|| "The server issued no session cookie.".to_string())
    }

    /// Best effort by design. The cookie is written for `localhost` because
    /// that is the host the window navigates to; a failure here costs one
    /// login screen, never access.
    pub fn inject<R: Runtime>(
        webview: &tauri::WebviewWindow<R>,
        token: &str,
    ) -> Result<(), String> {
        let cookie = Cookie::build((COOKIE_NAME, token.to_string()))
            .domain("localhost")
            .path("/")
            .http_only(true)
            .same_site(tauri::webview::cookie::SameSite::Lax)
            // Mirrors the server's own Max-Age. Without it WebView2 stores a
            // session cookie and a later launch that cannot sign in silently
            // would drop the user on the login screen for no reason.
            .max_age(tauri::webview::cookie::time::Duration::days(SESSION_DAYS))
            .build();
        webview.set_cookie(cookie).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_the_token_from_a_full_set_cookie_header() {
        let header = "cody_session=abc.def.ghi; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000";
        assert_eq!(parse_session_cookie(header).as_deref(), Some("abc.def.ghi"));
    }

    #[test]
    fn ignores_other_cookies() {
        assert_eq!(parse_session_cookie("other=1; Path=/"), None);
    }

    #[test]
    fn ignores_a_cleared_cookie() {
        assert_eq!(
            parse_session_cookie("cody_session=; Path=/; Max-Age=0"),
            None
        );
    }

    #[test]
    fn tolerates_leading_whitespace() {
        assert_eq!(
            parse_session_cookie("  cody_session=tok  ; Path=/").as_deref(),
            Some("tok")
        );
    }
}
