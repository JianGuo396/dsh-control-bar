/**
 * control.js —— 状态文件 + 覆盖层进程的宿主侧管理器。
 *
 * 状态文件是唯一的真相来源：宿主/CLI 原子写入，覆盖层进程每 200ms 轮询一次的
 * 只有这一个文件。这样"改状态栏"永远只用一次文件写入，不需要任何 IPC 通道，
 * 覆盖层重启、宿主重启都不会丢状态。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const phase = require('./phase.cjs')
const HERE = dirname(fileURLToPath(import.meta.url))

export const DEFAULTS = {
  overlay: {
    enabled: true,
    height: 34,
    /** 留空则自动探测 ~/.dsh/electron/electron[.exe] */
    electronPath: '',
    /** 默认状态栏挂多久没更新就当陈旧自动隐藏（毫秒） */
    staleMs: 5 * 60 * 1000,
  },
  pricing: {
    timezone: 'Asia/Shanghai',
    windows: '09:00-12:00,14:00-18:00',
    holidays: 'cn-2026',
  },
  gate: {
    enabled: true,
    /** 超过这个 token 量级的操作算"大额" */
    tokenThreshold: 200000,
  },
  /** 状态文件与覆盖层 userData 的目录，留空 = $DSH_HOME/control-bar */
  dataDir: '',
}

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function pick(source, fallback) {
  const out = { ...fallback }
  if (!source || typeof source !== 'object') return out
  for (const key of Object.keys(fallback)) {
    const value = source[key]
    if (value === undefined || value === null) continue
    if (typeof fallback[key] === 'object' && !Array.isArray(fallback[key])) {
      out[key] = pick(value, fallback[key])
    } else {
      out[key] = typeof fallback[key] === 'number' ? Number(value) : value
    }
  }
  return out
}

/** 合并默认值，并顺手把峰谷配置编译成 phase.cjs 能吃的样子 */
export function resolveConfig(raw) {
  const cfg = pick(raw, DEFAULTS)
  if (!cfg.dataDir) cfg.dataDir = join(dshHome(), 'control-bar')
  if (!Number.isFinite(cfg.overlay.height)) cfg.overlay.height = DEFAULTS.overlay.height
  cfg.overlay.height = Math.max(18, Math.min(120, Math.round(cfg.overlay.height)))
  cfg.gate.tokenThreshold = Number.isFinite(cfg.gate.tokenThreshold) && cfg.gate.tokenThreshold > 0
    ? Math.round(cfg.gate.tokenThreshold)
    : DEFAULTS.gate.tokenThreshold
  cfg.phaseConfig = phase.makeConfig({ pricing: cfg.pricing })
  return cfg
}

export function stateFile(cfg) {
  return join(cfg.dataDir, 'state.json')
}

export function pidFile(cfg) {
  return join(cfg.dataDir, 'overlay.pid')
}

export function currentPhase(cfg, now) {
  return phase.describe(now, cfg.phaseConfig)
}

function emptyState() {
  return { active: false, percent: 0, done: false, text: '', ts: 0 }
}

export function readState(cfg) {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(cfg), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return emptyState()
    return {
      active: parsed.active === true,
      percent: Number.isFinite(Number(parsed.percent)) ? clampPercent(parsed.percent) : 0,
      done: parsed.done === true,
      text: typeof parsed.text === 'string' ? parsed.text : '',
      ts: Number(parsed.ts) || 0,
    }
  } catch {
    return emptyState()
  }
}

export function clampPercent(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(100, Math.max(0, Math.round(n)))
}

/**
 * 写一条状态。text 传空串表示"沿用上一次的文字"，这样只更新进度时不用重复整句话。
 * 写入是原子的（临时文件 + rename），覆盖层不会读到半截 JSON。
 */
export function writeState(cfg, patch) {
  const prev = readState(cfg)
  const text = typeof patch.text === 'string' && patch.text.trim() !== ''
    ? patch.text.trim().slice(0, 160)
    : prev.text
  const next = {
    active: patch.active === undefined ? prev.active : Boolean(patch.active),
    percent: patch.percent === undefined ? prev.percent : clampPercent(patch.percent),
    done: patch.done === undefined ? false : Boolean(patch.done),
    text,
    ts: Date.now(),
  }
  mkdirSync(cfg.dataDir, { recursive: true })
  const body = JSON.stringify(next)
  const tmp = `${stateFile(cfg)}.${process.pid}.tmp`
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, stateFile(cfg))
  return next
}

