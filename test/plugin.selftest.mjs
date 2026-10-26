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
const eventHandlers = new Map()

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
  on(event, handler) {
    const list = eventHandlers.get(event) || []
    list.push(handler)
    eventHandlers.set(event, list)
    return () => {
      const rest = (eventHandlers.get(event) || []).filter((fn) => fn !== handler)
      eventHandlers.set(event, rest)
    }
  },
}

let failures = 0
function emitEvent(event) {
  for (const handler of eventHandlers.get('session/event') || []) handler({ header: { id: 's1' } }, event)
}

function readStateFile() {
  return JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))
}

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
check('finish 先满格停留', stateAfter.done === true && stateAfter.active === true && stateAfter.percent === 100, stateAfter)

await new Promise((resolve) => setTimeout(resolve, 1350))
const stateSettled = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))
check('finish 之后自动收条', stateSettled.active === false, stateSettled)

const phase = await peakValley.execute({}, {})
check('peak_valley 给出时段', phase.phase === 'peak' || phase.phase === 'off-peak', phase.phase)
check('peak_valley 单价倍数', phase.multiplier === 2 || phase.multiplier === 1, phase.multiplier)
check('peak_valley 守门建议与时段一致', phase.largeTokenNeedsConfirmation === (phase.phase === 'peak'), phase)

const promptText = sections[0].text()
check('提示文案含状态栏动作', promptText.includes('control_bar'), promptText.slice(0, 60))
check('提示文案含当前峰谷', promptText.includes('当前：'), promptText.slice(-200))

// —— 回合生命周期：状态栏必须跟着回合开合，不能指望模型记得收尾 ——
check('订阅了 session/event', (eventHandlers.get('session/event') || []).length === 1, [...eventHandlers.keys()])

emitEvent({ type: 'turn/start', data: {} })
let st = readStateFile()
check('turn/start 自动亮条', st.active === true && st.title === '正在工作', st)
check('turn/start 进度从 4% 起', st.percent === 4, st.percent)

emitEvent({ type: 'tool/call', data: { name: 'ops_bash' } })
st = readStateFile()
check('tool/call 换文案为「执行命令」', st.text === '执行命令', st.text)
check('tool/call 算操控，标题转「正在操控」', st.title === '正在操控', st.title)
check('tool/call 进度前进', st.percent > 4 && st.percent < 100, st.percent)

for (let i = 0; i < 6; i += 1) emitEvent({ type: 'tool/call', data: { name: 'read' } })
st = readStateFile()
check('多次调用后进度仍 <95', st.percent < 95, st.percent)
check('读文件的文案是「读写文件」', st.text === '读写文件', st.text)

emitEvent({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
st = readStateFile()
check('turn/end 立刻补到 100%', st.percent === 100 && st.done === true, st)
check('turn/end 文案为「完成」', st.title === '完成', st.title)

await new Promise((resolve) => setTimeout(resolve, 1350))
st = readStateFile()
check('1.2 秒后自动收条', st.active === false, st)

// 中断/报错也必须收条，不留悬挂进度条
emitEvent({ type: 'turn/start', data: {} })
emitEvent({ type: 'tool/call', data: { name: 'bsk_inspect' } })
emitEvent({ type: 'agent/error', data: {} })
st = readStateFile()
check('agent/error 也收条', st.percent === 100 && st.done === true, st)
await new Promise((resolve) => setTimeout(resolve, 1350))
check('报错后同样自动隐藏', readStateFile().active === false, readStateFile())

// 小工具文案映射：没命中的直接显示工具名
emitEvent({ type: 'turn/start', data: {} })
emitEvent({ type: 'tool/call', data: { name: 'some_random_tool' } })
check('未知工具直接显示工具名', readStateFile().text === 'some_random_tool', readStateFile().text)
emitEvent({ type: 'turn/end', data: { reason: { kind: 'error' } } })
await new Promise((resolve) => setTimeout(resolve, 1350))


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

