import { KEYRING_ACCOUNT, KEYRING_SERVICE, keyringStoreFromEntries, type SecretStore } from '@prjct.app/pi-tui-kit';

/**
 * Resolution, the record format and the keyring account live in pi-tui-kit so
 * pi-memory reads exactly the key pi-qa saved. Only the native entries are
 * built here, because only this package knows its own legacy identity.
 */
export {
  keyHasValidShape, keyringStoreFromEntries, markKeyRejected, markKeyVerified,
  publicStatus, removeKey, resolveKey, saveKey,
  type CredentialState, type ResolvedKey, type SecretStore,
} from '@prjct.app/pi-tui-kit';

/** Stable global macOS Keychain/libsecret identity, independent of extension build and install paths. */
export async function keyringStore(): Promise<SecretStore> {
  const { AsyncEntry } = await import('@napi-rs/keyring');
  return keyringStoreFromEntries(
    new AsyncEntry(KEYRING_SERVICE, KEYRING_ACCOUNT),
    [new AsyncEntry('app.prjct.pi-qa', 'typesafe-api-key')],
  );
}
