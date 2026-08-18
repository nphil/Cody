package dev.cody.android.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import dev.cody.android.R
import dev.cody.android.ui.common.failureMessage
import dev.cody.shared.backend.BackendFailure

/**
 * Creates a session, which on this API means choosing the directory the agent will
 * work in.
 *
 * The path is typed rather than browsed on purpose: the server exposes a file API,
 * but a picker is a workspace-tools screen and this dialog is not it. Prefilled
 * with the currently-open session's project root, which is the answer nine times
 * out of ten.
 *
 * @param suggestedCwd prefill; may be empty when nothing is open.
 * @param busy a create is in flight — the request has left, so both buttons lock.
 * @param failure why the last attempt failed, shown in place rather than as a
 *   toast: the dialog is still open and the user still has the path they typed.
 */
@Composable
fun NewSessionDialog(
    suggestedCwd: String,
    busy: Boolean,
    failure: BackendFailure?,
    onDismiss: () -> Unit,
    onCreate: (String) -> Unit,
) {
    var cwd by remember(suggestedCwd) { mutableStateOf(suggestedCwd) }

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(stringResource(R.string.session_new)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    text = stringResource(R.string.session_new_explain),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = cwd,
                    onValueChange = { cwd = it },
                    label = { Text(stringResource(R.string.session_new_cwd)) },
                    enabled = !busy,
                    singleLine = true,
                    // Monospace, and no autocorrect: this is a filesystem path, and
                    // an IME that capitalises or "fixes" it produces a directory
                    // that does not exist.
                    textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                    keyboardOptions = KeyboardOptions(
                        autoCorrectEnabled = false,
                        imeAction = ImeAction.Done,
                    ),
                )
                if (failure != null) {
                    Text(
                        text = failureMessage(failure),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onCreate(cwd) },
                enabled = !busy && cwd.isNotBlank(),
            ) {
                if (busy) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        color = MaterialTheme.colorScheme.primary,
                    )
                } else {
                    Text(stringResource(R.string.session_new_create))
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !busy) {
                Text(stringResource(R.string.action_cancel))
            }
        },
    )
}
