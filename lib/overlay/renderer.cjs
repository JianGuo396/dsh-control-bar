'use strict'
/**
 * 渲染端：状态（百分比/文案）由主进程推，峰谷由自己算。
 *
 * 为什么峰谷在渲染端算：状态只在模型改进度时才写一次，而「12:00 一到就转谷时」
 * 这种切换必须自己跳，不能等下一次写状态。所以配置（时区/峰时段/节假日）通过
 * onConfig 下来，这里每秒用 lib/phase.cjs 重算一次，和宿主用的是同一份算法。
 */
const bar = document.getElementById('bar')
const fill = document.getElementById('fill')
const label = document.getElementById('label')
const text = document.getElementById('text')
const pct = document.getElementById('pct')
const phasePill = document.getElementById('phase')

const Phase = window.ControlBarPhase
let phaseConfig = null
let lastText = ''
let complete = false

function setPhaseConfig(raw) {
  if (!Phase) return
  try {
    phaseConfig = Phase.makeConfig({ pricing: raw || {} })
  } catch {
    phaseConfig = null
  }
  paintPhase()
}

function paintPhase() {
  if (!phasePill) return
  if (!Phase || !phaseConfig) {
    phasePill.className = 'unknown'
    phasePill.textContent = ''
    return
  }
  const info = Phase.describe(Date.now(), phaseConfig)
  const peak = info.phase === 'peak'
  const head = peak ? '峰时 ×2' : '谷时 ×1'
  const tail = info.nextPhase ? `距${info.nextPhase === 'peak' ? '峰' : '谷'} ${Phase.formatUntil(info.minutesUntil)}` : ''
  phasePill.className = peak ? 'phase peak' : 'phase off'
  phasePill.textContent = tail ? `${head} · ${tail}` : head
  phasePill.title = Phase.summarize(info)
}

function paint(state) {
  const percent = Math.min(100, Math.max(0, Math.round(Number(state.percent) || 0)))
  complete = state.done === true || percent >= 100
  bar.classList.toggle('complete', complete)
  const title = typeof state.title === 'string' ? state.title.trim() : ''
  label.textContent = title || (complete ? '操控完成' : '正在操控')
  fill.style.width = percent + '%'
  fill.classList.toggle('edge', percent >= 100)
  pct.textContent = percent + '%'
  const incoming = typeof state.text === 'string' ? state.text.trim() : ''
  if (incoming.length > 0) lastText = incoming
  text.textContent = lastText || (complete ? '操作完成' : '正在操控你的电脑…')
  text.title = text.textContent
  paintPhase()
}

// 起步先按默认口径亮出峰谷（配置到达前也不会空白）
setPhaseConfig({})

if (window.controlBar && typeof window.controlBar.onState === 'function') {
  window.controlBar.onState(paint)
} else {
  // 主进程 IPC 没接上时不留空白栏：直接展示一句兜底文案，方便一眼看出是链路问题
  paint({ active: true, percent: 0, text: '状态通道未连接', done: false })
}

if (window.controlBar && typeof window.controlBar.onConfig === 'function') {
  window.controlBar.onConfig((config) => setPhaseConfig(config))
}

// 峰谷自己跳：跨过 12:00 / 14:00 / 18:00 时不用等宿主再写一条状态
setInterval(paintPhase, 1000)
