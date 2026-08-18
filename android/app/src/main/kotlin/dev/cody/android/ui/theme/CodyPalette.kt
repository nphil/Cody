package dev.cody.android.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * One Cody theme's semantic tokens — the Android side of a `:root` /
 * `html[data-theme=...]` block in `app/globals.css`.
 *
 * A data class rather than a hard-coded palette because Cody ships ten families
 * × light/dark and the token NAMES are the contract while the values are data
 * (docs/android-ux.md §1). Adding the remaining families is adding entries here;
 * nothing downstream changes.
 */
data class CodyPalette(
    val id: String,
    val isDark: Boolean,
    /** `--bg`: the page. */
    val bg: Color,
    /** `--tool-bg`: half a step off the page. */
    val toolBg: Color,
    /** `--bg-panel`: rails, panels, toolbars. */
    val bgPanel: Color,
    /** `--bg-hover`. */
    val bgHover: Color,
    /** `--bg-selected`: selected row, active tab. */
    val bgSelected: Color,
    /** `--border`: 1px hairlines. Cody has exactly one border tier. */
    val border: Color,
    /** `--text`: AA-verified against [bg]. */
    val text: Color,
    /** `--text-muted`. */
    val textMuted: Color,
    /** `--text-dim`: Cody's third on-surface tier, which M3 has no slot for. */
    val textDim: Color,
    /** `--accent` / `--accent-strong`. */
    val accent: Color,
    /** `--accent-hover`: a distinct hue, NOT a state layer over [accent]. */
    val accentHover: Color,
    /** `--on-accent`. */
    val onAccent: Color,
    /** `--user-bg`: the user bubble. */
    val userBg: Color,
    /** `--bg-subtle`: 5% ink wash for expanded args and inline chips. */
    val inkWash: Color,
    val statusError: Color,
    val statusSuccess: Color,
    val statusWarning: Color,
    val statusModified: Color,
    val statusRenamed: Color,
    /**
     * Accent of this family's opposite-mode sibling, for M3's `inversePrimary`.
     * Real data, from the light/dark pairing the web's theme catalog already
     * defines — not an invented hue.
     */
    val alternateAccent: Color,
)

/** Cody's shipped default light theme (Catppuccin Latte), from `:root`. */
val CodyLightPalette: CodyPalette = CodyPalette(
    id = "catppuccin-light",
    isDark = false,
    bg = Color(0xFFEFF1F5),
    toolBg = Color(0xFFEAEDF2),
    bgPanel = Color(0xFFE6E9EF),
    bgHover = Color(0xFFDCE0E8),
    bgSelected = Color(0xFFCCD0DA),
    border = Color(0xFFBCC0CC),
    text = Color(0xFF4C4F69),
    textMuted = Color(0xFF5C5F77),
    textDim = Color(0xFF6C6F85),
    accent = Color(0xFF8839EF),
    accentHover = Color(0xFF7526DC),
    onAccent = Color(0xFFFFFFFF),
    userBg = Color(0xFFE9E2F7),
    // rgba(76,79,105,0.05)
    inkWash = Color(0x0D4C4F69),
    statusError = Color(0xFFD20F39),
    statusSuccess = Color(0xFF2F7D1E),
    statusWarning = Color(0xFF9C6500),
    statusModified = Color(0xFFC4510A),
    statusRenamed = Color(0xFF1E66F5),
    alternateAccent = Color(0xFFCBA6F7),
)

/** Cody's shipped default dark theme (Catppuccin Mocha), from `html.dark`. */
val CodyDarkPalette: CodyPalette = CodyPalette(
    id = "catppuccin-dark",
    isDark = true,
    bg = Color(0xFF1E1E2E),
    toolBg = Color(0xFF232335),
    bgPanel = Color(0xFF272739),
    bgHover = Color(0xFF313244),
    bgSelected = Color(0xFF3E4055),
    border = Color(0xFF3B3D52),
    text = Color(0xFFCDD6F4),
    textMuted = Color(0xFFA6ADC8),
    textDim = Color(0xFF9399B2),
    accent = Color(0xFFCBA6F7),
    accentHover = Color(0xFFDDC2FF),
    onAccent = Color(0xFF1E1E2E),
    userBg = Color(0xFF2B2A42),
    // rgba(205,214,244,0.05)
    inkWash = Color(0x0DCDD6F4),
    statusError = Color(0xFFF38BA8),
    statusSuccess = Color(0xFFA6E3A1),
    statusWarning = Color(0xFFF9E2AF),
    statusModified = Color(0xFFFAB387),
    statusRenamed = Color(0xFF89B4FA),
    alternateAccent = Color(0xFF8839EF),
)
