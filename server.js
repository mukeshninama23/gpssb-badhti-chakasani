"use strict";
// Promotion-file scrutiny – hosted version. Serves the page and relays its Claude requests to the Anthropic API.
// No dependencies (Node 18+). Environment:
//   ANTHROPIC_API_KEY  required – your Anthropic API key
//   ACCESS_CODE        required – code users type on the page; keeps strangers from spending your key
//   MODEL_QUICK / MODEL_DEFAULT / MODEL_COMPLEX  optional model overrides
//   MAX_ACTIVE         optional – concurrent Claude calls (default 6)
const http = require("http"), fs = require("fs"), path = require("path"), zlib = require("zlib"), crypto = require("crypto");

const PORT = +process.env.PORT || 10000;
const KEY = (process.env.ANTHROPIC_API_KEY || "").trim();
const CODE = (process.env.ACCESS_CODE || "").trim();
const BASE = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
const MODELS = {
  quick: process.env.MODEL_QUICK || "claude-haiku-5-5",
  default: process.env.MODEL_DEFAULT || "claude-sonnet-5-5",
  complex: process.env.MODEL_COMPLEX || "claude-opus-5-5",
};
const MAXTOK = { quick: 4096, default: 16000, complex: 32000 };
const MAX_BODY = 40 * 1024 * 1024, MAX_ACTIVE = +process.env.MAX_ACTIVE || 6;
const SYSTEM = "You assist the scrutiny section of the Gujarat Panchayat Service Selection Board with promotion proposals. Follow the user's instructions exactly. When asked for JSON, reply with only the JSON value: no prose and no code fences.";

const html = fs.readFileSync(path.join(__dirname, "index.html"));
const htmlGz = zlib.gzipSync(html, { level: 9 });
let active = 0;
const fails = new Map(); // ip -> [timestamps] of wrong access codes

const ipOf = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
function blocked(ip) { const now = Date.now(), a = (fails.get(ip) || []).filter((t) => now - t < 10 * 60e3); fails.set(ip, a); return a.length >= 20; }
function codeOk(req) {
  if (!CODE) return false;
  const g = Buffer.from(String(req.headers["x-access-code"] || "")), c = Buffer.from(CODE);
  return g.length === c.length && crypto.timingSafeEqual(g, c);
}
function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > MAX_BODY) { reject({ status: 413 }); req.destroy(); } else parts.push(c); });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}
function mapUpstream(status, body) {
  const msg = body?.error?.message || `Anthropic API ${status}`;
  if (status === 429 || status === 529 || body?.error?.type === "overloaded_error") return { code: "rate_limited", message: msg };
  if (status === 401 || status === 403) return { code: "bad_key", message: msg };
  if (status === 413 || /prompt is too long|too many tokens|exceeds/i.test(msg)) return { code: "prompt_too_large", message: msg };
  if (status === 400 && /credit|billing|balance/i.test(msg)) return { code: "no_credit", message: msg };
  if (status === 400 && /image/i.test(msg)) return { code: "image_rejected", message: msg };
  return { code: "upstream_error", message: msg };
}

