plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.android.kotlin.multiplatform.library)
    alias(libs.plugins.kotlin.serialization)
}

// The portability half of "one UI, two backends": everything in commonMain is
// models, the backend interface, and presentation state. It depends on kotlinx
// and ktor ONLY -- no androidx, no android.* -- so a future Compose-Multiplatform
// or iOS target compiles it unchanged. The `jvm()` target is not decoration: it
// is what lets the wire-format tests run on a plain JVM (and in CI) without an
// emulator, and it keeps "no Android APIs leaked into commonMain" honest by
// making a violation a compile error rather than a code-review question.
kotlin {
    jvm()

    // `android { }`, not the deprecated `androidLibrary { }`: AGP 9.3 renamed
    // the KMP Android target block and warns on the old name.
    android {
        namespace = "dev.cody.shared"
        compileSdk = libs.versions.compileSdk.get().toInt()
        minSdk = libs.versions.minSdk.get().toInt()
    }

    // Explicit API mode: :shared is consumed by :app as a library, so every
    // public declaration must state its visibility and return type.
    explicitApi()

    sourceSets {
        commonMain.dependencies {
            implementation(libs.kotlinx.coroutines.core)
            // `api`, not `implementation`: JsonObject/JsonElement appear in the
            // public surface of tool-call blocks, and HttpClient configuration belongs to
            // callers that build a backend.
            api(libs.kotlinx.serialization.json)
            api(libs.ktor.client.core)
            implementation(libs.ktor.client.content.negotiation)
            implementation(libs.ktor.serialization.kotlinx.json)
        }
        // OkHttp on both targets: one HTTP stack to reason about, and it is the
        // engine Android ships against anyway.
        androidMain.dependencies { implementation(libs.ktor.client.okhttp) }
        jvmMain.dependencies { implementation(libs.ktor.client.okhttp) }

        jvmTest.dependencies {
            implementation(libs.kotlin.test)
            implementation(libs.kotlinx.coroutines.test)
            implementation(libs.ktor.client.mock)
        }
    }
}
