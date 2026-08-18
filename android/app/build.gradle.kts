import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.compose.compiler)
}

// Version identity comes from CI, never from a file in the repo -- the desktop
// train works the same way (see .github/workflows/desktop.yml): nothing is
// committed back to main, so a release can never feed itself. Local builds get
// an obviously-fake version rather than a plausible-looking wrong one.
//
// providers.gradleProperty (not findProperty) because these are read at
// configuration time and the configuration cache must see them as inputs.
val codyVersionCode: Int = providers.gradleProperty("cody.versionCode").orNull?.toIntOrNull() ?: 1
val codyVersionName: String = providers.gradleProperty("cody.versionName").orNull ?: "0.0.0-dev"

// Release signing is opt-in via the environment. Absent secrets must not block
// the pipeline, so the release build falls back to the debug key -- see
// android/README.md for why that fallback is fine for a smoke test and NOT fine
// as an update channel.
val keystorePath: String? = providers.environmentVariable("CODY_KEYSTORE_FILE").orNull
    ?.takeIf { it.isNotBlank() }

android {
    namespace = "dev.cody.android"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "dev.cody.android"
        minSdk = libs.versions.minSdk.get().toInt()
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = codyVersionCode
        versionName = codyVersionName
    }

    androidResources {
        // Keep only the locales Cody actually ships; stops transitive androidx
        // libraries dragging 70 more languages of their own strings into the APK.
        localeFilters += listOf("en", "ja", "zh-rCN")
    }

    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = providers.environmentVariable("CODY_KEYSTORE_PASSWORD").orNull
                keyAlias = providers.environmentVariable("CODY_KEY_ALIAS").orNull
                keyPassword = providers.environmentVariable("CODY_KEY_PASSWORD").orNull
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
        debug {
            // A debug build installs alongside a release build instead of
            // fighting it for the package name.
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    buildFeatures {
        compose = true
        // Nothing reads BuildConfig; leaving it on generates a class per variant
        // for no reader.
        buildConfig = false
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources.excludes += setOf(
            "/META-INF/{AL2.0,LGPL2.1}",
            "/META-INF/versions/9/previous-compilation-data.bin",
            "DebugProbesKt.bin",
        )
    }

    lint {
        // The pipeline must not be blocked by a style opinion, but a real
        // correctness finding should be visible in the log.
        abortOnError = false
        warningsAsErrors = false
    }
}

kotlin {
    jvmToolchain(21)
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
    }
}

composeCompiler {
    // :shared is deliberately androidx-free, so its models cannot carry
    // @Immutable. This file tells the Compose compiler they are stable anyway,
    // which is the documented mechanism for exactly this case and is why the
    // transcript models need neither an androidx dependency nor
    // kotlinx.collections.immutable to avoid per-item recomposition.
    // See docs/android-ux.md §6.3.
    stabilityConfigurationFiles.add(layout.projectDirectory.file("compose-stability.conf"))

    // The §6.3 gate, off by default because it makes every Kotlin compilation
    // write two reports. Turn it on to check that nothing reachable from the
    // transcript has become unstable:
    //
    //   ./gradlew :app:compileDebugKotlin -Pcody.composeReports=true \
    //     --rerun-tasks -Pkotlin.incremental=false
    //   grep 'unstable class' app/build/compose-reports/app-classes.txt
    //   grep -A20 'fun .*ui\.chat\.' app/build/compose-reports/app-composables.txt
    //
    // Incremental compilation must be off: the reports only describe the files
    // that particular invocation compiled, so an incremental run silently
    // produces a report covering almost nothing.
    if (providers.gradleProperty("cody.composeReports").orNull.toBoolean()) {
        reportsDestination = layout.buildDirectory.dir("compose-reports")
        metricsDestination = layout.buildDirectory.dir("compose-metrics")
    }
}

dependencies {
    implementation(project(":shared"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.datastore.preferences)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons.core)
    implementation(libs.compose.ui.tooling.preview)

    // Shizuku (docs/android-ux.md §5.2). Optional at runtime in every sense:
    // the library is inert until something calls it, the provider is a no-op
    // when no Shizuku server exists to call it, and nothing on the startup path
    // touches either.
    implementation(libs.shizuku.api)
    implementation(libs.shizuku.provider)
    implementation(libs.hiddenapibypass)
    debugImplementation(libs.compose.ui.tooling)
}
