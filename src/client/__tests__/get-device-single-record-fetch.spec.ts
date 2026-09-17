import { describe, it, expect, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";

/**
 * `getDevice` resolves one `registry.record()` call to build the `Device` — and used to let
 * `commandContext` (which it also calls) resolve its OWN, separate one for the exact same serial: two
 * real cloud round-trips for identical per-device data, on every single `getDevice()` call. Fixed by
 * handing `commandContext` the record `getDevice` already has, rather than letting it fetch its own.
 *
 * Matters at scale: `deviceList()` resolves N devices via `Promise.all`, so this used to mean 2N
 * concurrent per-device cloud fetches for one `devices.list` — twice the surface area for a single slow
 * straggler among them to blow a caller's timeout, which HA's own `devices.list` RPC (15s) does exactly
 * that on.
 */
describe("getDevice resolves the device record only once", () => {
  it("does not ask the registry for the same serial's record twice", async () => {
    const eufy = new EufyMega({ email: "t@example.com", password: "x" });
    const record = { model: "T8900", category: "eufy_security", params: { 1550: "0" }, paramUpdatedAt: {} };
    const registry = (eufy as any).registry;
    const recordSpy = vi.spyOn(registry, "record").mockResolvedValue(record);
    vi.spyOn(registry, "require").mockReturnValue({ raw: {}, category: "eufy_security" });
    vi.spyOn(eufy as any, "awaitFirstRealtimeState").mockResolvedValue(undefined);
    vi.spyOn(eufy as any, "commandSinkFor").mockReturnValue({ dispatch: async () => undefined });
    vi.spyOn(eufy as any, "mediaProviderFor").mockReturnValue(undefined);
    vi.spyOn(eufy as any, "ff09SettingsReaderFor").mockReturnValue(undefined);

    await eufy.getDevice("T8000P0000000000");

    expect(recordSpy).toHaveBeenCalledTimes(1);
  });
});
