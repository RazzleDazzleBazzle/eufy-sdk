import { enumLabels } from "../../core/util.js";
import { describeDevice, setJsonRaw, setPayload } from "./access.js";
import { accepts, method, propertiesOf, type Members, type Surface } from "./members.js";
import type { CapabilityModule, CommandContext } from "./types.js";
import { CusPushEvent } from "../push-events.js";
import type { Command } from "../../core/contracts.js";

/** The station broadcast channel the HomeBase's own controls ride (not a device channel). */
const STATION_CHANNEL = 255;

/**
 * The guard modes {@link ArmingActions} can SET. `ArmingMode` is both the const value-object
 * (`ArmingMode.home`) and the union type of its values, so callers pass the named constant:
 * `setMode(ArmingMode.home)`.
 *
 * Deliberately NARROWER than the set a device may report. The other five modes are ones the app itself
 * defines and the `mode` read still names them, but no capture shows one being SENT — and on a
 * fire-and-forget wire a wrong one looks exactly like success. Leaving them out of this union is the
 * compile-time half of the refusal; `mode`'s published argument and the generated rejection are the
 * runtime half.
 *
 * `custom1` is the one exception admitted without its OWN byte capture on this SDK: the wire envelope
 * for every settable mode is identical bar the `mode_type` integer (confirmed byte-exact for away/home/
 * disarmed), and a prior, independent integration wrote `mode_type: 3` (custom1) live against this same
 * account/station and had it reflected correctly — a real-world confirmation this SDK's own capture
 * session never happened to exercise, not a guess. Which mode custom1 represents is account-specific
 * (whatever the Eufy app's schedule has configured for that slot), so an integration mapping it to a
 * concrete meaning (e.g. "Night") owns that interpretation, not this SDK.
 */
export const ArmingMode = {
  /** Armed — full protection, nobody home (wire value 0). */
  away: "away",
  /** Armed for occupancy — reduced/perimeter protection while home (wire value 1). */
  home: "home",
  /** A custom guard-mode slot (wire value 3) — meaning is whatever the Eufy app's schedule configures
   * for it on a given account; see the class doc for why this one's admitted without its own capture. */
  custom1: "custom1",
  /** Disarmed — no alarms; sensors still report state (wire value 63). */
  disarmed: "disarmed",
} as const;
export type ArmingMode = (typeof ArmingMode)[keyof typeof ArmingMode];

/**
 * The P2P **feature-command ids** this arming capability drives. Capability-owned wire vocabulary
 * (transport forwards `cmd.param` opaquely; full id→name catalog in the generated
 * `transport/p2p/commands.ts`).
 */
export const ARMING_CMD = {
  /**
   * Guard/arming mode (app `GUARD_MODE`). ✅ Wire ENVELOPE verified live on a T8030 (
   * 2026-07-23), cycling Away→Disarmed→Home in the
   * real app: `1350` SET_PAYLOAD, cmd 1224 (SAME id as the read param), mChannel 0, explicit
   * mValue3:0, `payload:{mode_type:<int>, user_name:<string>}`.
   *
   * ⚠️ Only 3 of the 9 modes were exercised in that capture — `mode_type` 0 (away), 63 (disarmed), 1
   * (home), all confirmed byte-exact. Re-confirmed live 2026-08-05: each reported its own MODE_SWITCH
   * push within ~5s of the write. A fourth, `mode_type` 3 (custom1), is also settable on the strength of
   * a prior integration's live write against this same account — see {@link ArmingMode}'s doc for why
   * that counts despite this SDK's own capture never exercising it. The remaining five are named by the
   * app but never observed leaving it in ANY integration, so this capability reads them and refuses to
   * send them. See `ARMING_MODE_WIRE` for the per-value breakdown.
   */
  SET_ARMING: 1224,
  /**
   * The per-mode alarm/arm-delay configuration write. ✅ WIRE CAPTURED live on a T8030 (
   * 2026-07-23, both directions): a **bare
   * JSON frame, no `1350`/`1700` envelope** — outer P2P cmd IS `1255` itself, station channel 255,
   * plaintext `{account_id, count_down_alarm:{channel_list,delay_time},
   * count_down_arm:{channel_list,delay_time}, devices:[{action,device_channel}], mode_id,
   * siren_sensor_action:[{action,device_channel}]}`.
   *
   * **Disambiguated from a live-countdown-state echo** (2026-07-23): a full arm→wait-through-exit-
   * delay→disarm cycle produced ZERO traffic on this cmd, while every edit of the app's "Alarm Delay"
   * screen did — so this is a genuine settings WRITE, not a realtime push.
   *
   * **Why `setAlarmDelayConfig` takes the FULL config, not just a duration**: `channelList` identifies
   * WHICH sensor channels get the delay (confirmed: setting 45s on one specific sensor produced
   * `channel_list:[<that sensor's channel>], delay_time:45`) — it is not a simple on/off. The
   * corresponding GET command (`1310`/inner cmd `40003`, sent by the app right before editing) always
   * replied `{count:0,data:null}` in every capture — genuinely empty, not a decrypt failure (confirmed
   * via the same bidirectional decrypt this finding used) — so the app does NOT read the current
   * config this way; how it does is still unknown. Without a working GET, safely PATCHING just one
   * channel in or out of an existing list isn't possible without risking clobbering the rest — so
   * this ships as a caller-supplies-everything write instead of guessing a merge.
   * `devices`/`siren_sensor_action` are even less understood (raw per-device action codes, meaning
   * unconfirmed) and MUST come from a value independently read/captured for the target mode —
   * see `AlarmDelayConfig`'s field docs.
   */
  ALARM_DELAY_CONFIG: 1255,
} as const;

