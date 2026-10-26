'use strict'
/**
 * dsh-control-bar overlay —— Electron 主进程
 *
 * 屏幕顶部的一条「正在操控」状态栏（独立 Electron 透明置顶窗口）。
 * 本进程只做四件事：
 *   1. 每 POLL_MS 读一次状态文件（宿主/CLI 原子写入），变化才通过 IPC 推给渲染端；
 *   2. 把自己的 pid 写进 overlay.pid，宿主据此判断顶栏在不在；
 *   3. state.active 为真才显示窗口，其余时间整窗 hide（不遮挡、不占焦点）；
 *   4. 把峰谷配置转给渲染端，由它每秒钟自己算「现在峰时还是谷时、还有多久切换」。
 *
 * 关键约束（照 dsh-pet 桌面 Helper 的实测结论）：
 *   - DSH 桌面宿主以 ELECTRON_RUN_AS_NODE=1 运行，拉起本进程的父级必须先删掉
 *     该环境变量，否则 electron.exe 会退化成 Node 直接跑脚本、不出窗口；
 *   - Windows 上透明窗走软件合成（disableHardwareAcceleration），避免「透明大窗
 *     互相覆盖时内容消失」的合成缺陷；
 *   - 置顶落在 screen-saver 带，并配合 setVisibleOnAllWorkspaces，
 *     全屏应用切回来时不会把状态栏压到底下；
 *   - 整窗点击穿透（setIgnoreMouseEvents(true,{forward:true})），永不抢点击；
 *   - 显示只用 showInactive()，永不激活、永不抢焦点。
 */
const { app, BrowserWindow, screen } = require('electron')
const { readFileSync, writeFileSync, unlinkSync } = require('node:fs')
const { join } = require('node:path')

const HOME = process.env.DSH_CONTROL_BAR_HOME || __dirname
const STATE_FILE = process.env.DSH_CONTROL_BAR_STATE || join(HOME, 'state.json')
const PID_FILE = join(HOME, 'overlay.pid')

/** 渲染端自己算峰谷要的配置 */
const RENDERER_CONFIG = {
  timezone: process.env.DSH_CONTROL_BAR_TZ || 'Asia/Shanghai',
  windows: process.env.DSH_CONTROL_BAR_WINDOWS || '09:00-12:00,14:00-18:00',
  holidays: process.env.DSH_CONTROL_BAR_HOLIDAYS || 'cn-2026',
}

/** 状态栏高度（逻辑像素） */
const BAR_HEIGHT = clampInt(process.env.DSH_CONTROL_BAR_HEIGHT, 34, 18, 120)
/** 状态文件轮询间隔（ms） */
const POLL_MS = clampInt(process.env.DSH_CONTROL_BAR_POLL_MS, 200, 50, 2000)
/** 超过这个时间没更新就当作陈旧状态，自动隐藏（防止进程崩了留一条假状态） */
const STALE_MS = clampInt(process.env.DSH_CONTROL_BAR_STALE_MS, 5 * 60 * 1000, 5000, 60 * 60 * 1000)
/** 宿主进程 pid：宿主没了本进程跟着退 */
const PARENT_PID = Number(process.env.DSH_CONTROL_BAR_PARENT_PID || 0) || 0
/** done 状态在屏幕上停留多久再隐藏（ms） */
const DONE_LINGER_MS = 1000
const TOPMOST_LEVEL = process.platform === 'darwin' ? 'floating' : 'screen-saver'

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value == null ? '' : value), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

// 与桌宠共用同一份 Electron 发行包，但 userData 必须隔离，否则会抢同一个单实例锁
try {
  app.setPath('userData', join(HOME, 'electron-userdata'))
} catch (error) {
  console.error('[control-bar] setPath(userData) failed:', String(error && error.message ? error.message : error))
}

// Windows 透明窗的软件合成兜底（与 dsh-pet 桌面 Helper 同一处决策）
if (process.platform === 'win32') {
  app.disableHardwareAcceleration()
}

let win = null
let lastSignature = ''
let doneStamp = -1
let doneUntil = 0
let pollTimer = null
let parentTimer = null

function emptyState() {
  return { active: false, percent: 0, text: '', done: false, ts: 0 }
}

function readState() {
  let raw
  try {
    raw = readFileSync(STATE_FILE, 'utf8')
  } catch {
    return emptyState()
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyState()
  }
  if (!parsed || typeof parsed !== 'object') return emptyState()
  const active = parsed.active === true
  const percentRaw = Number(parsed.percent)
  const percent = Number.isFinite(percentRaw) ? Math.min(100, Math.max(0, Math.round(percentRaw))) : 0
  const text = typeof parsed.text === 'string' ? parsed.text.slice(0, 160) : ''
  const done = parsed.done === true
  const ts = Number(parsed.ts) || 0
  const stale = active && ts > 0 && Date.now() - ts > STALE_MS
  return { active: active && !stale, percent, text, done: done && active && !stale, ts }
}

