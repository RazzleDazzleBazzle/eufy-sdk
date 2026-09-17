import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EufyDevice } from "../../../core/types.js";
import type { P2PRouterDeps } from "../command-router.js";

/**
 * A HomeBase's own shared session answers whichever media-start it heard MOST RECENTLY, so it serves
 * one camera's live pull at a time over that ONE connection — but the STATION was never actually
 * limited to one camera, the shared connection was. A camera asked for while a sibling already holds
 * the shared session is given an independent connection of its own instead of being refused, so the
 * base serves both at full rate rather than taking turns.
 *
 * This reimplements, against our own codebase, the same fix mega-yfue/eufy-sdk landed on its
 * `beta-0.2.0` branch in commit `eab46f44` ("serve several cameras on a station at once, a connection
 * each", PR #168) — see `openDedicatedMediaSession`'s own doc in command-router.ts for why this is a
 * from-scratch reimplementation rather than a cherry-pick of that branch, and what to replace it with
 * on a future rebase onto whatever stable release eventually carries that work.
 *
 * Replaces station-serves-one-camera.spec.ts, whose two "second camera is refused" cases named exactly
 * the behaviour this removes; its other cases (same-camera rejoin, a lingering sibling releasing
 * instead of holding the station, a stopped sibling not holding it, standalone cameras never
 * contending) are carried over unchanged, since none of them describe the refusal.
 */
const opened: Array<{ stationSn: string; p2pDid: string }> = [];

