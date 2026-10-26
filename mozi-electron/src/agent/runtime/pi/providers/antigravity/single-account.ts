/** Build-time replacement for pi-antigravity@0.11.0/auth/accounts.js.
 * Mozi owns credentials; never load the CLI account pool or switch identities on 429.
 */
export async function failoverToNextAccount(): Promise<undefined> { return undefined; }
export function listAccounts(): never[] { return []; }
export function rememberAccount(): void { throw new Error("Mozi owns Antigravity credentials."); }
export const activateAccount = rememberAccount;
export const removeAccount = rememberAccount;
export const updateRememberedAccount = rememberAccount;