/**
 * Guard-mode name → the wire's `mode_type` integer, for every mode a station may REPORT. Fixed (not
 * model-dependent) — the single source of truth {@link ARMING_MODE_LABELS} (the `armingMode`
 * PropertySpec's `enumValues`) derives from.
 *
 * The READ side is why all nine are here: a station set to a schedule reports 2, and a getter answering a
 * number nothing can name is worse than one naming a mode we cannot set. The WRITE side takes only the
 * four of {@link ArmingMode} — {@link SETTABLE_MODES} is that subset, derived from this table rather than
 * listed again.
 *
 * **The names and integers are the V6 app's own** (`SecurityGuardConstants`, mirrored by `GuardConstant`),
 * so the read mapping is APK ground truth for the whole set rather than a borrowed label. Provenance for a
 * NAME is not authority for a WRITE, which is the split that matters here:
 *
 * ✅ WRITE WIRE-CAPTURED (byte-exact, a T8030 2026-07-23; all three re-confirmed live 2026-08-05, each
 * reporting its own MODE_SWITCH push within ~5s): `away` 0, `home` 1, `disarmed` 63.
 * ✅ WRITE CONFIRMED LIVE BY A PRIOR INTEGRATION (not this SDK's own capture, but the same account/
 * station, reflected correctly): `custom1` 3 — see {@link ArmingMode}'s doc.
 * ⚠️ WRITE NEVER CAPTURED BY EITHER: `schedule` 2, `custom2` 4, `custom3` 5, `off` 6, `geo` 47. The app
 * defines each, but no capture shows one leaving the app, so sending one would be a fire-and-forget write
 * that looks like success whatever the device does with it. Add the mode to {@link ArmingMode} (and flip
 * this note plus {@link ARMING_CMD.SET_ARMING}) as each is captured.
 */
const ARMING_MODE_WIRE: Record<ArmingMode, number> & Record<string, number> = {
  away: 0,
  home: 1,
  schedule: 2, // ⚠️ reportable, NOT settable — see the doc comment above
  custom1: 3,
  custom2: 4, // ⚠️ reportable, NOT settable — see the doc comment above
  custom3: 5, // ⚠️ reportable, NOT settable — see the doc comment above
  off: 6, // ⚠️ reportable, NOT settable — see the doc comment above
  geo: 47, // ⚠️ reportable, NOT settable — see the doc comment above
  disarmed: 63,
};

/**
 * The `armingMode` PropertySpec's `enumValues` (wire int → label) — derived from
 * `ARMING_MODE_WIRE` instead of hand-listed a second time, so the two can't drift out of sync.
 */
const ARMING_MODE_LABELS: Record<number, string> = enumLabels(ARMING_MODE_WIRE);

/**
 * The wire integers `setMode` offers and accepts — {@link ArmingMode} resolved through the same table the
 * labels come from, so the offered set cannot name a mode the write would build differently.
 *
 * Published as the `mode` member's argument `values`, which is what makes it the domain the check and the
 * generated refusal both use: a caller is offered three and held to three, while the read still reports
 * all nine.
 */