vi.mock("../p2p-session.js", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeP2PSession extends EventEmitter {
    isConnected = true;
    hasLevel2Key = true;
    constructor(opts: { stationSn: string; p2pDid: string }) {
      super();
      opened.push({ stationSn: opts.stationSn, p2pDid: opts.p2pDid });
    }
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
const DOORBELL = "T8210P0000000002";
const DOORBELL_DID = "YYYYYYY-000000-YYYYY";
const SIBLING = "T8114P0000000000";
const SIBLING_DID = "ZZZZZZZ-000000-ZZZZZ";
const SOLO_A = "T8400P0000000000";
const SOLO_A_DID = "AAAAAAA-000000-AAAAA";
const SOLO_B = "T8410P0000000000";
const SOLO_B_DID = "BBBBBBB-000000-BBBBB";

const station = {
  sn: STATION_SN,
  deviceClass: "homebase",
  api: "mega",
  realtime: "p2p",
  p2pDid: STATION_DID,
  stationSn: STATION_SN,
  raw: { member: { admin_user_id: ACCOUNT_ID } },
} as unknown as EufyDevice;

const sibling = {
  sn: SIBLING,
  deviceClass: "camera",
  api: "mega",
  realtime: "p2p",
  p2pDid: SIBLING_DID,
  stationSn: STATION_SN,
  raw: { parent_sn: STATION_SN, device_channel: 0, member: { admin_user_id: ACCOUNT_ID } },
} as unknown as EufyDevice;

const doorbell = {
  sn: DOORBELL,
  deviceClass: "camera",
  api: "mega",
  realtime: "p2p",
  p2pDid: DOORBELL_DID,
  stationSn: STATION_SN,
  raw: { parent_sn: STATION_SN, device_channel: 2, member: { admin_user_id: ACCOUNT_ID } },
} as unknown as EufyDevice;

const soloA = {
  sn: SOLO_A,
  deviceClass: "camera",
  api: "mega",
  realtime: "p2p",
  p2pDid: SOLO_A_DID,
  stationSn: SOLO_A,
  raw: { device_channel: 0, member: { admin_user_id: ACCOUNT_ID } },
} as unknown as EufyDevice;

const soloB = {
  sn: SOLO_B,
  deviceClass: "camera",
  api: "mega",
  realtime: "p2p",
  p2pDid: SOLO_B_DID,
  stationSn: SOLO_B,
  raw: { device_channel: 0, member: { admin_user_id: ACCOUNT_ID } },
} as unknown as EufyDevice;

function router() {
  const deps: P2PRouterDeps = {
    mega: {
      auth: { userId: "u1", authToken: "t" },
      getDskKeys: vi.fn().mockResolvedValue({}),
      getCiphers: vi.fn().mockResolvedValue([]),
    } as unknown as P2PRouterDeps["mega"],
    listDevices: () => [station, sibling, doorbell, soloA, soloB],
    ensureDevices: async () => {},
    onConnect: () => {},
    onClose: () => {},
    onError: () => {},
    onLevel2Ready: () => {},
    onFrame: () => {},
  };
  return new P2PCommandRouter(deps);
}

const sources = (r: ReturnType<typeof router>) => (r as unknown as { liveSources: Map<string, unknown> }).liveSources;
const dedicatedSessions = (r: ReturnType<typeof router>) =>
  (r as unknown as { dedicatedSessions: Map<string, { close: ReturnType<typeof vi.fn> }> }).dedicatedSessions;

beforeEach(() => {
  opened.length = 0;
});

describe("a second camera on a station already serving one", () => {
  it("is admitted on a connection of its own instead of refused", async () => {
    const r = router();
    const held = await r.sharedLiveSourceFor(SIBLING);
    held.attach();

    const second = await r.sharedLiveSourceFor(DOORBELL);

    expect(second).toBeDefined();
    expect(sources(r).has(`${STATION_SN}:0`)).toBe(true);
    expect(sources(r).has(`${STATION_SN}:2`)).toBe(true);
    // Two independent connections to the SAME physical station (same p2pDid): the shared one the first
    // camera already held, and a dedicated one opened just for the second.
    expect(opened).toHaveLength(2);
    expect(opened.map((o) => o.p2pDid)).toEqual([STATION_DID, STATION_DID]);
  });

  it("tracks the dedicated session apart from the shared one", async () => {
    const r = router();
    const held = await r.sharedLiveSourceFor(SIBLING);
    held.attach();
    await r.sharedLiveSourceFor(DOORBELL);

    expect(dedicatedSessions(r).has(`${STATION_SN}:2`)).toBe(true);
    expect(dedicatedSessions(r).has(`${STATION_SN}:0`)).toBe(false);
  });

  it("closes its dedicated session once the source stops and is re-acquired", async () => {
    const r = router();
    const held = await r.sharedLiveSourceFor(SIBLING);
    held.attach();
    const second = await r.sharedLiveSourceFor(DOORBELL);
    const firstDedicated = dedicatedSessions(r).get(`${STATION_SN}:2`)!;
    second.dispose();

    await r.sharedLiveSourceFor(DOORBELL); // the stopped-source path drops + rebuilds

    expect(firstDedicated.close).toHaveBeenCalledOnce();
  });

  /**
   * The case a motion notification produces: something records a camera, the operator taps that
   * camera's tile, and both want the SAME channel. One pull serves them — there is no second camera,
   * so no dedicated connection is ever opened for it.
   */
  it("does not apply to the same camera, which shares one pull however many hold it", async () => {
    const r = router();
    const opened1 = await r.sharedLiveSourceFor(DOORBELL);
    opened1.attach();

    const joined = await r.sharedLiveSourceFor(DOORBELL);

    expect(joined).toBe(opened1);
    joined.attach();
    expect(joined.consumerCount).toBe(2);
    expect(sources(r).size).toBe(1);
    expect(dedicatedSessions(r).size).toBe(0);
  });

  /**
   * A pull nothing is attached to is not the station being served, it is a linger nobody asked to
   * keep. It is released rather than dedicated-around, because paying for a second connection is
   * wasted work when releasing the unused one would have made the shared session available instead.
   */
  it("releases a sibling pull nothing is attached to, rather than opening a dedicated connection for it", async () => {
    const r = router();
    const lingering = await r.sharedLiveSourceFor(SIBLING);
    expect(lingering.consumerCount).toBe(0);

    await r.sharedLiveSourceFor(DOORBELL);

    expect(sources(r).has(`${STATION_SN}:0`)).toBe(false);
    expect(dedicatedSessions(r).size).toBe(0);
    expect(opened).toHaveLength(1); // the shared session, opened once and reused
  });

  /**
   * A failed start fails its consumers without detaching them, so a caller holding a dead handle
   * leaves the count non-zero. Counting that as the station being served would open (and pay for) a
   * dedicated connection for every later stream until the client restarted.
   */
  it("does not let a stopped sibling hold the station, even with consumers still attached", async () => {
    const r = router();
    const dead = await r.sharedLiveSourceFor(SIBLING);
    dead.attach();
    dead.dispose();
    expect(dead.state).toBe("stopped");

    await r.sharedLiveSourceFor(DOORBELL);

    expect(dedicatedSessions(r).size).toBe(0);
  });
});

/**
 * Arbitration belongs to a station, and a standalone camera is its own. Nothing scopes this to
 * attached cameras by accident: the dedicated-session path is gated on `homeBaseAttached`, so a
 * standalone camera has no sibling to contend with and never triggers it.
 */
describe("a standalone camera", () => {
  it("is never given a dedicated session for another standalone camera, having no station to share", async () => {
    const r = router();
    const other = await r.sharedLiveSourceFor(SOLO_B);
    other.attach();

    await r.sharedLiveSourceFor(SOLO_A);

    expect(sources(r).has(`${SOLO_B}:0`)).toBe(true);
    expect(dedicatedSessions(r).size).toBe(0);
  });
});
