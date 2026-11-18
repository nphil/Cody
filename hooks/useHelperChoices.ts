"use client";

/**
 * The roles and models a helper agent's model can be chosen from, for
 * Settings › Models › Helper agents and the helper window's "Change model".
 *
 * The same two reads Settings › Models already makes: `/api/models` (the
 * models that reach sessions and that this person can see) and
 * `/api/model-roles` (the model each role points at). They go through the
 * settings route cache, so a second surface asking for them costs nothing.
 */
import { useMemo } from "react";
import type { HelperChoicesInput } from "@/lib/helper-agents";
import type { ModelsData } from "@/lib/models-cache";
import { useSettingsRoute } from "./useSettingsData";

const MODELS_ROUTE = "/api/models";
const ROLES_ROUTE = "/api/model-roles";

interface RolesBody {
  roles?: Record<string, string>;
  roleNames?: string[];
}

export interface HelperChoices {
  input: HelperChoicesInput;
  /** Neither read has answered yet. */
  loading: boolean;
}

export function useHelperChoices(enabled = true): HelperChoices {
  const models = useSettingsRoute<ModelsData>(MODELS_ROUTE, { enabled });
  const roles = useSettingsRoute<RolesBody>(ROLES_ROUTE, { enabled });
  const input = useMemo<HelperChoicesInput>(
    () => ({
      roleNames: roles.data?.roleNames ?? [],
      roles: roles.data?.roles ?? {},
      models: (models.data?.modelList ?? []).map(({ provider, id, name }) => ({ provider, id, name })),
    }),
    [models.data, roles.data],
  );
  return { input, loading: (models.loading && !models.data) || (roles.loading && !roles.data) };
}