const SETTABLE_MODES: readonly number[] = Object.values(ArmingMode).map((m) => ARMING_MODE_WIRE[m]);

/**
 * The SETTABLE mode a caller named, from EITHER vocabulary: the name (`"away"`) or the wire integer the
 * `mode` getter answers (`0`). A mode the station can report but not accept resolves to nothing, and the
 * derived setter refuses it.
 *
 * The getter's value has to be settable back. Matching names alone made `setMode(dev.arming().mode)`
 * refuse every time, with a generated message that listed as valid exactly the integer it had just
 * rejected — the getter publishes {@link ARMING_MODE_LABELS}, keyed by wire value, as its own domain.
 */
function armingModeOf(v: boolean | number | string): ArmingMode | undefined {
  const name = String(v);
  if (name in ArmingMode) return name as ArmingMode;
  const wire = Number(v);
  return (Object.values(ArmingMode) as ArmingMode[]).find((m) => ARMING_MODE_WIRE[m] === wire);
}

/**
 * Build the {@link ARMING_CMD.SET_ARMING} write intent, or throw if the context has no account
 * identity. `user_name` — the real app's own capture showed a MASKED value (`"max***"`, presumably
 * the app's own privacy-display truncation of the account's email local-part), not the raw
 * local-part `ctx.accountName` holds. Untested whether the device validates this field strictly;
 * sending our real (unmasked) identity is the more correct choice regardless — it's almost certainly
 * just attribution (e.g. "who armed the system" in event history), not a value the device checks
 * against anything.
 */
function armingCommand(mode: ArmingMode, ctx: CommandContext): Command {
  const modeType = ARMING_MODE_WIRE[mode];
  if (!ctx.accountName) {
    throw new Error(`arming: missing account identity (user_name) [${describeDevice(ctx)}]`);
  }
  return setPayload(ARMING_CMD.SET_ARMING, { mode_type: modeType, user_name: ctx.accountName }, ctx, 0);
}

/**
 * Alarm-delay durations the app's OWN picker UI offers — `AlarmDelaySeconds` is both the const
 * value-object (`AlarmDelaySeconds.sec45`) and the union type of its values, so callers pass the
 * named constant: `{delaySeconds: AlarmDelaySeconds.sec45}`.
 *
 * **NOT a wire constraint** — the device itself does NOT validate against this list: a live test sent
 * `50` (off this list) and the app reflected it correctly, no rejection. Typed as a closed set anyway
 * so `setAlarmDelayConfig` callers get the same choices a human editing the same setting in the app
 * would see, rather than an arbitrary int that could silently diverge from every value the real UI
 * can actually produce.
 */
export const AlarmDelaySeconds = {
  off: 0,
  sec15: 15,
  sec30: 30,
  sec45: 45,
  sec60: 60,
  min3: 180,
  min5: 300,
} as const;
export type AlarmDelaySeconds = (typeof AlarmDelaySeconds)[keyof typeof AlarmDelaySeconds];

/** One `channelList`+`delaySeconds` countdown pair — see {@link AlarmDelayConfig}. */
export type AlarmDelayCountdown = {
  /** Device channels this countdown applies to. */
  channelList: number[];
  /** Delay duration — one of {@link AlarmDelaySeconds}, shared across every channel in `channelList`. */
  delaySeconds: AlarmDelaySeconds;
};

/** One device's participation entry in {@link AlarmDelayConfig.devices} / `.sirenSensorAction`. */
export type AlarmDelayDeviceAction = {
  deviceChannel: number;
  /** Raw per-device action code. Meaning NOT independently confirmed — pass through verbatim from a
   * value read/captured for this exact mode, never invented. */
  action: number;
};

/**
 * The FULL per-mode alarm/arm-delay configuration the device accepts as one write — see the
 * `setAlarmDelayConfig` doc for why this is a caller-supplies-everything shape rather than a simple
 * `setEntryDelay(seconds)` toggle.
 */
