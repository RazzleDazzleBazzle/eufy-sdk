<div align="center">

<!--
  The suffix names the MODE, not the ink: logo-dark.svg is the white glyph for a dark background,
  logo.svg the near-black one for a light background. The fallback <img> must be the light-mode file,
  since that is what any renderer without prefers-color-scheme support will show.
-->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/mega-yfue/eufy-sdk/main/docs/public/logo-dark.svg">
  <img src="https://raw.githubusercontent.com/mega-yfue/eufy-sdk/main/docs/public/logo.svg" alt="eufy-sdk" height="72">
</picture>

**One typed client for the whole Anker eufy ecosystem — devices, realtime events, and live media.**

[![npm](https://img.shields.io/npm/v/@razzledazzlebazzle/eufy-sdk?logo=npm&color=cb3837)](https://www.npmjs.com/package/@razzledazzlebazzle/eufy-sdk)
[![CI](https://github.com/mega-yfue/eufy-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/mega-yfue/eufy-sdk/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@razzledazzlebazzle/eufy-sdk?logo=nodedotjs)](./.nvmrc)
[![license](https://img.shields.io/npm/l/@razzledazzlebazzle/eufy-sdk)](./LICENSE)

[Documentation](https://mega-yfue.github.io/) · [Contributing](./CONTRIBUTING.md) · [Changelog](./CHANGELOG.md)

</div>

---

## What it is

A TypeScript SDK for the Anker eufy cloud that the current eufy app speaks. It logs in (captcha and 2FA
included), keeps a **persistent session**, and models every device as a capability-driven `Device`
you drive through a **typed, fluent API**:

```ts
const dev = await eufy.getDevice(sn);

const stored = await dev.camera?.()?.snapshotStored?.(); // latest retained push JPEG
const fresh = await dev.camera?.()?.snapshotLive?.(); // explicit fresh live capture
await dev.ptz?.()?.rotate(PtzDirection.left);
await dev.light?.()?.setBrightness(60);

eufy.on("motion", (e) => console.log(e.deviceSn, "saw something"));
```

Accessors and methods are optional because both are **evidence-gated**: a device exposes exactly the
features it reported, so the optionality states that one may be absent. An **unverified write path
throws** rather than send a frame it cannot stand behind.

Realtime arrives over **P2P** (cameras and HomeBases), **secure MQTT** (appliances) and **push**
(events), all surfaced as typed semantic events. Live **video streaming** works, with one shared pull
fanned out to every consumer.

The SDK targets the **whole** ecosystem — security, robot vacuums and mowers, smart lights — not just
cameras. Devices are classified dynamically from what the account reports, so there is no per-model
code path and an unlisted or future device resolves the same way as a known one.

## Install

```bash
npm install @razzledazzlebazzle/eufy-sdk         # latest stable
npm install @razzledazzlebazzle/eufy-sdk@beta    # the prerelease of the version in review
```

**Node.js ≥ 24.5.0** is required, not just recommended (see [`.nvmrc`](./.nvmrc)). `ffmpeg` is
optional — only the live JPEG snapshot and one-shot mp4 record paths use it,
and a host that ships its own build names it with `new EufyMega({ ffmpegPath })` rather than needing
one on `PATH`.

## Documentation

The guides at **<https://mega-yfue.github.io/>** cover installing and logging in, devices and
capabilities, events and realtime transports, consuming live media, and the generated API reference.
Runnable, typechecked samples live in [`examples/`](./examples/).

The architecture — four layers with one dependency direction, and the CI-enforced rule that keeps
capabilities and transports from importing each other — is in [AGENTS.md](./AGENTS.md), with the rest of
the code practice.

## Develop

```bash
nvm use            # Node 24.5.0
npm install
npm run verify     # the full CI gate in one command — run it green before a PR
```

## Contributing

PRs welcome. [CONTRIBUTING.md](./CONTRIBUTING.md) covers setup, the dev workflow and the PR process;
[AGENTS.md](./AGENTS.md) is the code practice — the architecture invariants and the rules CI enforces.
Security issues go through [SECURITY.md](./SECURITY.md), never a public issue.

## Thanks

Huge thanks to the testers who run this against real hardware and make sure it's ready — they are
credited in the release notes for the version their work landed in.

## License

[Apache-2.0](./LICENSE). Contributions are accepted under the same license (inbound = outbound).

## Disclaimer

Independent and unofficial, built for interoperability with Anker eufy devices you own. **Not
affiliated with, endorsed by, or sponsored by Anker Innovations, Anker eufy, or eufy.** "Anker eufy",
"eufy" and "Anker" are trademarks of their respective owners and appear here only to identify the
hardware this SDK talks to. Use responsibly — rapid or failed logins can trigger a captcha or a
temporary cooldown.

The vendor now brands the line **Anker eufy**; "eufy" alone is the short form and still the name on
the wire (`eufy_security`, `eufy_life`, `eufy_mega`) and in every product name (eufyCam, eufy Clean,
eufy Life). Protocol vocabulary follows the device, not the marketing, so those are not renamed here.
