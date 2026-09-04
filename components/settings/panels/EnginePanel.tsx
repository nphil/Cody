"use client";

/**
 * Settings › Behavior: how the engine works. One page, two layers, one key
 * space:
 *
 *   - Recommended (gate `configEditor`): `RECOMMENDED_CARDS`, each bound at
 *     render time to the engine's own schema row — or, for the few keys the
 *     engine keeps config-file only, to the `CURATED_ONLY` table.
 *   - All settings (gate `nativeSettings`): the complete schema list, in the
 *     engine's tabs and groups; keys a card owns stay listed and wear an
 *     "Also under Recommended" chip.
 *
 * pi and Hermes have no config editor, so they get the complete list alone.
 * Both layers read one cached body (`useSchemaIndex`) and write through
 * the config writer, reporting to this panel's save corner.
 */
import { RecommendedSettings } from "../engine/RecommendedSettings";
import { SchemaSettingsList } from "../engine/SchemaSettingsList";
import { ENGINE_PANEL_ID } from "../engine/recommended-cards";
import { SaveStatusCorner } from "../SaveStatus";
import { useSettingsShell } from "../shell-context";

export { ENGINE_PANEL_ID, SEARCH_ENTRIES } from "../engine/recommended-cards";

export function EnginePanel() {
  const { capabilities } = useSettingsShell();
  const recommended = capabilities.configEditor;
  const complete = capabilities.nativeSettings;
  return (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <div style={{ padding: "0 20px" }}>
        <SaveStatusCorner panelId={ENGINE_PANEL_ID} />
      </div>
      {recommended && <RecommendedSettings />}
      {complete && (
        <div style={recommended ? { borderTop: "1px solid var(--border)" } : undefined}>
          <SchemaSettingsList />
        </div>
      )}
    </div>
  );
}
