import { STORAGE_KEYS } from "./storage-keys";

export const THEME_STORAGE_KEY = STORAGE_KEYS.theme;

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
 * Cody ships ten visual families drawn from the palettes developer tooling made
 * familiar, each with a true light and dark counterpart. The pairing keeps the
 * mode toggle useful without reducing the picker to a light/dark-only control;
 * `app/globals.css` carries one token block per id listed here.
 */
export const THEMES = [
  theme("catppuccin-light", "catppuccin", "Catppuccin", "light", "#EFF1F5", "#E6E9EF", "#8839EF"),
  theme("nord-light", "nord", "Nord", "light", "#E5E9F0", "#DCE2EC", "#3F6791"),
  theme("tokyo-light", "tokyo", "Tokyo Night", "light", "#E1E2E7", "#D8DAE3", "#1A5FBF"),
  theme("gruvbox-light", "gruvbox", "Gruvbox", "light", "#FBF1C7", "#F2E5BC", "#AF3A03"),
  theme("rosepine-light", "rosepine", "Rosé Pine", "light", "#FAF4ED", "#F4EDE4", "#9B4E67"),
  theme("everforest-light", "everforest", "Everforest", "light", "#F3EAD3", "#EAE4CA", "#61710A"),
  theme("solarized-light", "solarized", "Solarized", "light", "#FDF6E3", "#EEE8D5", "#0F6E6A"),
  theme("ayu-light", "ayu", "Ayu", "light", "#FCFCFC", "#F3F2EF", "#A94E00"),
  theme("one-light", "one", "One", "light", "#FAFAFA", "#EFEFF1", "#2F66DB"),
  theme("dracula-light", "dracula", "Dracula", "light", "#FFFBEB", "#F6F1DE", "#A3144D"),
  theme("catppuccin-dark", "catppuccin", "Catppuccin", "dark", "#1E1E2E", "#272739", "#CBA6F7"),
  theme("nord-dark", "nord", "Nord", "dark", "#2E3440", "#3B4252", "#88C0D0"),
  theme("tokyo-dark", "tokyo", "Tokyo Night", "dark", "#1A1B26", "#24283B", "#7AA2F7"),
  theme("gruvbox-dark", "gruvbox", "Gruvbox", "dark", "#282828", "#32302F", "#FE8019"),
  theme("rosepine-dark", "rosepine", "Rosé Pine", "dark", "#232136", "#2A273F", "#EA9A97"),
  theme("everforest-dark", "everforest", "Everforest", "dark", "#2D353B", "#343F44", "#A7C080"),
  theme("solarized-dark", "solarized", "Solarized", "dark", "#002B36", "#073642", "#2AA198"),
  theme("ayu-dark", "ayu", "Ayu", "dark", "#1F2430", "#272D3B", "#FFCC66"),
  theme("one-dark", "one", "One", "dark", "#282C34", "#2F343E", "#61AFEF"),
  theme("dracula-dark", "dracula", "Dracula", "dark", "#282A36", "#343746", "#FF79C6"),
] as const satisfies readonly ThemeDefinition[];

export type ThemeId = (typeof THEMES)[number]["id"];

export const DEFAULT_THEME_ID: ThemeId = "catppuccin-light";

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
