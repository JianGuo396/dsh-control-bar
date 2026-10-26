/**
 * 回合生命周期：状态栏跟着「回合」开合，而不是等模型记得收尾。
 *
 * 做的事和 codex 那条状态行一样：
 *   turn/start   → 亮条（「正在工作」+ 正在处理你的请求）
 *   每次 tool/call → 文案换成正在做的事，进度按调用次数走一条单调曲线
 *   turn/end / agent/error → 补到 100%，停 1.2 秒后收起
 *
 * 为什么放在宿主侧而不是让模型调 finish：模型会忘记、会被中断、会报错，
 * 任何一种都会留下一条挂着的进度条——这正是「运行结束了状态栏也不结束」的原因。
 */

/** 工具名 → 状态栏文案。命中第一条即止，未命中的直接显示工具名。 */
const TOOL_LABELS = [
  [/^(ops_bash|bash|pwsh|shell)$/, '执行命令'],
  [/^(ops_read_files?|read|write|edit)$/, '读写文件'],
  [/^(glob|grep|ops_discover_tools)$/, '查找文件'],
  [/^(web_fetch|web_search|multi_search|advanced_search|research|platform_search|domain_search|video_search)$/, '查资料'],
  [/^bsk_/, '操作浏览器'],
  [/^mcp__/, '调用工具'],
  [/^todo_/, '整理任务'],
  [/^(control_bar|peak_valley)$/, '更新状态栏'],
]

/** 这些工具算「直接操控这台电脑」，文案换成「正在操控」。 */
const CONTROL_TOOL = /^(bsk_|(ops_)?bash$|pwsh$|shell$|computer_|mouse_|keyboard_)/

export function toolLabel(name) {
  const raw = String(name || '').trim()
  if (!raw) return '处理中'
  for (const [re, label] of TOOL_LABELS) {
    if (re.test(raw)) return label
  }
  return raw.replace(/^mcp__/, '').replace(/^.*__/, '') || '处理中'
}

/** 单调递增、永远到不了 100 的进度曲线：第 n 次调用约 28/48/63/73/80/86…%，收尾时才补到 100。 */
export function progressFor(step) {
  const n = Math.max(1, Number(step) || 1)
  return Math.min(94, Math.max(6, Math.round(100 * (1 - 0.72 ** n))))
}

function sessionIdOf(session) {
  return String((session && (session.header?.id ?? session.id)) ?? 'default')
}

/**
 * @param {object} options
 * @param {object} options.root   cordis 插件上下文
 * @param {object} options.cfg    已解析的配置（含 dataDir）
 * @param {(cfg: object, patch: object) => object} options.writeState
 * @param {(root: object, level: string, ...args: any[]) => void} options.safeLog
 */
export function installLifecycle({ root, cfg, writeState, safeLog }) {
  const life = { session: null, steps: 0, timer: null, sawControl: false }

  function settle(text) {
    writeState(cfg, { active: true, percent: 100, done: true, title: '完成', text })
    life.session = null
    clearTimeout(life.timer)
    life.timer = setTimeout(() => {
      try {
        writeState(cfg, { active: false, done: false })
      } catch (error) {
        safeLog(root, 'warn', `dsh-control-bar: 收条失败 ${error && error.message}`)
      }
    }, 1200)
    life.timer.unref?.()
  }

  function handle(session, event) {
    const type = event && event.type
    if (!type) return
    const id = sessionIdOf(session)

    if (type === 'turn/start') {
      life.session = id
      life.steps = 0
      life.sawControl = false
      clearTimeout(life.timer)
      writeState(cfg, { active: true, percent: 4, done: false, title: '正在工作', text: '正在处理你的请求' })
      return
    }

    // 只有当前回合的会话才动这条全局状态栏；并行的其它会话不抢
    if (life.session !== null && id !== life.session) return

    if (type === 'tool/call') {
      const toolName = String((event.data && event.data.name) || '')
      if (!toolName || toolName === 'control_bar') return
      life.steps += 1
      if (CONTROL_TOOL.test(toolName)) life.sawControl = true
      writeState(cfg, {
        active: true,
        percent: progressFor(life.steps),
        done: false,
        title: life.sawControl ? '正在操控' : '正在工作',
        text: toolLabel(toolName),
      })
      return
    }

    if (type === 'turn/end' || type === 'agent/error') {
      const kind = event.data && event.data.reason && event.data.reason.kind
      const text = type === 'agent/error'
        ? '出错，已停下'
        : kind === 'error'
          ? '生成失败'
          : kind === 'max-tokens'
            ? '输出被截断'
            : '完成'
      settle(text)
    }
  }

  root.effect(() => {
    if (typeof root.on !== 'function') {
      safeLog(root, 'warn', 'dsh-control-bar: 宿主没有 root.on，状态栏只能靠模型手动 start/finish')
      return () => {}
    }
    const off = root.on('session/event', (session, event) => {
      try {
        handle(session, event)
      } catch (error) {
        safeLog(root, 'warn', `dsh-control-bar: session/event 处理失败 ${error && error.message}`)
      }
    })
    return () => {
      try {
        if (typeof off === 'function') off()
        else if (off && typeof off.dispose === 'function') off.dispose()
      } catch {}
      clearTimeout(life.timer)
    }
  }, 'dsh-control-bar: turn lifecycle')
}
