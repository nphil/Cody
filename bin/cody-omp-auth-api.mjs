/**
 * One name for each AuthStorage operation Cody's Bun helpers use, whichever
 * omp built the store.
 *
 * omp 18.3.4 split AuthStorage's flat methods into namespaces
 * (`storage.credentials.list()`, `storage.blocks.list()`,
 * `storage.resets.list()`, …). The helpers called the flat names, so on that
 * release every credential read failed with "listStoredCredentials is not a
 * function" — and because a failed read degrades softly by design, nothing
 * looked broken: the composer simply lost the account-in-use evidence and
 * gauged the idle sibling, showing 0% while the real account sat at 42%.
 *
 * Each operation prefers the namespaced method and falls back to the flat one
 * for an older omp. Resolution is LAZY, per call: the unblock helper promises
 * never to touch a credential, and merely reading `storage.credentials` to
 * probe for a namespace would break that on a build where the property is the
 * rows themselves. A method neither shape provides throws a plain sentence
 * naming the operation, which the caller reports as `unsupported`.
 */

function method(owner, name) {
  const fn = owner && typeof owner === "object" ? owner[name] : undefined;
  return typeof fn === "function" ? fn.bind(owner) : null;
}

function call(storage, operation, namespace, name, flatName, args) {
  const fn = method(storage?.[namespace], name) ?? method(storage, flatName);
  if (!fn) throw new Error(`Installed OMP does not expose ${operation}.`);
  return fn(...args);
}

/** @param {any} storage an omp AuthStorage instance, flat (≤18.3.3) or namespaced (≥18.3.4). */
export function authApi(storage) {
  return {
    reload: () => call(storage, "credential reload", "credentials", "reload", "reload", []),
    list: (...args) => call(storage, "the credential list", "credentials", "list", "listStoredCredentials", args),
    listDisabled: () => call(storage, "disabled credentials", "credentials", "listDisabled", "listDisabledCredentials", []),
    removeById: (provider, id) => call(storage, "credential removal", "credentials", "removeById", "removeCredential", [provider, id]),
    removeProvider: (provider) => call(storage, "provider logout", "credentials", "remove", "remove", [provider]),
    listBlocks: (ids) => call(storage, "credential blocks", "blocks", "list", "listCredentialBlocks", [ids]),
    /**
     * Drop one credential's block rows. The whole-credential delete is one
     * store call and bumps AuthStorage's generation for snapshot waiters; the
     * per-scope delete over `blocks` is the fallback for a build with only that.
     */
    deleteBlocks: (credentialId, blocks) => {
      const all = method(storage?.blocks, "deleteAll") ?? method(storage, "deleteCredentialBlocks");
      if (all) return void all(credentialId);
      const one = method(storage?.blocks, "delete") ?? method(storage, "deleteCredentialBlock");
      if (!one) throw new Error("Installed OMP does not expose credential block removal.");
      for (const block of blocks) one(credentialId, block.providerKey, block.blockScope ?? "");
    },
    listResetCredits: (options) => call(storage, "saved resets", "resets", "list", "listResetCredits", [options]),
    redeemResetCredit: (options) => call(storage, "saved-reset redemption", "resets", "redeem", "redeemResetCredit", [options]),
    close: async () => {
      await method(storage, "close")?.();
    },
  };
}
