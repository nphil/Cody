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

# ---- Shizuku ---------------------------------------------------------------
# Same release-only risk as the block above, and worse here: dev.rikka.shizuku:api
# ships an EMPTY consumer proguard.txt (verified against api-13.1.5.aar), and the
# AIDL artifact ships none at all. Only :provider carries rules, and only for its
# Parcelable. Everything reached across a binder or by name is therefore ours to
# keep, and a miss does not fail the build -- it ships an APK whose Logs screen
# reports "Shizuku is not running" on a device where it plainly is.
#
# The whole surface is ~35 KB of classes, so keeping it wholesale costs less than
# reasoning about which half is reflective.

# Named from AndroidManifest.xml, and it throws at attach time if its own
# attributes do not survive.
-keep class rikka.shizuku.ShizukuProvider { *; }

# Shizuku.java installs an anonymous IShizukuApplication.Stub and resolves
# IShizukuService.Stub.asInterface over the binder. Binder dispatch is by
# transaction code against a DESCRIPTOR string, so a renamed class is not
# immediately fatal -- but a pruned Stub method is, and the failure surfaces
# only on a device with Shizuku actually running.
-keep class rikka.shizuku.** { *; }
-keep interface rikka.shizuku.** { *; }
-keep class rikka.sui.** { *; }
-keep class moe.shizuku.server.** { *; }
-keep interface moe.shizuku.server.** { *; }
-keep class moe.shizuku.api.** { *; }

# HiddenApiBypass locates ART's field offsets by reading Helper.NeverCall's
# members in DECLARATION ORDER and differencing their addresses. Its own
# consumer rule keeps those members, but the arithmetic assumes the class is
# untouched, so the library is kept whole rather than trusted to survive
# whatever R8 decides to do to a 15 KB dependency.
-keep class org.lsposed.hiddenapibypass.** { *; }
-dontwarn dalvik.system.VMRuntime
-dontwarn sun.misc.Unsafe
