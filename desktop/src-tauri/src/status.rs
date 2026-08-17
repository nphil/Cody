//! Setup state shared between the Rust state machine and the bootstrap page.

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Starting,
    CheckingWsl,
    Downloading,
    Importing,
    StartingServer,
    SigningIn,
    Ready,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FailureKind {
    WslMissing,
    WslFeatureDisabled,
    VirtualizationDisabled,
    WslKernelOutdated,
    NotSystemDrive,
    Download,
    Import,
    ServerStart,
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
pub struct Progress {
    pub received: u64,
    pub total: Option<u64>,
}

/// Every failure the bootstrap page can render carries its own remedy: a
/// command the user can copy, a docs link, or both. A bare message is a bug.
#[derive(Clone, Debug, Serialize)]
pub struct Failure {
    pub kind: FailureKind,
    pub title: String,
    pub detail: String,
    pub command: Option<String>,
    pub docs: Option<String>,
    pub elevated: bool,
    pub retryable: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub phase: Phase,
    pub message: String,
    pub progress: Option<Progress>,
    pub failure: Option<Failure>,
}

impl Default for Status {
    fn default() -> Self {
        Self {
            phase: Phase::Starting,
            message: "Starting Cody…".into(),
            progress: None,
            failure: None,
        }
    }
}

impl Status {
    pub fn working(phase: Phase, message: impl Into<String>) -> Self {
        Self {
            phase,
            message: message.into(),
            progress: None,
            failure: None,
        }
    }

    pub fn measured(
        phase: Phase,
        message: impl Into<String>,
        received: u64,
        total: Option<u64>,
    ) -> Self {
        Self {
            phase,
            message: message.into(),
            progress: Some(Progress { received, total }),
            failure: None,
        }
    }

    pub fn failed(failure: Failure) -> Self {
        Self {
            phase: Phase::Failed,
            message: failure.title.clone(),
            progress: None,
            failure: Some(failure),
        }
    }
}

pub const EVENT: &str = "cody://setup-status";