export type AlarmDelayConfig = {
  /** Per-sensor ENTRY/alarm delay — the app's "Alarm Delay" UI setting. Confirmed on-device: a delay
   * set on one sensor lands as that sensor's channel plus the chosen duration. */
  countDownAlarm: AlarmDelayCountdown;
  /** A second, distinct countdown carried alongside `countDownAlarm`. It stayed empty across every
   * observed `countDownAlarm` edit, so its own trigger condition is UNCONFIRMED. */
  countDownArm: AlarmDelayCountdown;
  /** Every device's participation + action for THIS mode. UNCONFIRMED semantics (the action code's
   * meaning is unknown) — it stayed identical across every `countDownAlarm`-only edit within the same
   * mode, so pass through exactly what was read back for that mode; never invent a value. */
  devices: AlarmDelayDeviceAction[];
  /** Siren behavior per device for this mode. Same caveat as `devices`. */
  sirenSensorAction: AlarmDelayDeviceAction[];
};

/**
 * Build the alarm-delay `cmd 1255` write intent. Bare JSON, no envelope (`setJsonRaw`) — see
 * the full config. Pinned to the station broadcast channel (255), NOT
 * `ctx.channel` (which resolves to 0 for a station context) — the capture put this frame on channel
 * 255 explicitly, same as every other station-scoped bare/scalar write in the router.
 */
function alarmDelayCommand(mode: ArmingMode, config: AlarmDelayConfig, ctx: CommandContext): Command {
  const data = {
    mode_id: ARMING_MODE_WIRE[mode],
    count_down_alarm: {
      channel_list: config.countDownAlarm.channelList,
      delay_time: config.countDownAlarm.delaySeconds,
    },
    count_down_arm: { channel_list: config.countDownArm.channelList, delay_time: config.countDownArm.delaySeconds },
    devices: config.devices.map((d) => ({ action: d.action, device_channel: d.deviceChannel })),
    siren_sensor_action: config.sirenSensorAction.map((d) => ({ action: d.action, device_channel: d.deviceChannel })),
  };
  return setJsonRaw(ARMING_CMD.ALARM_DELAY_CONFIG, data, ctx, STATION_CHANNEL);
}

/**
 * Bound guard-mode controls — the object returned by `dev.arming()`.
 *
 * Everything is DERIVED from `ARMING_MEMBERS`. `setMode` is the mode member's own derived setter;
 * `setAlarmDelayConfig` is a `method` because it takes TWO arguments (a mode and a whole config),
 * which no value setter can express.
 */
export type ArmingActions = Surface<typeof ARMING_MEMBERS>;

/**
 * Every `arming` feature, declared once.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on,
 * which the reference site does not carry.
 * @internal
 */
export const ARMING_MEMBERS = {
  /**
   * The one member whose write domain is NARROWER than its read: `enumValues` names all nine modes a
   * station can report, and the argument's `values` publishes only the four confirmed settable. That
   * argument IS the domain the derived setter enforces and the refusal names, so an unconfirmed mode is
   * refused by naming the four that work — nine labels for the read and four for the write, off one
   * declaration.
   *
   * `armingCommand` may also throw synchronously (missing account identity) and `bindMembers` turns that
   * into a rejection, so the builder stays plain.
   *
   * The setter takes either vocabulary — see `armingModeOf` — because the getter answers the wire integer,
   * and a value a caller just read has to be one it can write back.
   *
   * MODE_SWITCH's own carried value (see `ARMING.events`'s `currentMode`) is the RESOLVED live mode,
   * not necessarily this property's own policy value (`armingMode` reads back `schedule` itself, even
   * while the push's value is whatever the schedule just resolved to) — so it is not trusted as this
   * property's own readback. Live qualification on a standalone camera showed that authoritative
   * readback requires a bounded cloud-list refresh, and that its P2P session must be reset after
   * convergence before a following mode write; an attached device must never reset its shared HomeBase.
   */
  mode: {
    param: ARMING_CMD.SET_ARMING,
    property: "armingMode",
    type: "enum",
    kind: "enum",
    enumValues: ARMING_MODE_LABELS,
    provenance: "verified",
    args: [{ name: "mode", kind: "enum", values: SETTABLE_MODES }],
    description:
      "Guard mode (verified: param 1224 = GUARD_MODE, read/write mechanism confirmed). Reads all 9 modes " +
      "the app defines; SETS only the 4 confirmed settable (away/home/custom1/disarmed) — " +
      "schedule/custom2/custom3/off/geo are named by the app but no capture shows one being sent, " +
      "so they are refused rather than guessed; see ARMING_MODE_WIRE in arming.ts for the breakdown.",
    observation: {
      event: "armingModeChanged",
      reflects: (value) => ({ param: ARMING_CMD.SET_ARMING, expected: ARMING_MODE_WIRE[armingModeOf(value)!] }),
      resetStandaloneSession: true,
      timeoutMs: 20_000,
    },
    write: (v, ctx) => {
      const mode = armingModeOf(v);
      return mode ? armingCommand(mode, ctx) : undefined;
    },
    ...accepts<ArmingMode>(),
  },

  /**
   * Write the FULL per-mode alarm/arm-delay configuration. The device accepts the whole config as one
   * write, not a single duration field, so a partial update is not possible. An expert/advanced API: the
   * caller is responsible for supplying `devices`/`sirenSensorAction` (and the `countDownAlarm`/
   * `countDownArm` entries they are NOT changing) from a value they have independently read/captured for
   * this mode — there is no known GET to fetch it automatically, and a wrong guess here can silently
   * misconfigure which sensors arm/trigger for real.
   *
   * Takes {@link ArmingMode}, so a delay can only be configured for a mode whose `mode_id` integer is
   * captured. The frame carries that same integer, so a schedule/custom mode would be the identical guess
   * `setMode` refuses.
   */
  setAlarmDelayConfig: method(
    ({ ctx, sink }) =>
      (mode: ArmingMode, config: AlarmDelayConfig): Promise<void> => {
        try {
          return sink.dispatch(alarmDelayCommand(mode, config, ctx));
        } catch (e) {
          return Promise.reject(e);
        }
      },
    "Write the full per-mode alarm/arm-delay configuration.",
  ),
} as const satisfies Members;

