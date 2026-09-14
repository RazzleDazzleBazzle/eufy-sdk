import { ARMING, ARMING_CMD, ARMING_MEMBERS, ArmingMode, AlarmDelaySeconds, type ArmingActions } from "../arming.js";
import { buildCommand, decodeEvent } from "../index.js";
import { CusPushEvent } from "../../push-events.js";
import { bind } from "./bind.js";
import type { CommandContext } from "../types.js";
import type { Command } from "../../../core/contracts.js";

const ctx: CommandContext = {
  channel: 0,
  codec: "station",
  // The barrel's `buildCommand` only lets a module answer for a capability the device HAS; this ctx
  // hands evidence directly rather than through detection, so the resolved set is stated.
  capabilities: new Set(["arming"]),
  paramIds: new Set(),
  accountName: "someone+tag",
};
const noIdentityCtx: CommandContext = { channel: 0, codec: "station", paramIds: new Set() };

describe("arming capability module", () => {
  it("declares the capability + schema", () => {
    expect(ARMING.capability).toBe("arming");
    expect(ARMING.properties.map((p) => p.name)).toEqual(["armingMode"]);
  });

  it("proves arming via the guard-mode param 1224", () => {
    expect(ARMING.detection?.evidenceParams).toContain(1224);
  });

  describe("setMode / buildCommand (wire captured live on a T8030, 2026-07-23)", () => {
    it.each([
      [ArmingMode.away, 0],
      [ArmingMode.disarmed, 63],
      [ArmingMode.home, 1],
      [ArmingMode.schedule, 2],
      [ArmingMode.custom1, 3],
    ])("%s → set-payload cmd 1224, {mode_type:%i, user_name}, explicit mValue3:0", async (mode, modeType) => {
      const { acts, sent } = bind<ArmingActions>("arming", ctx);
      await acts.setMode(mode);
      expect(sent).toEqual([
        {
          kind: "set-payload",
          cmd: 1224,
          payload: { mode_type: modeType, user_name: "someone+tag" },
          channel: 0,
          mValue3: 0,
        },
      ]);
    });

    it("buildCommand mirrors the same intent for the low-level setProperty path", () => {
      expect(buildCommand("armingMode", "away", ctx)).toEqual({
        kind: "set-payload",
        cmd: 1224,
        payload: { mode_type: 0, user_name: "someone+tag" },
        channel: 0,
        mValue3: 0,
      });
    });

    it("buildCommand returns undefined for an unrelated action, and throws for an unknown mode name", () => {
      expect(buildCommand("nope", "home", ctx)).toBeUndefined();
      expect(() => buildCommand("armingMode", "not-a-mode", ctx)).toThrow(
        /mode: "not-a-mode" is not a valid value \(must be one of 0\/1\/2\/3\/63\)/,
      );
    });

    /**
     * The four uncaptured modes are the whole reason the write domain is narrower than the read one. A
     * mode the station reports must still READ (it has a label), and the same value must refuse on the way
     * back out — by naming the five that work, not by reporting the capability as missing.
     *
     * Both entry points are checked: the fluent setter and the intent path share one domain check, and it
     * was them disagreeing that put a guessed `mode_type` on a fire-and-forget wire in the first place.
     */
    it.each([
      ["custom2", 4],
      ["custom3", 5],
      ["off", 6],
      ["geo", 47],
    ])("refuses %s (mode_type %i) — reportable, never sent", async (name, wire) => {
      const readCtx: CommandContext = { ...ctx, paramIds: new Set([ARMING_CMD.SET_ARMING]) };
      const { acts, sent } = bind<ArmingActions>("arming", readCtx, {
        read: (p) => (p === "armingMode" ? { value: wire } : undefined),
      });
      expect(acts.mode).toBe(wire);
      await expect(acts.setMode(acts.mode! as never)).rejects.toThrow(/must be one of 0\/1\/2\/3\/63/);
      expect(() => buildCommand("armingMode", name, ctx)).toThrow(/must be one of 0\/1\/2\/3\/63/);
      expect(sent).toEqual([]);
    });

    it("names every reportable mode, and offers only the settable ones", () => {
      const mode = ARMING_MEMBERS.mode;
      expect(Object.values(mode.enumValues)).toEqual([
        "away",
        "home",
        "schedule",
        "custom1",
        "custom2",
        "custom3",
        "off",
        "geo",
        "disarmed",
      ]);
      expect(mode.args[0].values).toEqual([0, 1, 2, 3, 63]);
    });

    it("setMode round-trips the wire integer the mode getter answers", async () => {
      const readCtx: CommandContext = { ...ctx, paramIds: new Set([ARMING_CMD.SET_ARMING]) };
      const { acts, sent } = bind<ArmingActions>("arming", readCtx, {
        read: (name) => (name === "armingMode" ? { value: 1 } : undefined),
      });
      expect(acts.mode).toBe(1);
      await acts.setMode(acts.mode!);
      expect(sent).toEqual([
        {
          kind: "set-payload",
          cmd: 1224,
          payload: { mode_type: 1, user_name: "someone+tag" },
          channel: 0,
          mValue3: 0,
        },
      ]);
    });

    it("throws a clear error when the context has no account identity", async () => {
      const { acts } = bind<ArmingActions>("arming", noIdentityCtx);
      await expect(acts.setMode(ArmingMode.home)).rejects.toThrow(/missing account identity/);
      expect(() => buildCommand("armingMode", "home", noIdentityCtx)).toThrow(/missing account identity/);
    });
  });

  /**
   * `currentMode` is the schedule/geo resolution gap: `armingMode` reads back the POLICY name forever
   * (literally "schedule"), never what a schedule has actually resolved to. The MODE_SWITCH push itself
   * carries the resolved value in its own `mode` field — attached here as `currentMode` so a caller
   * doesn't have to duplicate ARMING_MODE_WIRE just to read it.
   */
  describe("currentMode (the push's own resolved value, distinct from the armingMode policy)", () => {
    const push = (mode: unknown) =>
      decodeEvent(
        { source: "push", eventType: CusPushEvent.MODE_SWITCH, deviceSn: "T8030P0000000000", payload: { mode } },
        new Set(["arming"]),
      )[0].payload;

    it.each([
      [0, "away"],
      [1, "home"],
      [3, "custom1"],
      [2, "schedule"],
      [63, "disarmed"],
    ])("resolves push mode %i to currentMode %s", (wire, label) => {
      expect(push(wire)).toMatchObject({ currentMode: label });
    });

    it("omits currentMode when the push carries no usable mode", () => {
      expect(push(undefined)).not.toHaveProperty("currentMode");
      expect(push("not-a-number")).not.toHaveProperty("currentMode");
    });

    /**
     * No `refresh` on this mapping — a host's emitSemantic holds an event back entirely until a
     * declared refresh converges or throws, and on a schedule/geo policy `armingMode` never changes
     * (it reads back the literal policy name forever), so a refresh watching for it to change can never
     * converge on exactly the transitions this event exists to report. That silently dropped the event
     * — currentMode included — on every schedule-driven switch. See the class doc.
     */
    it("carries no refresh, so the event is never held back waiting for one", () => {
      const [hit] = decodeEvent(
        { source: "push", eventType: CusPushEvent.MODE_SWITCH, deviceSn: "T8030P0000000000", payload: { mode: 1 } },
        new Set(["arming"]),
      );
      expect(hit.event).toBe("armingModeChanged");
      expect(hit.refresh).toBeUndefined();
      expect(hit.payload).toMatchObject({ currentMode: "home" });
    });
  });

  it("ARMING_CMD names the wire ids (no bare literals)", () => {
    expect(ARMING_CMD.SET_ARMING).toBe(1224);
    expect(ARMING_CMD.ALARM_DELAY_CONFIG).toBe(1255);
  });

  it("AlarmDelaySeconds is exactly the app's own picker preset list", () => {
    expect(AlarmDelaySeconds).toEqual({ off: 0, sec15: 15, sec30: 30, sec45: 45, sec60: 60, min3: 180, min5: 300 });
  });

  describe("setAlarmDelayConfig (wire captured live on a T8030, 2026-07-23)", () => {
    const config = {
      countDownAlarm: { channelList: [6], delaySeconds: AlarmDelaySeconds.sec45 },
      countDownArm: { channelList: [], delaySeconds: AlarmDelaySeconds.off },
      devices: [
        { action: 12, deviceChannel: 16 },
        { action: 11, deviceChannel: 6 },
        { action: 9, deviceChannel: 2 },
      ],
      sirenSensorAction: [
        { action: 0, deviceChannel: 16 },
        { action: 0, deviceChannel: 6 },
        { action: 0, deviceChannel: 2 },
      ],
    };

    it("→ set-json-raw cmd 1255, bare plaintext (no 1350/1700 envelope), pinned to station ch 255", async () => {
      const { acts, sent } = bind<ArmingActions>("arming", ctx);
      await acts.setAlarmDelayConfig(ArmingMode.away, config);
      expect(sent).toEqual([
        {
          kind: "set-json-raw",
          cmd: 1255,
          channel: 255,
          data: {
            mode_id: 0,
            count_down_alarm: { channel_list: [6], delay_time: 45 },
            count_down_arm: { channel_list: [], delay_time: 0 },
            devices: [
              { action: 12, device_channel: 16 },
              { action: 11, device_channel: 6 },
              { action: 9, device_channel: 2 },
            ],
            siren_sensor_action: [
              { action: 0, device_channel: 16 },
              { action: 0, device_channel: 6 },
              { action: 0, device_channel: 2 },
            ],
          },
        },
      ]);
    });

    it("maps every ArmingMode name to its captured mode_id", async () => {
      const { acts, sent } = bind<ArmingActions>("arming", ctx);
      await acts.setAlarmDelayConfig(ArmingMode.home, config);
      const cmd = sent[0] as Extract<Command, { kind: "set-json-raw" }>;
      expect(cmd.data.mode_id).toBe(1);
    });

    it("channel 255 is PINNED — independent of ctx.channel, not just coincidentally matching it", async () => {
      const oddCtx: CommandContext = { ...ctx, channel: 7 };
      const { acts, sent } = bind<ArmingActions>("arming", oddCtx);
      await acts.setAlarmDelayConfig(ArmingMode.away, config);
      const cmd = sent[0] as Extract<Command, { kind: "set-json-raw" }>;
      expect(cmd.channel).toBe(255);
    });

    it("setAlarmDelayConfig rejects a malformed config with a rejected promise, not a sync throw", async () => {
      const { acts, sent } = bind<ArmingActions>("arming", ctx);
      // Deliberately malformed at runtime (a caller ignoring/bypassing types) — missing countDownAlarm,
      // so alarmDelayCommand() throws synchronously reading `.channelList` off `undefined`.
      const malformed = {} as any;
      await expect(acts.setAlarmDelayConfig(ArmingMode.away, malformed)).rejects.toThrow();
      expect(sent).toEqual([]);
    });
  });
});
