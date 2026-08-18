package dev.cody.android.ui.common

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.cody.android.R
import dev.cody.android.ui.theme.LocalCodyColors
import dev.cody.shared.backend.BackendFailure
import dev.cody.shared.presentation.OnboardingFailure

/**
 * Top bar height, from the web's own toolbar.
 *
 * 48dp, not M3's 64dp: this is a dense developer tool on a tablet, and every
 * vertical pixel the chrome takes is a pixel of transcript. M3's `TopAppBar` has
 * a fixed height, so the bar is a plain Row instead of a fight with the
 * component (docs/android-ux.md §2.4).
 */
val CodyTopBarHeight = 48.dp

@Composable
fun CodyTopBar(
    modifier: Modifier = Modifier,
    // RowScope, so `Modifier.weight(1f)` inside the bar means "share the bar's
    // width" rather than resolving against whatever Column happens to enclose the
    // call site. Source-compatible: a content lambda that ignores the receiver is
    // unaffected.
    content: @Composable RowScope.() -> Unit,
) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surfaceContainer,
        // tonalElevation stays 0: the surface ladder, not a tint, expresses depth.
        tonalElevation = 0.dp,
    ) {
        Column {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(CodyTopBarHeight)
                    .padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                content = content,
            )
            Hairline()
        }
    }
}

/** Cody has exactly one border tier, so hairlines are one composable. */
@Composable
fun Hairline(modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .height(1.dp),
        color = LocalCodyColors.current.border,
        content = {},
    )
}

/** Centred message with an optional action: the empty/error/loading pane. */
@Composable
fun StatusPane(
    message: String,
    modifier: Modifier = Modifier,
    busy: Boolean = false,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .padding(24.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
            modifier = Modifier.widthIn(max = 420.dp),
        ) {
            if (busy) {
                CircularProgressIndicator(
                    modifier = Modifier.size(28.dp),
                    color = MaterialTheme.colorScheme.primary,
                )
            }
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            if (actionLabel != null && onAction != null) {
                Button(onClick = onAction) { Text(actionLabel) }
            }
        }
    }
}

/** A small round status dot, e.g. "this session has a live engine". */
@Composable
fun StatusDot(
    color: androidx.compose.ui.graphics.Color,
    modifier: Modifier = Modifier,
    size: androidx.compose.ui.unit.Dp = 8.dp,
) {
    Surface(
        modifier = modifier.size(size),
        shape = CircleShape,
        color = color,
        content = {},
    )
}

/**
 * The user-facing text for a backend failure.
 *
 * Localisation lives here rather than in `:shared` because the presentation
 * models must not know about Android resources. `code` is consulted first: the
 * server distinguishes cases that share a status, and "you already have 32
 * tokens" is a different instruction from a generic "forbidden".
 */
@Composable
fun failureMessage(failure: BackendFailure, code: String? = null): String = when {
    code == "bearer_forbidden" -> stringResource(R.string.error_bearer_forbidden)
    code == "token_limit" -> stringResource(R.string.error_token_limit)
    failure == BackendFailure.Unauthorized -> stringResource(R.string.error_token_rejected)
    failure == BackendFailure.Forbidden -> stringResource(R.string.error_forbidden)
    failure == BackendFailure.NotFound -> stringResource(R.string.error_not_found)
    failure == BackendFailure.RateLimited -> stringResource(R.string.error_rate_limited)
    failure == BackendFailure.Unreachable -> stringResource(R.string.error_unreachable)
    failure == BackendFailure.Malformed -> stringResource(R.string.error_malformed)
    else -> stringResource(R.string.error_server)
}

/** The onboarding screen's own failure vocabulary, which includes field checks. */
@Composable
fun onboardingMessage(failure: OnboardingFailure, signingIn: Boolean): String = when (failure) {
    OnboardingFailure.UnusableAddress -> stringResource(R.string.error_address_unusable)
    OnboardingFailure.MissingToken -> stringResource(R.string.error_token_missing)
    OnboardingFailure.MissingCredentials -> stringResource(R.string.error_credentials_missing)
    is OnboardingFailure.Rejected -> when {
        // A 401 while signing in means a wrong password, NOT a dead token; the
        // generic message would send the user hunting for the wrong problem.
        failure.failure == BackendFailure.Unauthorized && signingIn ->
            stringResource(R.string.error_sign_in_rejected)
        else -> failureMessage(failure.failure, failure.code)
    }
}
