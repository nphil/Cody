// Cody's Android client is a SEPARATE Gradle build rooted at android/, not part
// of the Next.js workspace: `npm run dev` must never see a Gradle daemon and
// `./gradlew` must never walk node_modules. The only thing the two halves share
// is the server's HTTP API, mirrored by hand in :shared.

pluginManagement {
    repositories {
        // CONTENT-FILTERED, and that matters on a cold CI cache: without the
        // filter Gradle asks dl.google.com for every kotlin/ktor coordinate
        // before falling through to Maven Central.
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    // Modules declare no repositories of their own; a stray repository inside a
    // module is the usual way a build stops being reproducible.
    repositoriesMode = RepositoriesMode.FAIL_ON_PROJECT_REPOS
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
    }
}

rootProject.name = "cody-android"

include(":app")
include(":shared")
