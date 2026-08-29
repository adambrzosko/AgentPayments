/**
 * Grant stores for durable paid-key persistence (P0 #5).
 *
 * The 10-minute payment verification cache is NOT persistence — once a wallet
 * receives 100+ newer transactions the original payment can no longer be found
 * in the last-100-signatures scan. A grant store fixes this: once a key is
 * verified it is recorded permanently (or until it expires/is revoked) and
 * never needs re-scanning while the grant is valid.
 *
 * Usage — pass to agentPaymentsGate:
 *
 *   const { agentPaymentsGate } = require('@agentpayments/node');
 *   const { FileGrantStore } = require('@agentpayments/node/grant-store');
 *
 *   app.use(agentPaymentsGate({
 *     ...config,
 *     grantStore: new FileGrantStore('./data/grants.json'),
 *   }));
 *
 * Grant store interface (implement your own for Redis, Postgres, etc.):
 *
 *   interface GrantStore {
 *     has(agentKey: string): boolean | Promise<boolean>
 *     add(agentKey: string, grant?: { expiresAt?: number|null, tier?: string|null }): void | Promise<void>
 *     revoke(agentKey: string): void | Promise<void>
 *   }
 *
 * `add`'s second argument is optional — a store that only implements
 * `add(agentKey)` keeps working exactly as before (extra args are ignored),
 * granting indefinite access. `revoke` is called by the vendor's own code
 * (e.g. an admin route) to cut off a specific key early; the gate itself
 * never calls it — `has()` on the built-in stores already returns false for
 * a revoked or expired grant.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function isExpired(grant) {
  return grant.expiresAt != null && Date.now() > grant.expiresAt;
}

/**
 * In-memory grant store. Survives restarts only if combined with a persistent
 * backing store. Useful as a default / for testing.
 */
class MemoryGrantStore {
  constructor() {
    this._grants = new Map();
  }
  has(key) {
    const grant = this._grants.get(key);
    if (!grant || grant.revoked || isExpired(grant)) return false;
    return true;
  }
  add(key, grant = {}) {
    this._grants.set(key, { expiresAt: grant.expiresAt ?? null, tier: grant.tier ?? null, revoked: false });
  }
  revoke(key) {
    const existing = this._grants.get(key);
    this._grants.set(key, { ...(existing || { expiresAt: null, tier: null }), revoked: true });
  }
}

/**
 * File-backed grant store. Persists grants to a JSON file on disk so they
 * survive server restarts. Write is atomic (temp-file + rename).
 *
 * Reads the legacy on-disk format (a plain JSON array of key strings) as
 * pre-existing permanent grants, so upgrading does not invalidate a vendor's
 * existing grants file. Writes the newer object-map format going forward.
 *
 * Not suitable for multi-process deployments — use Redis or a database there.
 */
class FileGrantStore {
  /**
   * @param {string} filePath  Absolute or relative path to the JSON grants file.
   *                           The file is created if it does not exist.
   */
  constructor(filePath) {
    this._path = path.resolve(filePath);
    this._grants = new Map();
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this._path, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // Legacy format: array of key strings, each a permanent grant.
        parsed.forEach((k) => this._grants.set(k, { expiresAt: null, tier: null, revoked: false }));
      } else if (parsed && typeof parsed === 'object') {
        for (const [key, grant] of Object.entries(parsed)) {
          this._grants.set(key, { expiresAt: grant.expiresAt ?? null, tier: grant.tier ?? null, revoked: Boolean(grant.revoked) });
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // only ignore missing file
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this._path), { recursive: true });
    const tmp = this._path + '.tmp';
    const obj = Object.fromEntries(this._grants);
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, this._path);
  }

  has(key) {
    const grant = this._grants.get(key);
    if (!grant || grant.revoked || isExpired(grant)) return false;
    return true;
  }

  add(key, grant = {}) {
    this._grants.set(key, { expiresAt: grant.expiresAt ?? null, tier: grant.tier ?? null, revoked: false });
    this._save();
  }

  revoke(key) {
    const existing = this._grants.get(key);
    this._grants.set(key, { ...(existing || { expiresAt: null, tier: null }), revoked: true });
    this._save();
  }
}

module.exports = { MemoryGrantStore, FileGrantStore };
