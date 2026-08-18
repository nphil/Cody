package dev.cody.android.ui.onboarding

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.cody.android.R
import dev.cody.android.ui.common.onboardingMessage
import dev.cody.shared.presentation.OnboardingMode
import dev.cody.shared.presentation.OnboardingModel

/**
 * Server address plus credential.
 *
 * Sign-in is the default mode rather than paste-a-token: typing a 40-character
 * secret on a touch keyboard is the worst onboarding available, and the server
 * can mint the token itself from a password. Pasting stays available because it
 * is the only option when the account is SSO-shaped or the password is not to
 * hand.
 */
@Composable
fun OnboardingScreen(
    model: OnboardingModel,
    modifier: Modifier = Modifier,
) {
    val state by model.state.collectAsStateWithLifecycle()
    var passwordVisible by remember { mutableStateOf(false) }
    val signingIn = state.mode == OnboardingMode.SignIn

    Surface(modifier = modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(
                modifier = Modifier.widthIn(max = 460.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text(
                    text = stringResource(R.string.onboarding_title),
                    style = MaterialTheme.typography.headlineSmall,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    text = stringResource(R.string.onboarding_subtitle),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                OutlinedTextField(
                    value = state.address,
                    onValueChange = model::setAddress,
                    label = { Text(stringResource(R.string.onboarding_address_label)) },
                    placeholder = { Text(stringResource(R.string.onboarding_address_hint)) },
                    supportingText = { Text(stringResource(R.string.onboarding_address_help)) },
                    singleLine = true,
                    enabled = !state.checking,
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Uri,
                        imeAction = ImeAction.Next,
                        autoCorrectEnabled = false,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(
                        selected = signingIn,
                        onClick = { model.setMode(OnboardingMode.SignIn) },
                        enabled = !state.checking,
                        label = { Text(stringResource(R.string.onboarding_mode_sign_in)) },
                    )
                    FilterChip(
                        selected = !signingIn,
                        onClick = { model.setMode(OnboardingMode.PasteToken) },
                        enabled = !state.checking,
                        label = { Text(stringResource(R.string.onboarding_mode_paste_token)) },
                    )
                }

                if (signingIn) {
                    OutlinedTextField(
                        value = state.username,
                        onValueChange = model::setUsername,
                        label = { Text(stringResource(R.string.onboarding_username)) },
                        singleLine = true,
                        enabled = !state.checking,
                        keyboardOptions = KeyboardOptions(
                            imeAction = ImeAction.Next,
                            autoCorrectEnabled = false,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = state.password,
                        onValueChange = model::setPassword,
                        label = { Text(stringResource(R.string.onboarding_password)) },
                        supportingText = { Text(stringResource(R.string.onboarding_sign_in_help)) },
                        singleLine = true,
                        enabled = !state.checking,
                        visualTransformation = if (passwordVisible) {
                            VisualTransformation.None
                        } else {
                            PasswordVisualTransformation()
                        },
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Password,
                            imeAction = ImeAction.Go,
                        ),
                        keyboardActions = KeyboardActions(onGo = { model.connect() }),
                        trailingIcon = {
                            TextButton(onClick = { passwordVisible = !passwordVisible }) {
                                Text(
                                    stringResource(
                                        if (passwordVisible) {
                                            R.string.onboarding_hide_password
                                        } else {
                                            R.string.onboarding_show_password
                                        },
                                    ),
                                    style = MaterialTheme.typography.labelSmall,
                                )
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    )
                } else {
                    OutlinedTextField(
                        value = state.token,
                        onValueChange = model::setToken,
                        label = { Text(stringResource(R.string.onboarding_token)) },
                        supportingText = { Text(stringResource(R.string.onboarding_token_help)) },
                        enabled = !state.checking,
                        // Deliberately NOT single-line and NOT a password field: a
                        // pasted token must be visible to be checked, and it is a
                        // long opaque string that wraps.
                        maxLines = 3,
                        keyboardOptions = KeyboardOptions(
                            imeAction = ImeAction.Go,
                            autoCorrectEnabled = false,
                        ),
                        keyboardActions = KeyboardActions(onGo = { model.connect() }),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                state.failure?.let { failure ->
                    Text(
                        text = onboardingMessage(failure, signingIn),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error,
                    )
                }

                Spacer(Modifier.height(8.dp))

                Button(
                    onClick = model::connect,
                    enabled = !state.checking,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (state.checking) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            color = MaterialTheme.colorScheme.onPrimary,
                        )
                        Spacer(Modifier.size(12.dp))
                    }
                    Text(
                        stringResource(
                            if (state.checking) R.string.onboarding_checking else R.string.onboarding_connect,
                        ),
                    )
                }
            }
        }
    }
}
