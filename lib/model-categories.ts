/**
 * Small, display-only model families used by the per-provider curation UI.
 *
 * The OMP catalog currently exposes an id, name, and provider, but no stable
 * category field. Keep the inference narrow and explicit so a new provider
 * model is never silently assigned to a made-up size or capability group.
 */
export const MODEL_CATEGORY_OPTIONS = ["SWE", "Fusion", "Other"] as const;
export type ModelCategory = (typeof MODEL_CATEGORY_OPTIONS)[number];

function categoryText(model: { id: string; name?: string | null }): string {
  return `${model.id} ${model.name ?? ""}`
    .toLowerCase()
    .replace(/[\-_]+/g, " ");
}

/** Returns every matching family; a model can belong to more than one. */
export function modelCategories(model: { id: string; name?: string | null }): ModelCategory[] {
  const text = categoryText(model);
  const categories: ModelCategory[] = [];

  // Match the whole SWE family, including versioned ids such as swe-1.6,
  // swe1.7, and swe-2, without treating words such as "sweeper" as SWE.
  if (/\bswe(?:\s*[-_]?\s*\d+(?:\.\d+)*)?\b/.test(text)) categories.push("SWE");
  if (/\bfusion\b/.test(text)) categories.push("Fusion");

  return categories.length > 0 ? categories : ["Other"];
}

/** Assign overlapping models to Fusion so a SWE-only filter excludes them. */
export function modelCategoryBucket(model: { id: string; name?: string | null }): ModelCategory {
  const categories = modelCategories(model);
  if (categories.includes("Fusion")) return "Fusion";
  return categories[0];
}

/** A multi-select category filter is a union of the exclusive display buckets. */
export function modelMatchesCategories(
  model: { id: string; name?: string | null },
  selected: ReadonlySet<ModelCategory>,
): boolean {
  return selected.size === 0 || selected.has(modelCategoryBucket(model));
}
