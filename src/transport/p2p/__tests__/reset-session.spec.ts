import { describe, expect, it, vi } from "vitest";
import type { EufyDevice } from "../../../core/types.js";
import type { P2PRouterDeps } from "../command-router.js";

/**
 * `resetSession` — an on-demand recovery lever for a caller (e.g. a host that noticed a serial's
 * live pulls have been failing for a sustained stretch) that needs to force a fresh P2P session,
 * unlike the existing `resetStandaloneSession` (only ever used by the capability-observation system
 * after a property write), which deliberately REFUSES to touch a HomeBase-attached camera's shared
 * session at all. See command-router.ts's own doc on `resetSession` for the full rationale.
 */
vi.mock("../p2p-session.js", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeP2PSession extends EventEmitter {
    isConnected = true;
    hasLevel2Key = true;
    connect = vi.fn(async () => {});
    awaitLevel2Key = vi.fn(async () => this.hasLevel2Key);
    repromptLevel2Key = vi.fn(() => false);
    close = vi.fn(async () => {
      this.emit("close");
    });
  }
  return { P2PSession: FakeP2PSession };
});

const { P2PCommandRouter } = await import("../command-router.js");

const STATION_SN = "T8010P0000000000";
const STATION_DID = "XXXXXXX-000000-XXXXX";
const ACCOUNT_ID = "0".repeat(40);
const CAMERA = "T8210P0000000002";
const CAMERA_DID = "YYYYYYY-000000-YYYYY";
const STANDALONE = "T8400P0000000000";
const STANDALONE_DID = "AAAAAAA-000000-AAAAA";

const station = {
  sn: STATION_SN,
  deviceClass: "homebase",
  api: "mega",
  realtime: "p2p",
  p2pDid: STATION_DID,
  stationSn: STATION_SN,
  raw: { member: { admin_user_id: ACCOUNT_ID } },
} as unknown as EufyDevice;

const camera = {
  sn: CAMERA,
  deviceClass: "camera",
  api: "mega",
  realtime: "p2p",
  p2pDid: CAMERA_DID,
  stationSn: STATION_SN,
  raw: { parent_sn: STATION_SN, device_channel: 0, member: { admin_user_id: ACCOUNT_ID } },
} as unknown as EufyDevice;

const standalone = {
  sn: STANDALONE,
  deviceClass: "camera",
  api: "mega",
  realtime: "p2p",
  p2pDid: STANDALONE_DID,
  stationSn: STANDALONE,
  raw: { device_channel: 0, member: { admin_user_id: ACCOUNT_ID } },
} as unknown as EufyDevice;

function router() {
  const deps: P2PRouterDeps = {
    mega: {
      auth: { userId: "u1", authToken: "t" },
      getDskKeys: vi.fn().mockResolvedValue({}),
      getCiphers: vi.fn().mockResolvedValue([]),
    } as unknown as P2PRouterDeps["mega"],
    listDevices: () => [station, camera, standalone],
    ensureDevices: async () => {},
    onConnect: () => {},
    onClose: () => {},
    onError: () => {},
    onLevel2Ready: () => {},
    onFrame: () => {},
  };
  return new P2PCommandRouter(deps);
}

const managerOf = (r: ReturnType<typeof router>) =>
  (r as unknown as { manager: { resetWhenUnused: (sn: string) => Promise<void> } }).manager;

describe("resetSession", () => {
  it("resolves an ATTACHED camera to its STATION — unlike resetStandaloneSession, it does not refuse", async () => {
    const r = router();
    const spy = vi.spyOn(managerOf(r), "resetWhenUnused").mockResolvedValue();

    await r.resetSession(CAMERA);

    expect(spy).toHaveBeenCalledWith(STATION_SN);
  });

  it("resets a standalone device's own session, same target resetStandaloneSession would use", async () => {
    const r = router();
    const spy = vi.spyOn(managerOf(r), "resetWhenUnused").mockResolvedValue();

    await r.resetSession(STANDALONE);

    expect(spy).toHaveBeenCalledWith(STANDALONE);
  });

  it("falls back to the raw serial for a device with no loaded record, rather than throwing", async () => {
    const r = router();
    const spy = vi.spyOn(managerOf(r), "resetWhenUnused").mockResolvedValue();

    await r.resetSession("T9999P0000000000");

    expect(spy).toHaveBeenCalledWith("T9999P0000000000");
  });

  it("does not force-close a station a genuinely active sibling still holds — defers exactly as resetWhenUnused does", async () => {
    const r = router();
    const held = await r.sharedLiveSourceFor(CAMERA);
    const consumer = held.attach();

    let resolved = false;
    const resetPromise = r.resetSession(CAMERA).then(() => {
      resolved = true;
    });
    await Promise.resolve(); // let any already-settleable microtasks run
    expect(resolved, "must not resolve while a real consumer is still attached").toBe(false);

    consumer.detach();
    await resetPromise;
    expect(resolved).toBe(true);
  });
});
