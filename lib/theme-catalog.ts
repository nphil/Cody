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
 * Cody ships twenty visual families drawn from the palettes developer tooling
 * made familiar, each with a true light and dark counterpart. The pairing keeps
 * the mode toggle useful without reducing the picker to a light/dark-only
 * control; `app/globals.css` carries one token block per id listed here.
 *
 * Every family is inspired by its namesake, not a verbatim port: values are
 * adapted for Cody's token set and the WCAG floors globals.css documents, and
 * a family pairs an in-house light or dark counterpart wherever its namesake
 * offers only one mode.
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
  theme("monokai-light", "monokai", "Monokai", "light", "#FAF4F2", "#F1EBE9", "#BA1A5C"),
  theme("github-light", "github", "GitHub", "light", "#FFFFFF", "#F6F8FA", "#0969DA"),
  theme("kanagawa-light", "kanagawa", "Kanagawa", "light", "#F2ECBC", "#E9E2A9", "#624C83"),
  theme("flexoki-light", "flexoki", "Flexoki", "light", "#FFFCF0", "#F2F0E5", "#AF3029"),
  theme("cobalt-light", "cobalt", "Cobalt", "light", "#EAF2F9", "#DEE9F3", "#8A6100"),
  theme("synthwave-light", "synthwave", "Synthwave '84", "light", "#F9F1F7", "#F0E5EE", "#0B7671"),
  theme("vitesse-light", "vitesse", "Vitesse", "light", "#FBFBF8", "#F2F2ED", "#1C6B48"),
  theme("horizon-light", "horizon", "Horizon", "light", "#FDF0ED", "#F6E4E0", "#B3244A"),
  theme("graphite-light", "graphite", "Graphite", "light", "#F5F5F5", "#ECECEC", "#171717"),
  theme("zenburn-light", "zenburn", "Zenburn", "light", "#EBEADB", "#E1E0CF", "#8E4949"),
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
  theme("monokai-dark", "monokai", "Monokai", "dark", "#2D2A2E", "#37343A", "#FF6188"),
  theme("github-dark", "github", "GitHub", "dark", "#0D1117", "#161B22", "#58A6FF"),
  theme("kanagawa-dark", "kanagawa", "Kanagawa", "dark", "#1F1F28", "#2A2A37", "#9B86BD"),
  theme("flexoki-dark", "flexoki", "Flexoki", "dark", "#100F0F", "#1C1B1A", "#D8564A"),
  theme("cobalt-dark", "cobalt", "Cobalt", "dark", "#193549", "#1F3F56", "#FFC600"),
  theme("synthwave-dark", "synthwave", "Synthwave '84", "dark", "#262335", "#2E2A44", "#36F9F6"),
  theme("vitesse-dark", "vitesse", "Vitesse", "dark", "#121212", "#1B1B1B", "#4D9375"),
  theme("horizon-dark", "horizon", "Horizon", "dark", "#1C1E26", "#232530", "#E95678"),
  theme("graphite-dark", "graphite", "Graphite", "dark", "#161616", "#1F1F1F", "#FAFAFA"),
  theme("zenburn-dark", "zenburn", "Zenburn", "dark", "#3F3F3F", "#464646", "#DCA3A3"),
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
