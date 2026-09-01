/**
 * Vendor store — JSON file backed, atomic writes.
 * Used in local dev when DATABASE_URL is not set.
 *
 * Schema:
 *   vendors.json {
 *     vendors: { [vendorId]: VendorRecord },
 *     apiKeys:  { [apiKey]:  vendorId },
 *     verificationTokens: { [token]: vendorId },
 *   }
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'vendors.json');

function read() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!data.domains) data.domains = {}; // older files predate domain verification
    return data;
  } catch {
    return { vendors: {}, apiKeys: {}, verificationTokens: {}, domains: {} };
  }
}

function write(data) {
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

module.exports = {
  getVendorByApiKey(apiKey) {
    const data = read();
    const vendorId = data.apiKeys[apiKey];
    if (!vendorId) return null;
    return data.vendors[vendorId] || null;
  },

  createVendor({ vendorId, email, name, apiKey, verificationSecret, verificationToken }) {
    const data = read();
    if (Object.values(data.vendors).some((v) => v.email === email)) {
      const err = new Error('A vendor with that email already exists.');
      err.code = 'DUPLICATE_EMAIL';
      throw err;
    }
    const record = {
      vendorId, email, name, apiKey, verificationSecret,
      plan: 'free',
      keysIssued: 0,
      emailVerified: false,
      verificationToken: verificationToken || null,
      stripeCustomerId: null,
      createdAt: Date.now(),
    };
    data.vendors[vendorId] = record;
    data.apiKeys[apiKey] = vendorId;
    if (verificationToken) data.verificationTokens[verificationToken] = vendorId;
    write(data);
    return record;
  },

  incrementKeysIssued(vendorId) {
    const data = read();
    if (data.vendors[vendorId]) {
      data.vendors[vendorId].keysIssued = (data.vendors[vendorId].keysIssued || 0) + 1;
      write(data);
    }
  },

  getVendor(vendorId) {
    return read().vendors[vendorId] || null;
  },

  listVendors() {
    return Object.values(read().vendors);
  },

  // Email verification
  verifyEmail(token) {
    const data = read();
    const vendorId = data.verificationTokens[token];
    if (!vendorId || !data.vendors[vendorId]) return null;
    data.vendors[vendorId].emailVerified = true;
    data.vendors[vendorId].verificationToken = null;
    delete data.verificationTokens[token];
    write(data);
    return data.vendors[vendorId];
  },

  // Stripe
  setStripeIds(vendorId, stripeCustomerId) {
    const data = read();
    if (data.vendors[vendorId]) {
      data.vendors[vendorId].stripeCustomerId = stripeCustomerId;
      write(data);
    }
  },

  // API key rotation
  setApiKey(vendorId, apiKey) {
    const data = read();
    const vendor = data.vendors[vendorId];
    if (!vendor) return null;
    delete data.apiKeys[vendor.apiKey];
    vendor.apiKey = apiKey;
    data.apiKeys[apiKey] = vendorId;
    write(data);
    return vendor;
  },

  // Usage analytics — JSON store has no daily breakdown; returns empty array
  getDailyUsage(_vendorId, _days = 30) {
    return [];
  },

  keysIssuedThisMonth(vendorId) {
    // JSON store doesn't track monthly — return all-time as fallback
    return read().vendors[vendorId]?.keysIssued ?? 0;
  },

  // Domain ownership verification
  addDomain({ domainId, vendorId, domain, verificationToken }) {
    const data = read();
    const dup = Object.values(data.domains).some((d) => d.vendorId === vendorId && d.domain === domain);
    if (dup) {
      const err = new Error('This domain is already registered on your account.');
      err.code = 'DUPLICATE_DOMAIN';
      throw err;
    }
    const record = {
      domainId, vendorId, domain, verificationToken,
      verified: false, verifiedAt: null, createdAt: Date.now(),
    };
    data.domains[domainId] = record;
    write(data);
    return record;
  },

  countDomains(vendorId) {
    return Object.values(read().domains).filter((d) => d.vendorId === vendorId).length;
  },

  listDomains(vendorId) {
    return Object.values(read().domains)
      .filter((d) => d.vendorId === vendorId)
      .sort((a, b) => b.createdAt - a.createdAt);
  },

  getDomainForVendor(vendorId, domainId) {
    const d = read().domains[domainId];
    return d && d.vendorId === vendorId ? d : null;
  },

  markDomainVerified(domainId) {
    const data = read();
    const d = data.domains[domainId];
    if (!d) return null;
    d.verified = true;
    d.verifiedAt = Date.now();
    write(data);
    return d;
  },

  deleteDomain(vendorId, domainId) {
    const data = read();
    const d = data.domains[domainId];
    if (!d || d.vendorId !== vendorId) return false;
    delete data.domains[domainId];
    write(data);
    return true;
  },
};
