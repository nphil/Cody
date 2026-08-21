export type SkillInstallScope = "global" | "project";

export interface SkillInstallInfo {
  package: string;
  scope: SkillInstallScope;
  source: string;
  sourceType?: string;
  skillsShUrl?: string;
  skillPath?: string;
  ref?: string;
  versionHash?: string;
  canCheckForUpdates: boolean;
}

export type SkillUpdateState =
  | "up-to-date"
  | "update-available"
  | "unsupported"
  | "error";

export interface SkillUpdateResult {
  package: string;
  scope: SkillInstallScope;
  state: SkillUpdateState;
  currentVersion?: string;
  latestVersion?: string;
  message?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  sourceInfo: {
    source?: string;
    scope?: string;
  };
  install?: SkillInstallInfo;
}

export type PluginScope = "global" | "project";
export type PluginResourceKind = "extension" | "skill" | "prompt" | "theme";

export interface PluginResourceCounts {
  extensions: number;
  skills: number;
  prompts: number;
  themes: number;
}

export interface PluginDiagnostic {
  type: "warning" | "error";
  message: string;
  source?: string;
  path?: string;
}

export interface PluginResourceInfo {
  kind: PluginResourceKind;
  name: string;
  path: string;
  relativePath: string;
}

export interface PluginPackageInfo {
  source: string;
  scope: PluginScope;
  filtered: boolean;
  disabled: boolean;
  installedPath?: string;
  packageName?: string;
  version?: string;
  configuredVersion?: string;
  counts: PluginResourceCounts;
  resources: PluginResourceInfo[];
  status: "loaded" | "installed" | "missing" | "disabled";
}

export interface PluginsResponse {
  packages: PluginPackageInfo[];
  totals: PluginResourceCounts;
  diagnostics: PluginDiagnostic[];
}

export type MarketplaceSourceType = "github" | "git" | "url" | "local";

export interface MarketplaceListEntry {
  name: string;
  sourceUri: string;
  sourceType: MarketplaceSourceType;
  updatedAt: string;
  /** The catalog file at this marketplace's catalogPath is missing/unreadable
   * — offer "update marketplace" rather than showing zero plugins as final. */
  catalogMissing?: boolean;
}

export interface MarketplacePluginListing {
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  author?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  category?: string;
  keywords?: string[];
  tags?: string[];
  installed: boolean;
  installedScope?: PluginScope;
  enabled?: boolean;
  installedVersion?: string;
  /** Installed version differs from the catalog's current version. */
  updateAvailable?: boolean;
}

export interface MarketplaceBrowseResponse {
  marketplaces: MarketplaceListEntry[];
  plugins: MarketplacePluginListing[];
}
