// Root build script: declares the plugin versions the modules apply, nothing
// else. No allprojects/subprojects blocks -- they fight the configuration cache
// and hide per-module intent.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.kotlin.multiplatform.library) apply false
    alias(libs.plugins.kotlin.multiplatform) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.compose.compiler) apply false
}