function primaryBounds() {
  const display = screen.getPrimaryDisplay()
  return display.bounds || { x: 0, y: 0, width: 1280, height: 800 }
}

function applyBounds() {
  if (!win || win.isDestroyed()) return
  const bounds = primaryBounds()
  win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: BAR_HEIGHT })
}

function showBar() {
  if (!win || win.isDestroyed()) return
  applyBounds()
  if (!win.isVisible()) win.showInactive()
  win.setAlwaysOnTop(true, TOPMOST_LEVEL)
}

function hideBar() {
  if (!win || win.isDestroyed()) return
  if (win.isVisible()) win.hide()
}

function createWindow() {
  const bounds = primaryBounds()
  win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: BAR_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    focusable: false,
    acceptFirstMouse: false,
    roundedCorners: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
      devTools: false,
    },
  })
  win.setAlwaysOnTop(true, TOPMOST_LEVEL)
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(true, { forward: true })
  win.setSkipTaskbar(true)
  win.webContents.setBackgroundThrottling(false)
  win.webContents.on('did-finish-load', () => {
    lastSignature = ''
    win?.webContents.send('control-bar:config', RENDERER_CONFIG)
    tick()
    if (process.env.DSH_CONTROL_BAR_PROBE === '1') setTimeout(probeRenderer, 1500)
  })
  win.on('closed', () => {
    win = null
  })
  win.loadFile(join(__dirname, 'renderer.html')).catch((error) => {
    console.error('[control-bar] loadFile failed:', String(error && error.message ? error.message : error))
  })
}

/** 排障用：DSH_CONTROL_BAR_PROBE=1 时把渲染端真实几何写进 probe.json */
function probeRenderer() {
  if (!win || win.isDestroyed()) return
  const script = `(() => {
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
    const el = (id) => document.getElementById(id)
    return {
      iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio,
      bar: rect(el('bar')), fill: rect(el('fill')), pct: rect(el('pct')), phase: rect(el('phase')),
      pctText: el('pct').textContent, textText: el('text').textContent, phaseText: el('phase').textContent,
    }
  })()`
  win.webContents.executeJavaScript(script, true).then((geo) => {
    const display = screen.getPrimaryDisplay()
    const payload = {
      display: { bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor },
      windowBounds: win.getBounds(),
      windowContent: win.getContentBounds(),
      config: RENDERER_CONFIG,
      geo,
    }
    writeFileSync(join(HOME, 'probe.json'), JSON.stringify(payload, null, 1), 'utf8')
  }).catch((error) => {
    writeFileSync(join(HOME, 'probe.json'), JSON.stringify({ error: String(error && error.message ? error.message : error) }), 'utf8')
  })
}

function tick() {
  const state = readState()
  if (state.done && state.ts !== doneStamp) {
    doneStamp = state.ts
    doneUntil = Date.now() + DONE_LINGER_MS
  }
  const signature = JSON.stringify([state.active, state.percent, state.text, state.done, state.ts])
  if (signature !== lastSignature && win && !win.isDestroyed() && !win.webContents.isLoading()) {
    lastSignature = signature
    win.webContents.send('control-bar:state', state)
  }
  if (state.active || Date.now() < doneUntil) showBar()
  else hideBar()
}

function startPolling() {
  if (pollTimer !== null) return
  pollTimer = setInterval(() => {
    try {
      tick()
    } catch (error) {
      console.error('[control-bar] tick failed:', String(error && error.message ? error.message : error))
    }
  }, POLL_MS)
}

function watchParent() {
  if (!(PARENT_PID > 0) || parentTimer !== null) return
  parentTimer = setInterval(() => {
    let alive = true
    try {
      process.kill(PARENT_PID, 0)
    } catch {
      alive = false
    }
    if (!alive) {
      console.error('[control-bar] host process ' + PARENT_PID + ' gone; exiting')
      app.quit()
    }
  }, 2000)
}

function writePid() {
  try {
    writeFileSync(PID_FILE, String(process.pid), 'utf8')
  } catch (error) {
    console.error('[control-bar] write pid failed:', String(error && error.message ? error.message : error))
  }
}

function clearPid() {
  try {
    if (readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) unlinkSync(PID_FILE)
  } catch {}
}

// 单实例：DSH 每次启动都会拉起一份，已有一份在跑时新的直接退出，不会叠出两条状态栏
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    tick()
  })
  app.on('window-all-closed', () => {
    app.quit()
  })
  app.on('will-quit', clearPid)
  app.whenReady().then(() => {
    writePid()
    createWindow()
    startPolling()
    watchParent()
    screen.on('display-metrics-changed', applyBounds)
    screen.on('display-added', applyBounds)
    screen.on('display-removed', applyBounds)
  }).catch((error) => {
    console.error('[control-bar] startup failed:', String(error && error.message ? error.message : error))
    app.quit()
  })
}
