<p align="center">
  <img src="assets/demo-zh.png" alt="A always-on-top bar at the top of the screen showing control progress and the current DeepSeek peak/off-peak badge">
</p>

# dsh-control-bar

Whenever the agent starts driving your computer (moving the mouse, typing, running commands
that change state), a slim status bar stays pinned to the top of the screen: **正在操控**
(“controlling”) plus what it is doing right now, an honest percentage, and a badge telling you
whether DeepSeek is currently in **peak** or **off-peak** pricing hours.

Peak tokens cost twice as much as off-peak ones, so the plugin also ships a policy:
**expensive operations ask for your confirmation during peak hours, and just run off-peak.**

[中文说明](README.zh.md)

## Install

In DSH Desktop: **Plugins → Plugin Market**, search `dsh-control-bar`, install, restart.
Or from a CLI (`desktop` = your profile name):

```sh
dsh plugin --profile desktop add dsh-control-bar
```

The bar is a separate Electron process, so it needs an Electron binary. Lookup order:
`overlay.electronPath` → `DSH_CONTROL_BAR_ELECTRON` → `DSH_ELECTRON_PATH` → `$DSH_HOME/electron`
→ `~/.dsh/electron` (installing [dsh-pet](https://www.npmjs.com/package/dsh-pet) puts one there).
If nothing is found the bar is skipped, everything else keeps working, and the host logs
`overlay not running (electron-not-found)`.

## Usage

Nothing to do after installing: the plugin adds a prompt section and the agent maintains the bar.

1. start — `control_bar` with `action:"start"`, `text:"<what this round is about>"`;
2. each visible step — `action:"update"`, `percent:<0-100>`;
3. end — `action:"finish"` (the bar fills to 100% before fading out).

Manual control, also handy from scripts:

```sh
dsh-control-bar 35 "opening the browser to search"
dsh-control-bar hide
dsh-control-bar peek                       # current phase + next switch
dsh-control-bar overlay start|stop|status
```

## Peak / off-peak windows

| | Beijing time | Price |
| --- | --- | --- |
| Peak | Mon–Fri 09:00–12:00 and 14:00–18:00 (UTC 01:00–04:00, 06:00–10:00), excluding statutory holidays | ×2 |
| Off-peak | everything else, including weekends and holidays | ×1 |

Off-peak rates are half of peak rates per DeepSeek's pricing notes. Public holidays for 2026 are
bundled, so the check needs no network. Override `pricing.windows` / `pricing.holidays` if your
account uses a different schedule.

Gate rules written into the system prompt: during peak, a large token operation (default
threshold ≈ 200k tokens) must write `text:"峰时大额操作，等你确认"`, ask you with three options
(do it now / wait for off-peak / narrow the scope) and only continue after you pick one; off-peak
it just runs; small reads are never gated.

## Configuration

```yaml
- id: dsh-control-bar
  name: dsh-control-bar
  config:
    overlay:
      enabled: true
      height: 34
      electronPath: ''
      staleMs: 300000
    pricing:
      timezone: Asia/Shanghai
      windows: '09:00-12:00,14:00-18:00'
      holidays: cn-2026
    gate:
      enabled: true
      tokenThreshold: 200000
    dataDir: ''
```

## Privacy

No network calls, no telemetry. The overlay only reads a local `state.json` (a number and a
string). Its renderer is sandboxed, unfocusable, and click-through, so it never blocks the window
you are working in.

## License

MIT
