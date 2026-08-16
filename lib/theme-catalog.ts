export const THEME_STORAGE_KEY = "cody-theme";

export type ThemeMode = "light" | "dark";

export interface ThemeDefinition {
  id: string;
  family: string;
  name: string;
  mode: ThemeMode;
  preview: {
    background: string;
    surface: string;
    accent: string;
  };
}

const theme = <Id extends string>(
  id: Id,
  family: string,
  name: string,
  mode: ThemeMode,
  background: string,
  surface: string,
  accent: string,
): ThemeDefinition & { id: Id } => ({ id, family, name, mode, preview: { background, surface, accent } });

/**
 * Cody ships ten visual families, each with a deliberate light and dark
 * counterpart. The paired families keep the command-palette mode toggle useful
 * without reducing the picker to a light/dark-only control.
 */
export const THEMES = [
  theme("canvas-light", "canvas", "Canvas", "light", "#FAF9F6", "#F2F0EA", "#B03E22"),
  theme("paper-light", "paper", "Paper", "light", "#FFFFFF", "#F4F5F7", "#465FFF"),
  theme("mist-light", "mist", "Mist", "light", "#F7FAFC", "#EDF2F7", "#2563EB"),
  theme("sage-light", "sage", "Sage", "light", "#F7FAF6", "#EDF4ED", "#217A55"),
  theme("lilac-light", "lilac", "Lilac", "light", "#FAF8FF", "#F1EDFB", "#7C3AED"),
  theme("rose-light", "rose", "Rose", "light", "#FFF8FA", "#FCEEF2", "#BE185D"),
  theme("sand-light", "sand", "Sand", "light", "#FCFAF5", "#F4F0E5", "#A16207"),
  theme("mint-light", "mint", "Mint", "light", "#F4FBF9", "#E7F6F1", "#047857"),
  theme("sky-light", "sky", "Sky", "light", "#F5FAFF", "#E7F3FF", "#0369A1"),
  theme("copper-light", "copper", "Copper", "light", "#FCF8F4", "#F5ECE3", "#B45309"),
  theme("canvas-dark", "canvas", "Canvas", "dark", "#1B1916", "#231F1B", "#E07B54"),
  theme("paper-dark", "paper", "Paper", "dark", "#17191D", "#20232A", "#8B9BFF"),
  theme("mist-dark", "mist", "Mist", "dark", "#111827", "#1B2535", "#60A5FA"),
  theme("sage-dark", "sage", "Sage", "dark", "#121A16", "#1A2920", "#5DCE96"),
  theme("lilac-dark", "lilac", "Lilac", "dark", "#171321", "#221C31", "#B99CFF"),
  theme("rose-dark", "rose", "Rose", "dark", "#20141A", "#2C1B24", "#FB8DB7"),
  theme("sand-dark", "sand", "Sand", "dark", "#1D1912", "#292319", "#F2BA63"),
  theme("mint-dark", "mint", "Mint", "dark", "#10201B", "#173028", "#5ED7B0"),
  theme("sky-dark", "sky", "Sky", "dark", "#101D27", "#172B3A", "#63B7F1"),
  theme("copper-dark", "copper", "Copper", "dark", "#211712", "#302019", "#F0A46B"),
] as const satisfies readonly ThemeDefinition[];

export type ThemeId = (typeof THEMES)[number]["id"];

export const DEFAULT_THEME_ID: ThemeId = "canvas-light";

const byId = Object.fromEntries(THEMES.map((item) => [item.id, item])) as Record<ThemeId, ThemeDefinition>;

export function isThemeId(value: string | null): value is ThemeId {
  return value !== null && value in byId;
}

export function getTheme(id: string | null | undefined): ThemeDefinition {
  return (id ? byId[id as ThemeId] : undefined) ?? byId[DEFAULT_THEME_ID];
}

export function getAlternateTheme(id: ThemeId): (typeof THEMES)[number] {
  const current = byId[id] as (typeof THEMES)[number];
  return THEMES.find((item) => item.family === current.family && item.mode !== current.mode) ?? current;
}

export function themeModesById(): Record<string, ThemeMode> {
  return Object.fromEntries(THEMES.map((item) => [item.id, item.mode]));
}