/**
 * `arming` — guard/arming mode. `armingMode` (see {@link ARMING_CMD.SET_ARMING}) has a verified
 * read/write MECHANISM; 9 modes are reportable, but only 4 (away/home/custom1/disarmed) are confirmed
 * settable — see `ARMING_MODE_WIRE` for which 5 are still unconfirmed third-party integers.
 */
export const ARMING: CapabilityModule = {
  capability: "arming",
  description: "Station/device guard (arming) mode.",
  members: ARMING_MEMBERS,
  properties: propertiesOf(ARMING_MEMBERS),
  // A reported guard-mode param is the verified proof; every station-codec device also owns an
  // arming surface as part of its baseline.
  detection: { evidenceParams: [ARMING_CMD.SET_ARMING], codecs: ["station"] },
  ownedByStation: true,
  /**
   * Station-scoped push events. The hub reports a guard-mode switch and the alarm lifecycle on the
   * generic `CusPushEvent` channel, so these ids are shared with other families and resolve by
   * capability (see the barrel's event index).
   *
   * The alarm ids carry a static `phase` so one event name covers the whole lifecycle, the same shape
   * `battery` uses for its threshold pushes. The mode-switch push refreshes the `mode` read rather than
   * trusting a decoded field for the transition itself — but it also carries the push's own `mode`
   * field, attached here as `currentMode`. That field is a DIFFERENT thing from `mode`/`armingMode`:
   * when the station's policy is `schedule` or `geo`, `armingMode` reads back that literal policy name
   * forever, never what the schedule has actually resolved to right now — a device set to a schedule
   * cycling Home/Night would otherwise report nothing but "schedule" indefinitely. `currentMode` is
   * this push's own resolved value at the moment of the switch, which is exactly the field a prior,
   * separate integration used for this — its own push handling decoded and forwarded the identical
   * field. Best-effort and UNCONFIRMED by this SDK's own capture session specifically for this
   * semantic (see `mode`'s doc), so consume it accordingly.
   */
  events: [
    {
      source: "push",
      match: CusPushEvent.MODE_SWITCH,
      emit: "armingModeChanged",
      refresh: { member: "mode" },
      derive: (s) => {
        if (s.source !== "push") return {};
        const raw = s.payload?.["mode"];
        const wire = typeof raw === "number" ? raw : Number(raw);
        return Number.isFinite(wire) && wire in ARMING_MODE_LABELS ? { currentMode: ARMING_MODE_LABELS[wire] } : {};
      },
    },
    { source: "push", match: CusPushEvent.ALARM, emit: "alarm", payload: { phase: "triggered" } },
    { source: "push", match: CusPushEvent.ALARM_DELAY, emit: "alarm", payload: { phase: "delayed" } },
  ],
};
