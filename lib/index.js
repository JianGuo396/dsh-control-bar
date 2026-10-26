/**
 * dsh-control-bar —— 宿主半侧（Cordis 插件）
 *
 * 干三件事：
 *   1. 拉一条 OS 级置顶状态栏（lib/overlay 下的独立 Electron 进程），让用户
 *      在任何窗口上都能看见"模型正在操控这台电脑 + 到哪一步了"；
 *   2. 给模型两个工具：control_bar（写进度）、peak_valley（查峰谷）；
 *   3. 往系统提示里塞一小节行为规则：操控必须维护进度条；峰时的大额 token
 *      操作先问用户，谷时直接做。
 *
 * 没有浏览器半侧：状态栏是 OS 窗口，不在 DSH 页面里画。
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

/** 宿主没提供 dsh-tools 时退化：tools.register 认的就是一个普通对象 */
let defineTool = (tool) => tool
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  if (mod && typeof mod.defineTool === 'function') defineTool = mod.defineTool
} catch {
  // 忽略：没有 defineTool 也能注册
}

export const name = 'dsh-control-bar'

function safeLog(root, level, ...args) {
  try {
    root?.logger?.[level]?.(...args)
  } catch {}
}

function untilText(info) {
  if (!info || info.until === null || info.minutesUntil === null) return ''
  const local = Phase.localParts(info.until, info.timezone)
  const hh = String(local.hour).padStart(2, '0')
  const mm = String(local.minute).padStart(2, '0')
  return `${hh}:${mm}（约 ${Phase.formatUntil(info.minutesUntil)}后）`
}

function phasePayload(cfg, now) {
  const info = currentPhase(cfg, now)
  return {
    phase: info.phase,
    peak: info.phase === 'peak',
    multiplier: info.multiplier,
    localTime: info.localTime,
    localDate: info.localDate,
    reason: info.reason,
    nextPhase: info.nextPhase,
    switchInMinutes: info.minutesUntil,
    switchAt: untilText(info),
    summary: Phase.summarize(info),
    tokenThreshold: cfg.gate.tokenThreshold,
    largeTokenNeedsConfirmation: cfg.gate.enabled && info.phase === 'peak',
  }
}

function gateRules(cfg, info) {
  if (!cfg.gate.enabled) {
    return '峰谷守门已关闭（gate.enabled=false）：大额操作是否需要确认，按你自己的判断来。'
  }
  if (info.phase === 'peak') {
    return [
      `峰时单价是谷时的 2 倍。这次操作如果预计要烧掉大量 token（超过约 ${cfg.gate.tokenThreshold} tokens：`,
      '整库/整目录扫描、批量改写上百个文件、生成整篇长文、反复多轮长上下文分析、长时间自动探索这类），先别开工：',
      '',
      '1. `control_bar` 写一条 `action:"update", percent:5, text:"峰时大额操作，等你确认"`；',
      '2. `ask_user_question` 说清三件事：预计量级、现在是峰时（×2）、距谷时还有多久，并给出三个选项（现在就做 / 等谷时再做 / 缩小范围）；',
      '3. 只有用户明确同意才继续。小操作（读几个文件、查一条命令、看一眼页面）不用问。',
      '4. 用户选「等谷时」就停下，说明几点之后可以继续，不要自己耗着或偷偷降级。',
    ].join('\n')
  }
  return '现在是谷时（单价 ×1）。大额操作不用为了省钱额外确认，直接做；只有真正不可逆或影响他人的动作（删数据、改系统设置、替人发消息）才先问。'
}

function promptText(cfg) {
  const info = currentPhase(cfg)
  return [
    '## 操控状态栏（dsh-control-bar）',
    '',
    '你正在直接操作这台电脑（点鼠标、敲键盘、开应用、跑会改变电脑状态的命令）。这类操控要维护屏幕顶部的状态栏：',
    '',
    '1. 开始操控前：`control_bar` 传 `action:"start", text:"<这一轮要做什么，40 字以内>"`；',
    '2. 每完成一个用户看得见的步骤：`control_bar` 传 `action:"update", percent:<0-100 的真实进度>, text:"<正在做什么>"`；',
    '3. 全部结束（成功或放弃）：`control_bar` 传 `action:"finish", text:"<一句话结果，没做完就说为什么>"`。',
    '',
    'percent 要给真实估计，别一直停在 0 或 99；只有一步的任务就 start → finish 两下。进度条卡着不消失比没有进度条更糟。',
    '',
    '### 峰谷守门',
    '',
    `当前：${Phase.summarize(info)}。`,
    '',
    gateRules(cfg, info),
  ].join('\n')
}

