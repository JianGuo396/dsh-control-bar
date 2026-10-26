/**
 * 假宿主自检：不启动真 DSH，用最小的 ctx 桩把 lib/index.js 的 apply 跑一遍，
 * 验证「工具注册 → 写状态 → 峰谷提示 → 系统提示文案」这条链路不炸。
 *
 *   node test/plugin.selftest.mjs
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-control-bar-'))
const registered = []
const sections = []
const disposers = []
const logs = []

const ctxStub = {
  tools: {
    register(tool) {
      registered.push(tool)
      return () => {}
    },
  },
  systemPrompt: {
    section(input) {
      sections.push(input)
      return () => {}
    },
  },
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => {}
  },
}

const root = {
  logger: {
    info: (...args) => logs.push(['info', ...args]),
    warn: (...args) => logs.push(['warn', ...args]),
    error: (...args) => logs.push(['error', ...args]),
  },
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => {}
  },
  inject(_deps, callback) {
    callback(ctxStub)
  },
}

let failures = 0
function check(name, condition, detail) {
  if (condition) {
    console.log(`ok   ${name}`)
  } else {
    failures += 1
    console.log(`FAIL ${name}${detail === undefined ? '' : ' — ' + JSON.stringify(detail)}`)
  }
}

apply(root, {
  dataDir,
  overlay: { enabled: false },
  pricing: { timezone: 'Asia/Shanghai', windows: '09:00-12:00,14:00-18:00', holidays: 'cn-2026' },
})

check('注册了两个工具', registered.length === 2, registered.map((t) => t.name))
check('工具名正确', registered.map((t) => t.name).join(',') === 'control_bar,peak_valley', registered.map((t) => t.name))
check('注册了系统提示小节', sections.length === 1 && sections[0].name === 'dsh-control-bar', sections.map((s) => s.name))

const controlBar = registered.find((t) => t.name === 'control_bar')
const peakValley = registered.find((t) => t.name === 'peak_valley')

const started = await controlBar.execute({ action: 'start', text: '正在打开浏览器搜索' }, {})
check('start 返回 ok', started.ok === true, started)
check('start 进度 0', started.percent === 0, started.percent)
check('start 文案写入', started.text === '正在打开浏览器搜索', started.text)
check('start 带峰谷提示', typeof started.peakHint === 'string' && started.peakHint.length > 0, started.peakHint)
check('start 报出 overlay 状态', started.overlayRunning === false, started.overlayRunning)

const mid = await controlBar.execute({ action: 'update', percent: 45 }, {})
check('update 只改进度时沿用文案', mid.percent === 45 && mid.text === '正在打开浏览器搜索', mid)

const next = await controlBar.execute({ action: 'update', percent: 45, text: '已打开结果页' }, {})
check('update 换文案', next.text === '已打开结果页', next.text)

const finished = await controlBar.execute({ action: 'finish', text: '找到了' }, {})
check('finish 补到 100', finished.percent === 100 && finished.text === '找到了', finished)

const stateAfter = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))
check('状态文件落盘', stateAfter.done === true && stateAfter.active === false, stateAfter)

const phase = await peakValley.execute({}, {})
check('peak_valley 给出时段', phase.phase === 'peak' || phase.phase === 'off-peak', phase.phase)
check('peak_valley 单价倍数', phase.multiplier === 2 || phase.multiplier === 1, phase.multiplier)
check('peak_valley 守门建议与时段一致', phase.largeTokenNeedsConfirmation === (phase.phase === 'peak'), phase)

const promptText = sections[0].text()
check('提示文案含状态栏动作', promptText.includes('control_bar'), promptText.slice(0, 60))
check('提示文案含当前峰谷', promptText.includes('当前：'), promptText.slice(-200))

for (const dispose of disposers) {
  try {
    dispose()
  } catch (error) {
    failures += 1
    console.log('FAIL disposer threw:', error && error.message)
  }
}
check('日志里没有 error', !logs.some((entry) => entry[0] === 'error'), logs.filter((entry) => entry[0] === 'error'))

// —— output.render 契约：宿主 createSuccessResult 会把 render 结果当 content 用 ——
for (const tool of registered) {
  const out = tool.output
  check(tool.name + " 有 output.schema", !!(out && out.schema), out && Object.keys(out))
  check(tool.name + " 有 output.render", !!(out && typeof out.render === "function"), typeof (out && out.render))
  const blocks = out && typeof out.render === "function" ? out.render({}, { ok: true }) : null
  check(tool.name + " render 返回内容块数组", Array.isArray(blocks) && blocks.length > 0, blocks)
  check(tool.name + " 内容块是 text", Array.isArray(blocks) && blocks.every((b) => b.type === "text" && typeof b.text === "string"), blocks)
}
rmSync(dataDir, { recursive: true, force: true })
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

