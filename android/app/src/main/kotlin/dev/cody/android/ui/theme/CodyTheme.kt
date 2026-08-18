package dev.cody.android.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * Cody tokens that M3's `ColorScheme` has no slot for.
 *
 * Not a convenience: M3 offers two on-surface tiers and Cody designs with three,
 * and Cody names a literal hover hue where M3 would draw a translucent state
 * layer. Both are real design decisions that would be lost if these were forced
 * into the nearest M3 slot (docs/android-ux.md §1.1, §1.2).
 */
@Immutable
data class CodyColors(
    val textDim: Color,
    val primaryHover: Color,
    val inkWash: Color,
    val success: Color,
    val warning: Color,
    val modified: Color,
    val renamed: Color,
    val border: Color,
)

val LocalCodyColors: ProvidableCompositionLocal<CodyColors> =
    staticCompositionLocalOf { error("CodyColors requested outside CodyTheme") }

/** The palette in force, for code that needs a token M3 cannot express. */
val LocalCodyPalette: ProvidableCompositionLocal<CodyPalette> =
    staticCompositionLocalOf { error("CodyPalette requested outside CodyTheme") }

/**
 * Radii from the web's `--radius-*` tokens.
 *
 * `extraLarge` is clamped from M3's 28.dp down to 16.dp on purpose: left at the
 * default, any stray M3 component (a bottom sheet, an extended FAB) would invent
 * a rounder corner than the design language permits.
 */
private val CodyShapes = Shapes(
    extraSmall = androidx.compose.foundation.shape.RoundedCornerShape(6.dp),
    small = androidx.compose.foundation.shape.RoundedCornerShape(8.dp),
    medium = androidx.compose.foundation.shape.RoundedCornerShape(12.dp),
    large = androidx.compose.foundation.shape.RoundedCornerShape(16.dp),
    extraLarge = androidx.compose.foundation.shape.RoundedCornerShape(16.dp),
)

/** Radius of the tool-call frame, which recurs on every turn and earns a name. */
val ToolCardRadius = 7.dp

/**
 * Builds an M3 scheme from Cody tokens.
 *
 * Every slot is assigned deliberately, including the ones Cody has no design
 * for, because an unassigned slot falls back to a Material default and injects a
 * foreign hue into a carefully verified palette. Two assignments carry the whole
 * design:
 *
 * - `surfaceTint = Transparent`, which is what neutralises M3 tonal elevation.
 *   Left at its default, every elevated card would be tinted toward the accent
 *   and the surface ladder below would stop meaning anything.
 * - the surface ladder itself, mapped straight from Cody's five background
 *   tokens rather than generated from a seed colour.
 *
 * `lightColorScheme` is the base for BOTH modes, which looks odd and is correct:
 * light/dark is already expressed by [palette], the two builders differ only in
 * the defaults they supply, and every slot with a Cody design is assigned below.
 * The only slots left at their defaults are M3's `*Fixed` accent variants, which
 * are specified to be identical in light and dark — that is what "fixed" means —
 * so the choice of base cannot affect them. (Selecting the builder with a
 * function reference is the obvious alternative and crashes the Kotlin 2.4
 * frontend on an overload-resolution assertion.)
 */
private fun codyColorScheme(palette: CodyPalette): ColorScheme =
    lightColorScheme(
        primary = palette.accent,
        onPrimary = palette.onAccent,
        primaryContainer = palette.userBg,
        onPrimaryContainer = palette.text,
        inversePrimary = palette.alternateAccent,

        // Cody has no second or third accent. Neutral chips are the correct
        // reading of a filled-tonal button here, and inventing a hue is not.
        secondary = palette.textMuted,
        onSecondary = palette.bg,
        secondaryContainer = palette.bgHover,
        onSecondaryContainer = palette.text,
        tertiary = palette.accent,
        onTertiary = palette.onAccent,
        tertiaryContainer = palette.userBg,
        onTertiaryContainer = palette.text,

        background = palette.bg,
        onBackground = palette.text,
        surface = palette.bg,
        onSurface = palette.text,
        surfaceVariant = palette.bgPanel,
        onSurfaceVariant = palette.textMuted,
        surfaceContainerLowest = palette.bg,
        surfaceContainerLow = palette.toolBg,
        surfaceContainer = palette.bgPanel,
        surfaceContainerHigh = palette.bgHover,
        surfaceContainerHighest = palette.bgSelected,
        surfaceBright = palette.bg,
        surfaceDim = palette.bgPanel,
        surfaceTint = Color.Transparent,

        inverseSurface = palette.text,
        inverseOnSurface = palette.bg,

        outline = palette.border,
        outlineVariant = palette.border,
        // Ink-tinted at 24%, matching `--overlay-backdrop`; M3's own default is
        // black at 32%.
        scrim = palette.text.copy(alpha = 0.24f),

        error = palette.statusError,
        onError = palette.onAccent,
        // 9% of the error hue over the panel surface, the same mix the web's
        // error banners use.
        errorContainer = palette.statusError.copy(alpha = 0.09f).compositeOverOpaque(palette.bgPanel),
        onErrorContainer = palette.statusError,
    )

/**
 * Flattens a translucent colour onto an opaque one.
 *
 * Done at build time rather than by stacking a translucent layer at draw time:
 * `errorContainer` is a token value, and a container that is genuinely
 * translucent would blend with whatever happened to be behind it instead.
 */
private fun Color.compositeOverOpaque(background: Color): Color = Color(
    red = red * alpha + background.red * (1f - alpha),
    green = green * alpha + background.green * (1f - alpha),
    blue = blue * alpha + background.blue * (1f - alpha),
    alpha = 1f,
)

/**
 * Cody's Material 3 theme.
 *
 * Dynamic colour is deliberately absent. Cody is a themed product whose palettes
 * are AA-verified pairings; deriving colours from the device wallpaper would
 * discard that guarantee on every device it worked on.
 */
@Composable
fun CodyTheme(
    dark: Boolean = isSystemInDarkTheme(),
    palette: CodyPalette = if (dark) CodyDarkPalette else CodyLightPalette,
    content: @Composable () -> Unit,
) {
    val scheme = remember(palette) { codyColorScheme(palette) }
    val extras = remember(palette) {
        CodyColors(
            textDim = palette.textDim,
            primaryHover = palette.accentHover,
            inkWash = palette.inkWash,
            success = palette.statusSuccess,
            warning = palette.statusWarning,
            modified = palette.statusModified,
            renamed = palette.statusRenamed,
            border = palette.border,
        )
    }
    CompositionLocalProvider(
        LocalCodyColors provides extras,
        LocalCodyPalette provides palette,
    ) {
        MaterialTheme(
            colorScheme = scheme,
            shapes = CodyShapes,
            content = content,
        )
    }
}