export function apply(root, rawConfig) {
  const cfg = resolveConfig(rawConfig)

  // —— 覆盖层进程生命周期 ——
  // 延迟一点起，避免和宿主自己的启动 IO 抢；宿主退出时把子进程一起收掉。
  root.effect(() => {
    if (!cfg.overlay.enabled) {
      safeLog(root, 'info', 'dsh-control-bar: overlay disabled by config')
      return () => {}
    }
    const timer = setTimeout(() => {
      const result = ensureOverlay(cfg)
      if (result.running) {
        safeLog(root, 'info', `dsh-control-bar: overlay ${result.spawned ? 'started' : 'already running'} (pid ${result.pid})`)
      } else {
        safeLog(root, 'warn', `dsh-control-bar: overlay not running (${result.reason})${result.hint ? ' — ' + result.hint : ''}`)
      }
    }, 1200)
    timer.unref?.()
    return () => {
      clearTimeout(timer)
      stopOverlay(cfg)
    }
  }, 'dsh-control-bar: overlay process')

  // —— 工具 ——
  root.inject(['tools'], (ctx) => {
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'control_bar',
      description:
        '维护屏幕顶部的「正在操控」状态栏。宿主拉起一条 OS 级置顶进度条；'
        + '每次直接操控这台电脑（点鼠标/敲键盘/开关应用/跑改状态的命令）都要用它报到：'
        + '开始 start、每完成一个可见步骤 update、结束 finish。'
        + 'percent 必须给真实进度估计。finish 会先把进度补到 100% 再让状态栏消失。'
        + '返回里附带当前峰时/谷时状态。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          description: "start | update | finish | hide。start 显示状态栏；update 改进度/文案；finish 补到 100% 后消失；hide 立刻消失（不留完成态）。",
        },
        percent: {
          type: 'number',
          description: '0-100 的整数进度。update 时省略表示沿用上一次的进度；start 时省略按 0 计。',
        },
        text: {
          type: 'string',
          description: '状态栏上显示的一句话（≤160 字，越短越好）。省略或空串表示沿用上一次的文字。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          description: '状态栏当前状态：ok/action/percent/text/overlayRunning/phase/multiplier/peakHint。',
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async (args) => {
        const action = String((args && args.action) || 'update').trim().toLowerCase()
        const text = typeof args?.text === 'string' ? args.text : ''
        const percent = args?.percent === undefined ? undefined : args.percent

        let patch
        if (action === 'start' || action === 'begin') {
          patch = { active: true, percent: percent === undefined ? 0 : percent, done: false, text: text || '正在操控你的电脑' }
          // 自愈：顶栏进程被关掉过，下一次 start 就把它拉回来
          if (cfg.overlay.enabled && overlayPid(cfg) === 0) ensureOverlay(cfg)
        } else if (action === 'finish' || action === 'done' || action === 'end') {
          patch = { active: false, percent: 100, done: true, text: text || '操作完成' }
        } else if (action === 'hide' || action === 'stop') {
          patch = { active: false, percent: undefined, done: false, text: '' }
        } else {
          patch = { active: true, percent, done: percent === 100, text }
        }

        const next = writeState(cfg, patch)
        const info = currentPhase(cfg)
        const running = overlayPid(cfg) > 0
        const hint = Phase.summarize(info) + (running || !cfg.overlay.enabled ? '' : '｜注意：顶栏进程没在跑，屏幕上暂时看不到这条进度')
        return {
          ok: true,
          action,
          percent: next.percent,
          text: next.text,
          overlayRunning: running,
          phase: info.phase,
          multiplier: info.multiplier,
          peakHint: hint,
        }
      },
    })), 'dsh-control-bar: control_bar tool')

    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'peak_valley',
      description:
        '查 DeepSeek 现在算峰时还是谷时（峰时单价是谷时的 2 倍），以及还有多久切换。'
        + '峰时如果要跑大额 token 的操作，先问用户；谷时不用。口径取自官方定价页：'
        + '峰时 09:00-12:00、14:00-18:00（北京时间，周一到周五），节假日与周末整日谷时。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          description: '当前峰谷：phase/peak/multiplier/localTime/localDate/reason/nextPhase/switchInMinutes/switchAt/summary/tokenThreshold/largeTokenNeedsConfirmation。',
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async () => phasePayload(cfg, Date.now()),
    })), 'dsh-control-bar: peak_valley tool')
  })

  // —— 系统提示里的一小节 ——
  root.inject(['systemPrompt'], (ctx) => {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'dsh-control-bar',
      order: 500,
      interpolate: false,
      text: () => promptText(cfg),
    }), 'dsh-control-bar: prompt section')
  })

  safeLog(root, 'info', `dsh-control-bar: ready (${Phase.summarize(currentPhase(cfg))}, state → ${stateFile(cfg)})`)
}

export { readState }
