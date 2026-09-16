import { describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";
import { LIVE_TRACE_MESSAGE } from "../live-trace.js";

/**
 * A session knows whether its path is answering, because the protocol already tells it and nothing read it.
 *
 * The heartbeat sends a PING every 5 s for the life of the connection and the station answers PONG, which is
 * kept only to echo its payload into the next PING. No timestamp, no deadline: a session pings into a path
 * that has stopped answering and cannot tell.
 *
 * What finally tells it is a media start abandoned unacknowledged — three seconds AFTER a caller asked for
 * video. Measured on a wired camera: a session idle for 18 s, resumed, twenty byte-identical retransmits with
 * no acknowledgement, and a rebuilt session streaming at once. Seven seconds of black screen, of which three
 * were spent discovering what an unanswered PONG had already established.
 *
 * Silence is only evidence where an answer was once given. A station that has never ponged says nothing about
 * itself by not ponging now, and treating that as death would rebuild its session forever.
 */
const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";

function session() {
  const debug = vi.fn();
  const built = new P2PSession({
    stationSn: STATION_SN,
    p2pDid: P2P_DID,
    logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  const internals = built as unknown as {
    connectAddress?: { host: string; port: number };
    lastPongAt?: number;
    connected: boolean;
  };
  internals.connectAddress = { host: "203.0.113.1", port: 32100 };
  internals.connected = true;
  return { built, internals, debug };
}

const traces = (debug: ReturnType<typeof vi.fn>) =>
  debug.mock.calls.filter(([message]) => message === LIVE_TRACE_MESSAGE).map(([, trace]) => trace);

describe("a session's path liveness", () => {
  it("is unknown until a pong has ever arrived, so silence proves nothing yet", () => {
    const { built } = session();
    expect(built.pathSilentMs).toBeUndefined();
  });

  it("is measured from the last pong once one has arrived", () => {
    const { built, internals } = session();
    internals.lastPongAt = Date.now() - 12_000;
    expect(built.pathSilentMs).toBeGreaterThanOrEqual(12_000);
  });

  it("answers that a path which has answered recently is alive", () => {
    const { built, internals } = session();
    internals.lastPongAt = Date.now() - 1_000;
    expect(built.pathAnswering).toBe(true);
  });

  it("answers that a path silent past ten heartbeats is not", () => {
    const { built, internals } = session();
    internals.lastPongAt = Date.now() - 51_000;
    expect(built.pathAnswering).toBe(false);
  });

  it("answers that a path which never ponged is not known to be dead", () => {
    const { built } = session();
    expect(built.pathAnswering).toBe(true);
  });

  it("states the silence once, rather than on every heartbeat", () => {
    const { built, internals, debug } = session();
    internals.lastPongAt = Date.now() - 51_000;
    void built.pathAnswering;
    void built.pathAnswering;
    const stale = traces(debug).filter((t) => (t as { phase: string }).phase === "path-stale");
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ phase: "path-stale" });
  });
});
