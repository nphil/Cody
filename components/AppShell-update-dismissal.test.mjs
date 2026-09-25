import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const readSource = (file) => readFile(new URL(`./${file}`, import.meta.url), "utf8");

const [appShellSource, toastSource] = await Promise.all([
  readSource("AppShell.tsx"),
  readSource("ui/toast.tsx"),
]);

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { readDismissedUpdateVersion, rememberDismissedUpdateVersion } = await jiti.import("./AppShell.tsx");

test("dismissed update versions use guarded browser storage", () => {
  const originalWindow = globalThis.window;
  const values = new Map();

  try {
    globalThis.window = {
      localStorage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
      },
    };

    assert.equal(readDismissedUpdateVersion("cody:dismissed-app-update"), null);
    rememberDismissedUpdateVersion("cody:dismissed-app-update", "0.18.2");
    assert.equal(readDismissedUpdateVersion("cody:dismissed-app-update"), "0.18.2");

    // A later version is not suppressed by the earlier dismissal.
    assert.notEqual(readDismissedUpdateVersion("cody:dismissed-app-update"), "0.18.3");

    globalThis.window.localStorage = {
      getItem: () => { throw new Error("storage unavailable"); },
      setItem: () => { throw new Error("storage unavailable"); },
    };
    assert.equal(readDismissedUpdateVersion("cody:dismissed-app-update"), null);
    assert.doesNotThrow(() => rememberDismissedUpdateVersion("cody:dismissed-app-update", "0.18.3"));
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("update probes skip the same version and persist through the toast close lifecycle", () => {
  assert.match(appShellSource, /const DISMISSED_OMP_UPDATE_STORAGE_KEY = "cody:dismissed-omp-update"/);
  assert.match(appShellSource, /const DISMISSED_APP_UPDATE_STORAGE_KEY = "cody:dismissed-app-update"/);
  assert.match(appShellSource, /readDismissedUpdateVersion\(DISMISSED_OMP_UPDATE_STORAGE_KEY\) === version/);
  assert.match(appShellSource, /readDismissedUpdateVersion\(DISMISSED_APP_UPDATE_STORAGE_KEY\) === version/);
  assert.match(appShellSource, /onClose: \(\) => rememberDismissedUpdateVersion\(DISMISSED_OMP_UPDATE_STORAGE_KEY, version\)/);
  assert.match(appShellSource, /onClose: \(\) => rememberDismissedUpdateVersion\(DISMISSED_APP_UPDATE_STORAGE_KEY, version\)/);

  // Base UI calls ToastObject.onClose for timeout-driven closes as well as the
  // close button; the implementation documents and deliberately preserves
  // that behavior while retaining Cody's existing 4s provider timeout.
  assert.match(toastSource, /onClose\?: \(\) => void;/);
  assert.match(toastSource, /options\?\.onClose \? \{ onClose: options\.onClose \}/);
  assert.match(toastSource, /including automatic expiry/);
  assert.match(appShellSource, /auto-expiry intentionally[\s\S]*counts as dismissal/);
  assert.match(toastSource, /<Toast\.Provider toastManager=\{manager\} timeout=\{4000\}/);
});
