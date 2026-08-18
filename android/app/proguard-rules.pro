# R8 rules for the release build.
#
# kotlinx.serialization and Ktor both ship consumer rules, and both are kept
# below anyway. The reason is release-only risk: a missing rule does not fail the
# build, it produces an APK that crashes the first time it decodes a response.
# These rules are cheap; discovering the omission on a sideloaded tablet is not.

# ---- kotlinx.serialization -------------------------------------------------
# The plugin generates a `$$serializer` class per @Serializable type and reaches
# it reflectively through the `Companion`. Strip either and decoding dies.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**

-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}

-keep,includedescriptorclasses class dev.cody.**$$serializer { *; }
-keepclassmembers class dev.cody.** {
    *** Companion;
}
-keepclasseswithmembers class dev.cody.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# Sealed hierarchies are resolved by their @SerialName discriminator, so the
# subclasses must survive even where no code references them by name.
-keep class dev.cody.shared.model.ChatMessage$* { *; }
-keep class dev.cody.shared.model.ContentBlock$* { *; }

# ---- Ktor / OkHttp / coroutines -------------------------------------------
# Ktor selects its engine through a ServiceLoader and references optional
# integrations (SLF4J, Conscrypt, Bouncy Castle) it does not ship.
-dontwarn io.ktor.**
-dontwarn kotlinx.coroutines.**
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.slf4j.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

-keep class io.ktor.client.engine.okhttp.OkHttpEngineContainer { *; }
-keep class * implements io.ktor.client.HttpClientEngineContainer { *; }

# Coroutines' debug agent probes are referenced from the runtime, not from code.
-keepclassmembers class kotlinx.coroutines.** {
    volatile <fields>;
}
