/**
 * AgentPayments gate for Koa.
 *
 * Adapts Koa's `ctx` to the small Express-like req/res surface
 * @agentpayments/node's gate actually touches (cataloged directly from its
 * source: req.{body,get,headers,ip,method,originalUrl,path,query,secure,
 * socket,url}, res.{status,set,send,cookie,redirect}) and calls the exact,
 * unmodified gate middleware through it — same gate behavior, same security
 * properties, same response format as the Express SDK. No gate logic is
 * reimplemented here; koa-connect was tried first but passes Koa's *raw*
 * ctx.req/ctx.res (bare Node http objects, no Express-style methods at
 * all), which the gate can't run against — Koa's ctx itself already
 * exposes near-identical methods natively, so this maps to those instead.
 */
'use strict';

const { agentPaymentsGate } = require('@agentpayments/node');

const CHALLENGE_VERIFY_PATH = '/__challenge/verify';

function readUrlencodedBody(ctx) {
  return new Promise((resolve, reject) => {
    let data = '';
    ctx.req.on('data', (chunk) => { data += chunk; });
    ctx.req.on('end', () => {
      try {
        resolve(Object.fromEntries(new URLSearchParams(data)));
      } catch (err) {
        reject(err);
      }
    });
    ctx.req.on('error', reject);
  });
}

function toGateReq(ctx, body) {
  return {
    body,
    headers: ctx.headers,
    get: (name) => ctx.get(name),
    ip: ctx.ip,
    method: ctx.method,
    originalUrl: ctx.originalUrl,
    path: ctx.path,
    query: ctx.query,
    secure: ctx.secure,
    socket: ctx.req.socket,
    url: ctx.url,
  };
}

function toGateRes(ctx, onSend) {
  const res = {
    status(code) { ctx.status = code; return res; },
    set(name, value) { ctx.set(name, value); return res; },
    send(body) { ctx.body = body; onSend(); return res; },
    cookie(name, value, opts = {}) { ctx.cookies.set(name, value, opts); return res; },
    redirect(status, url) { ctx.status = status; ctx.redirect(url); onSend(); return res; },
  };
  return res;
}

function agentPaymentsKoa(config) {
  const gate = agentPaymentsGate(config);

  return async function agentPaymentsKoaMiddleware(ctx, next) {
    const body = (ctx.method === 'POST' && ctx.path === CHALLENGE_VERIFY_PATH)
      ? await readUrlencodedBody(ctx)
      : undefined;

    const req = toGateReq(ctx, body);

    // The gate either short-circuits (calls res.send()/res.redirect() and
    // never calls next()) or passes through (calls next(), never touches
    // res). Koa only flushes ctx.body after the middleware chain unwinds,
    // so we must resolve on WHICHEVER of those happens first — waiting on
    // next() alone would hang forever on the short-circuit path.
    let settled = false;
    const outcome = await new Promise((resolve, reject) => {
      const res = toGateRes(ctx, () => {
        if (settled) return;
        settled = true;
        resolve('sent');
      });
      gate(req, res, (err) => {
        if (settled) return;
        settled = true;
        if (err) return reject(err);
        resolve('next');
      });
    });

    if (outcome === 'next') await next();
  };
}

module.exports = { agentPaymentsKoa };