function alive(pid) {
  if (!(pid > 0)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 覆盖层进程自己写的 pid 文件（单实例锁在覆盖层那边，这里只负责探活） */
export function overlayPid(cfg) {
  try {
    const pid = Number.parseInt(readFileSync(pidFile(cfg), 'utf8').trim(), 10)
    return alive(pid) ? pid : 0
  } catch {
    return 0
  }
}

export function electronCandidates(cfg) {
  const names = process.platform === 'win32' ? ['electron.exe'] : ['electron']
  const list = []
  const explicit = cfg.overlay.electronPath
    || process.env.DSH_CONTROL_BAR_ELECTRON
    || process.env.DSH_ELECTRON_PATH
    || ''
  if (explicit) list.push(explicit)
  // DSH_HOME 可能与默认的 ~/.dsh 不同（自检、多 profile），两处都找
  const roots = [dshHome(), join(homedir(), '.dsh')]
  for (const root of roots) {
    for (const name of names) {
      list.push(join(root, 'electron', name))
      list.push(join(root, 'electron-helper', name))
    }
  }
  return list
}

export function findElectron(cfg) {
  for (const candidate of electronCandidates(cfg)) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return ''
}

/**
 * 确保覆盖层在跑。已有实例就直接返回；没有就拉一个脱离宿主的 Electron 子进程。
 * 子进程带 DSH_CONTROL_BAR_PARENT_PID，宿主退出时它自己会跟着退。
 */
export function ensureOverlay(cfg, options) {
  if (!cfg.overlay.enabled) return { running: false, spawned: false, reason: 'disabled' }
  const existing = overlayPid(cfg)
  if (existing > 0) return { running: true, spawned: false, pid: existing }

  const binary = findElectron(cfg)
  if (!binary) {
    return {
      running: false,
      spawned: false,
      reason: 'electron-not-found',
      hint: `没找到 Electron 可执行文件；把路径写进 overlay.electronPath，或先装 dsh-pet（它会把 Electron 放到 ${join(dshHome(), 'electron')}）。`,
    }
  }

  mkdirSync(cfg.dataDir, { recursive: true })
  const env = {
    ...process.env,
    DSH_CONTROL_BAR_HOME: cfg.dataDir,
    DSH_CONTROL_BAR_STATE: stateFile(cfg),
    DSH_CONTROL_BAR_HEIGHT: String(cfg.overlay.height),
    DSH_CONTROL_BAR_STALE_MS: String(cfg.overlay.staleMs || DEFAULTS.overlay.staleMs),
    DSH_CONTROL_BAR_TZ: cfg.pricing.timezone,
    DSH_CONTROL_BAR_WINDOWS: typeof cfg.pricing.windows === 'string' ? cfg.pricing.windows : '',
    DSH_CONTROL_BAR_HOLIDAYS: Array.from(cfg.phaseConfig.holidays).join(','),
    DSH_CONTROL_BAR_PARENT_PID: String(process.pid),
  }
  // 宿主自身以 ELECTRON_RUN_AS_NODE=1 跑，这个变量漏给子进程会让 electron 退化成 Node 脚本
  delete env.ELECTRON_RUN_AS_NODE

  const child = spawn(binary, [join(HERE, 'overlay', 'main.cjs')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  })
  child.on('error', () => {})
  child.unref()

  return { running: true, spawned: true, pid: child.pid, binary }
}

export function stopOverlay(cfg) {
  const pid = overlayPid(cfg)
  if (!(pid > 0)) {
    try {
      unlinkSync(pidFile(cfg))
    } catch {}
    return { stopped: false, reason: 'not-running' }
  }
  try {
    process.kill(pid)
  } catch {}
  try {
    unlinkSync(pidFile(cfg))
  } catch {}
  return { stopped: true, pid }
}

/** 给工具和 CLI 共用的一份快照 */
export function snapshot(cfg, now) {
  return {
    state: readState(cfg),
    phase: phase.describe(now, cfg.phaseConfig),
    overlayPid: overlayPid(cfg),
    stateFile: stateFile(cfg),
  }
}
