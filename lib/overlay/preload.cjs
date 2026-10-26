'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('controlBar', {
  /** 主进程推来的状态（active/percent/text/done/ts） */
  onState(callback) {
    if (typeof callback !== 'function') return
    ipcRenderer.on('control-bar:state', (_event, state) => {
      callback(state || { active: false, percent: 0, text: '', done: false })
    })
  },
  /** 峰谷配置（时区 / 峰时段 / 节假日），渲染端拿它自己算当前时段 */
  onConfig(callback) {
    if (typeof callback !== 'function') return
    ipcRenderer.on('control-bar:config', (_event, config) => {
      callback(config || {})
    })
  },
})
