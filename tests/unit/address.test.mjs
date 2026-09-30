/**
 * Address selection.
 *
 * These tests exist because of a real bug report: on the Emby Connect web client
 * (https, app.emby.media) the credential fallback trusted a stored
 * `http://172.20.0.10:8096` Docker address, so every request died as "Failed to
 * fetch" and the visible symptom was an empty scope dropdown. The rules below are
 * about what a browser will actually permit, which is why they are pure functions
 * with a table of cases rather than something only asserted through a browser.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  orderAddressCandidates,
  isPrivateHost,
  pageServerId,
  resolveReachableServer,
} from "../../src/core/emby/api.js";

test("isPrivateHost recognises addresses a public page cannot use", () => {
  for (const host of ["10.0.0.5", "172.20.0.10", "172.16.0.1", "172.31.255.254", "192.168.51.9", "127.0.0.1", "169.254.1.1", "localhost", "::1"]) {
    assert.equal(isPrivateHost(host), true, `${host} should be private`);
  }
  for (const host of ["172.32.0.1", "172.15.0.1", "11.0.0.1", "192.169.0.1", "8.8.8.8", "emby.example.com", "7f16c6d3.hvcdn.to", ""]) {
    assert.equal(isPrivateHost(host), false, `${host} should not be private`);
  }
});

test("the reported failure: a Docker http address on the Emby Connect https page is blocked", () => {
  const candidates = orderAddressCandidates({
    addresses: ["http://172.20.0.10:8096", "https://7f16c6d3.hvcdn.to"],
    pageOrigin: "https://app.emby.media",
    pageHost: "app.emby.media",
    pageIsPrivate: false,
  });
  assert.equal(candidates[0].url, "https://7f16c6d3.hvcdn.to", "the reachable https address must be preferred");
  assert.equal(candidates[0].blocked, undefined);
  const docker = candidates.find((candidate) => candidate.url.includes("172.20.0.10"));
  assert.equal(docker.blocked, true, "the Docker address must never be used from a public https page");
  assert.match(docker.reason, /mixed content|private address/);
});

test("the same origin as the page wins outright", () => {
  const candidates = orderAddressCandidates({
    addresses: ["https://remote.example.com", "https://emby.example.com"],
    pageOrigin: "https://emby.example.com",
    pageHost: "emby.example.com",
  });
  assert.equal(candidates[0].url, "https://emby.example.com");
  assert.equal(candidates[0].rank, 0);
  assert.match(candidates[0].reason, /same origin/);
});

test("http on the page's own host is upgraded to https rather than discarded", () => {
  const candidates = orderAddressCandidates({
    addresses: ["http://emby.example.com:8096"],
    pageOrigin: "https://emby.example.com",
    pageHost: "emby.example.com",
  });
  assert.equal(candidates[0].url, "https://emby.example.com:8096");
  assert.equal(candidates[0].blocked, undefined);
});

test("a private address is fine when the page is itself on the LAN", () => {
  const candidates = orderAddressCandidates({
    addresses: ["http://192.168.51.9:8096"],
    pageOrigin: "http://192.168.51.9:8096",
    pageHost: "192.168.51.9",
    pageIsPrivate: true,
  });
  assert.equal(candidates[0].blocked, undefined, "browsing Emby on the LAN must still work");
  assert.equal(candidates[0].rank, 0);
});

test("candidates are de-duplicated and their order is stable for equal ranks", () => {
  const candidates = orderAddressCandidates({
    addresses: ["https://a.example.com", "https://a.example.com", "https://b.example.com"],
    pageOrigin: "https://page.example.com",
    pageHost: "page.example.com",
  });
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((candidate) => candidate.url), ["https://a.example.com", "https://b.example.com"]);
});

test("nonsense addresses are kept but marked unusable", () => {
  const candidates = orderAddressCandidates({ addresses: ["not a url"], pageOrigin: "https://page.example.com" });
  assert.equal(candidates[0].blocked, true);
  assert.match(candidates[0].reason, /usable URL/);
});

/** A response that looks like a real Emby: the probe validates the JSON body. */
const embyInfo = () => ({ ok: true, json: async () => ({ ServerName: "Sayuri", Version: "4.10.0.40" }) });
/** A single-page host: 200, but the body is HTML, so it is not an Emby server. */
const htmlHost = () => ({
  ok: true,
  json: async () => {
    throw new SyntaxError("Unexpected token < in JSON at position 0");
  },
});

