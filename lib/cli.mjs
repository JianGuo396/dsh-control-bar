#!/usr/bin/env node
/**
 * dsh-control-bar —— 命令行
 *
 * 模型走 control_bar 工具，人走这个 CLI；两者写同一个状态文件，可以混着用。
 *
 *   dsh-control-bar start "正在打开浏览器搜索…"   # 出现状态栏，0%
 *   dsh-control-bar 45 "已打开结果页"             # 进度 45%（文字可省，沿用上一次）
 *   dsh-control-bar done "找到了"                 # 补到 100%，停留 1 秒后消失
 *   dsh-control-bar hide                          # 立刻消失
 *   dsh-control-bar status                        # 峰谷 + 当前状态 + 顶栏进程
 *   dsh-control-bar peak                          # 只看峰谷
 *   dsh-control-bar overlay [start|stop|status]    # 手动拉起 / 关掉顶栏进程
 */
import { createRequire } from 'node:module'

import {
  resolveConfig,
  writeState,
  readState,
  ensureOverlay,
  stopOverlay,
  overlayPid,
  currentPhase,
  stateFile,
} from './control.js'

const require = createRequire(import.meta.url)
const Phase = require('./phase.cjs')

const argv = process.argv.slice(2)
const cmd = String(argv[0] || '').trim()
const rest = argv.slice(1).join(' ').trim()
const cfg = resolveConfig()

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function overlayState() {
  const pid = overlayPid(cfg)
  return { running: pid > 0, pid, stateFile: stateFile(cfg) }
}

function phaseState() {
  const info = currentPhase(cfg)
  return {
    phase: info.phase,
    reason: info.reason,
    multiplier: info.multiplier,
    localDate: info.localDate,
    localTime: info.localTime,
    nextPhase: info.nextPhase,
    switchInMinutes: info.minutesUntil,
    summary: Phase.summarize(info),
  }
}

function report(state) {
  print({ ok: true, state, overlay: overlayState(), phase: phaseState() })
}

if (cmd === '' || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  process.stdout.write([
    'usage:',
    '  dsh-control-bar start "<text>"      show the bar at 0%',
    '  dsh-control-bar <0-100> ["<text>"]  set progress',
    '  dsh-control-bar done ["<text>"]     fill to 100% then hide',
    '  dsh-control-bar hide                hide immediately',
    '  dsh-control-bar status              phase + state + overlay pid',
    '  dsh-control-bar peak                current peak / off-peak',
    '  dsh-control-bar overlay start|stop  control the overlay process',
    '',
  ].join('\n'))
  process.exit(cmd === '' ? 2 : 0)
} else if (cmd === 'start' || cmd === 'begin') {
  const overlay = ensureOverlay(cfg)
  report(writeState(cfg, { active: true, percent: 0, done: false, text: rest || '正在操控你的电脑' }))
  if (!overlay.running) {
    process.stderr.write(`overlay not running: ${overlay.reason || 'unknown'}${overlay.hint ? ' — ' + overlay.hint : ''}\n`)
    process.exitCode = 1
  }
} else if (cmd === 'done' || cmd === 'end' || cmd === 'finish') {
  report(writeState(cfg, { active: false, percent: 100, done: true, text: rest || '操作完成' }))
} else if (cmd === 'hide' || cmd === 'stop') {
  report(writeState(cfg, { active: false, done: false, text: '' }))
} else if (/^\d{1,3}%?$/.test(cmd)) {
  report(writeState(cfg, { active: true, percent: Number.parseInt(cmd, 10), done: false, text: rest }))
} else if (cmd === 'status') {
  print({
    state: readState(cfg),
    overlay: overlayState(),
    phase: phaseState(),
    config: {
      timezone: cfg.pricing.timezone,
      windows: cfg.pricing.windows,
      holidays: cfg.pricing.holidays,
      overlayEnabled: cfg.overlay.enabled,
      tokenThreshold: cfg.gate.tokenThreshold,
    },
  })
} else if (cmd === 'peak' || cmd === 'phase') {
  print(phaseState())
} else if (cmd === 'overlay') {
  const sub = String(argv[1] || 'status').trim()
  if (sub === 'start') {
    const result = ensureOverlay(cfg)
    print(result)
    if (!result.running) process.exitCode = 1
  } else if (sub === 'stop') {
    print(stopOverlay(cfg))
  } else if (sub === 'status') {
    print({ ...overlayState(), dataDir: cfg.dataDir })
  } else {
    process.stderr.write(`unknown overlay subcommand: ${sub}\n`)
    process.exitCode = 2
  }
} else if (cmd === 'watch') {
  // 排障用：跟着状态文件打日志
  let last = ''
  setInterval(() => {
    const line = JSON.stringify(readState(cfg))
    if (line !== last) {
      last = line
      process.stdout.write(`${line}\n`)
    }
  }, 300)
} else {
  // `dsh-control-bar start 正在…` 被 shell 拆成多个参数时，整行当文案
  const overlay = ensureOverlay(cfg)
  report(writeState(cfg, { active: true, percent: 0, done: false, text: argv.join(' ').trim() || '正在操控你的电脑' }))
  if (!overlay.running) process.stderr.write(`overlay not running: ${overlay.reason || 'unknown'}\n`)
}