async function claude(req, res) {
  const ip = ipOf(req);
  if (blocked(ip)) return sendJson(res, 429, { code: "rate_limited", message: "too many wrong codes" });
  if (!codeOk(req)) { fails.get(ip)?.push(Date.now()) ?? fails.set(ip, [Date.now()]); return sendJson(res, 401, { code: "not_granted", message: "wrong access code" }); }
  if (!KEY) return sendJson(res, 503, { code: "no_key", message: "ANTHROPIC_API_KEY is not set" });
  if (active >= MAX_ACTIVE) return sendJson(res, 429, { code: "rate_limited", message: "server busy" });
  let body;
  try { body = JSON.parse((await readBody(req)).toString("utf8")); }
  catch (e) { return sendJson(res, e?.status || 400, { code: e?.status === 413 ? "prompt_too_large" : "invalid_request", message: "bad body" }); }
  const tier = MODELS[body.tier] ? body.tier : "default";
  const images = Array.isArray(body.images) ? body.images : [];
  if (typeof body.prompt !== "string" || !body.prompt || body.prompt.length > 700000 || images.length > 20 || images.some((s) => typeof s !== "string" || s.length > 12e6))
    return sendJson(res, 400, { code: "invalid_request", message: "bad prompt or images" });

  const content = images.map((data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } }));
  content.push({ type: "text", text: body.prompt });
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });
  active++;
  const t0 = Date.now(); let usage = {}, stop = "", hb = null;
  try {
    const up = await fetch(BASE + "/v1/messages", {
      method: "POST", signal: ac.signal,
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODELS[tier], max_tokens: MAXTOK[tier], stream: true, system: SYSTEM, messages: [{ role: "user", content }] }),
    });
    if (!up.ok) {
      let j = null; try { j = await up.json(); } catch { /* not json */ }
      const m = mapUpstream(up.status, j);
      console.log(`claude ${tier} ${images.length}img -> ${up.status} ${m.code}`);
      return sendJson(res, up.status === 429 || up.status === 529 ? 429 : 502, m);
    }
    res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
    hb = setInterval(() => res.write("\n"), 15000);
    const rd = up.body.getReader(), dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { done, value } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, k); buf = buf.slice(k + 2);
        const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
        if (!data) continue;
        let ev; try { ev = JSON.parse(data); } catch { continue; }
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") res.write(JSON.stringify({ d: ev.delta.text }) + "\n");
        else if (ev.type === "message_start") usage = { ...ev.message?.usage };
        else if (ev.type === "message_delta") { stop = ev.delta?.stop_reason || stop; Object.assign(usage, ev.usage || {}); }
        else if (ev.type === "error") res.write(JSON.stringify({ e: mapUpstream(ev.error?.type === "overloaded_error" ? 529 : 500, ev) }) + "\n");
      }
    }
    res.write(JSON.stringify({ done: true, stop }) + "\n");
  } catch (e) {
    if (!res.headersSent) sendJson(res, 502, { code: "upstream_error", message: String(e?.message || e) });
    else if (!ac.signal.aborted) res.write(JSON.stringify({ e: { code: "upstream_error", message: String(e?.message || e) } }) + "\n");
  } finally {
    clearInterval(hb); active--;
    if (!res.writableEnded) res.end();
    console.log(`claude ${tier} ${images.length}img ${Math.round((Date.now() - t0) / 1000)}s stop=${stop || "-"} in=${usage.input_tokens ?? "?"} out=${usage.output_tokens ?? "?"}`);
  }
}

http.createServer((req, res) => {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  const url = (req.url || "/").split("?")[0];
  if (req.method === "POST" && url === "/api/claude") return void claude(req, res).catch(() => { if (!res.writableEnded) res.end(); });
  if (req.method === "GET" && url === "/api/check") {
    const ip = ipOf(req);
    if (blocked(ip)) return sendJson(res, 429, { ok: false });
    if (!codeOk(req)) { fails.get(ip)?.push(Date.now()) ?? fails.set(ip, [Date.now()]); return sendJson(res, 401, { ok: false }); }
    return sendJson(res, 200, { ok: true, key: !!KEY });
  }
  if (req.method === "GET" && url === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
  if (req.method === "GET" && (url === "/" || url === "/index.html")) {
    const gz = /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", ...(gz ? { "content-encoding": "gzip" } : {}) });
    return res.end(gz ? htmlGz : html);
  }
  res.writeHead(404, { "content-type": "text/plain" }); res.end("not found");
}).listen(PORT, () => console.log(`listening on ${PORT}; key ${KEY ? "set" : "MISSING"}; access code ${CODE ? "set" : "MISSING"}; models ${JSON.stringify(MODELS)}`));