test("the reported failure: the Docker http address is never probed and the SPA host is rejected", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith("http://172.20.0.10")) throw new TypeError("Failed to fetch");
    if (url.startsWith("https://app.emby.media")) return htmlHost();
    return embyInfo();
  };
  const session = await resolveReachableServer(
    {
      server: "http://172.20.0.10:8096",
      addresses: ["http://172.20.0.10:8096", "https://7f16c6d3.hvcdn.to"],
      source: "localStorage:servercredentials3",
    },
    { location: { origin: "https://app.emby.media", hostname: "app.emby.media" } },
    { fetchImpl },
  );
  assert.equal(session.server, "https://7f16c6d3.hvcdn.to");
  assert.equal(session.reachable, true);
  assert.match(session.probe, /https:\/\/7f16c6d3\.hvcdn\.to/);
  assert.ok(
    !calls.some((url) => url.includes("172.20.0.10")),
    "an address the browser will block must not be probed at all",
  );
  assert.ok(
    calls.some((url) => url.startsWith("https://app.emby.media")),
    "the page origin is tried, then rejected because it answers HTML rather than Emby JSON",
  );
});

test("resolveReachableServer falls through to a working address and reports failures", async () => {
  const tried = [];
  const fetchImpl = async (url) => {
    tried.push(url);
    if (url.includes("dead.example.com")) throw new TypeError("Failed to fetch");
    // The page origin is an ordinary web page: it answers, but not with Emby.
    if (url.startsWith("https://page.example.com")) return { ok: false, status: 404 };
    return embyInfo();
  };
  const session = await resolveReachableServer(
    { server: "https://dead.example.com", addresses: ["https://dead.example.com", "https://live.example.com"], source: "ApiClient" },
    { location: { origin: "https://page.example.com", hostname: "page.example.com" } },
    { fetchImpl },
  );
  assert.equal(session.server, "https://live.example.com");
  assert.equal(tried.length, 3, "dead, then the page origin, then the live address");
});

test("resolveReachableServer degrades to the first usable address when nothing answers", async () => {
  const session = await resolveReachableServer(
    { server: "https://dead.example.com", addresses: ["https://dead.example.com"], source: "ApiClient" },
    { location: { origin: "https://page.example.com", hostname: "page.example.com" } },
    {
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    },
  );
  assert.equal(session.server, "https://dead.example.com", "behaviour must not become worse than before");
  assert.equal(session.reachable, false);
  assert.match(session.probe, /nothing answered/);
});

test("a page that is itself the Emby server is preferred, because it needs no CORS", async () => {
  const tried = [];
  const session = await resolveReachableServer(
    { server: "https://dead.example.com", source: "ApiClient" },
    { location: { origin: "https://emby.example.com", hostname: "emby.example.com" } },
    {
      fetchImpl: async (url) => {
        tried.push(url);
        return embyInfo();
      },
    },
  );
  assert.equal(session.server, "https://emby.example.com", "a self-hosted page is itself the server");
  assert.deepEqual(tried, ["https://emby.example.com/System/Info/Public"], "same origin is probed first and wins");
});

test("pageServerId reads the server the page is showing", () => {
  const win = { location: { hash: "#!/item?id=7166857&serverId=84fc3090b62148fa8cf2238a16ed4f36" } };
  assert.equal(pageServerId(win), "84fc3090b62148fa8cf2238a16ed4f36");
  assert.equal(pageServerId({ location: { hash: "#!/item?id=7166857" } }), null);
  assert.equal(pageServerId({ location: { hash: "" } }), null);
  assert.equal(pageServerId({}), null);
});
