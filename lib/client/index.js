/**
 * dsh-model-doctor — 浏览器半（无框架，纯 DOM 增强）。
 *
 * 【解耦设计】本插件不依赖任何菜单渲染插件（dsh-reasoning-effort / dsh-effort-slider /
 * 官方原生菜单都可以）：
 *   1. 首选路径：从宿主半取回权威模型目录（provider/model 名称），
 *      在文档里按「文本命中已知模型名」定位模型行，再向上找到可点击祖先作为行容器；
 *   2. 兼容路径：若检测到 `.re-model-menu`（dsh-reasoning-effort 的菜单），
 *      走其 section/group 结构做精确分组匹配（更稳，优先使用）。
 * 两条路径都只做「行内追加自持元素」：不替换 React 节点、不抢座位、事件 stopPropagation。
 *
 * 每个模型行追加两枚按钮：
 *   ⟳  连通检测 —— 让 Host 直连网关探测该模型（连通/欠费/限流/鉴权），结果行内徽章呈现；
 *   🗑  删除 —— 两段式确认后让 Host 从 llm-pi-ai 配置移除该模型（Host 自动备份配置文档）。
 * 菜单顶部追加「全部检测」按钮与账户余额展示。
 *
 * @module dsh-model-doctor/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-model-doctor',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const API_BASE = '/api/model-doctor'
    /** 兼容路径：dsh-reasoning-effort 渲染的菜单。 */
    const MENU_SEL = '.re-model-menu'
    const PANE_SEL = '.re-model-pane'
    const ROW_SEL = '.re-model-option'
    const NAME_SEL = '.re-model-option-name'
    const TITLE_SEL = '.re-model-group-title'
    /** 通用路径：各类弹层菜单可能的根容器（官方菜单 / 第三方滑块插件都在其中）。 */
    const MENU_ROOT_SEL = [
      '[role="menu"]',
      '[role="listbox"]',
      '[data-radix-popper-content-wrapper]',
      '[role="dialog"]',
      '[data-state="open"][aria-modal]',
    ].join(',')
    const DIRECTORY_TTL_MS = 30000
    const DIRECTORY_RETRY_MS = 10000
    /** 一个菜单里至少要有这么多个模型行，才认定它是模型菜单（防误伤其他弹层）。 */
    const MIN_GENERIC_ROWS = 2

    /** 客户端半不需要上下文服务：宿主通道走 /api 裸 fetch。 */
    const inject = []

    const KIND_LABEL = {
      ok: '连通',
      auth: '鉴权/欠费',
      quota: '额度/限流',
      notfound: '不存在',
      badrequest: '请求被拒',
      server: '服务端错误',
      network: '网络/超时',
      config: '未配置',
      unsupported: '无法探测',
      channel: '通道异常',
    }

    const CSS = `
.dmd-actions{position:absolute;right:8px;top:50%;transform:translateY(-50%);display:inline-flex;align-items:center;gap:5px;z-index:2}
.dmd-btn{width:27px;height:27px;line-height:26px;text-align:center;font-size:16px;border-radius:8px;cursor:pointer;user-select:none;color:inherit;background:color-mix(in srgb,currentColor 8%,transparent);opacity:.72;flex-shrink:0}
.dmd-btn:hover{opacity:1;background:color-mix(in srgb,currentColor 18%,transparent)}
.dmd-btn.dmd-refresh.is-busy{opacity:1;animation:dmd-spin 0.9s linear infinite}
.dmd-btn.dmd-delete:hover{color:#e5484d}
.dmd-btn.is-armed{width:auto;padding:0 9px;color:#e5484d;opacity:1;font-size:12px;font-weight:600;line-height:26px}
@keyframes dmd-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
.dmd-chip{font-size:11px;line-height:17px;padding:0 7px;margin-left:7px;border-radius:999px;white-space:nowrap;vertical-align:middle;display:inline-block}
.dmd-chip.is-ok{color:#2fa96e;background:color-mix(in srgb,#2fa96e 16%,transparent)}
.dmd-chip.is-bad{color:#e5484d;background:color-mix(in srgb,#e5484d 14%,transparent)}
.dmd-chip.is-warn{color:#d08700;background:color-mix(in srgb,#d08700 16%,transparent)}
.dmd-allbar{display:flex;align-items:center;gap:8px;padding:6px 12px;margin:2px 6px;font-size:11px;border-radius:8px;background:color-mix(in srgb,currentColor 6%,transparent)}
.dmd-allbar button{font:inherit;font-size:11px;line-height:16px;padding:2px 9px;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 25%,transparent);background:transparent;color:inherit;cursor:pointer}
.dmd-allbar button:disabled{opacity:.45;cursor:default}
.dmd-allbar .dmd-status{opacity:.65}
.dmd-allbar .dmd-balance{color:#2fa96e}
`

    /** 调用宿主半的 /api 路由（与 dsh-memory-board 同款裸 fetch 机制）；失败也返回结构化结果。 */
    function makeDoctor() {
      const call = async (endpoint, payload) => {
        try {
          const response = await fetch(`${API_BASE}/${endpoint}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload ?? {}),
          })
          if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
          const result = await response.json()
          if (result && typeof result === 'object' && 'ok' in result) {
            return result.ok ? result.value : { ok: false, error: result.error?.message ?? '请求失败' }
          }
          return { ok: false, error: '响应格式异常' }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
      return {
        directory: () => call('directory'),
        check: (provider, model) => call('check', { provider, model }),
        checkAll: () => call('checkAll'),
        deleteModel: (provider, model) => call('deleteModel', { provider, model }),
        resultsLoad: () => call('resultsLoad'),
        resultsSave: (snapshot) => call('resultsSave', snapshot),
        clientReport: (state) => call('clientReport', state),
      }
    }

    /* ---------------------------------------------------------------- */
    /* 增强状态                                                          */
    /* ---------------------------------------------------------------- */

    let doctor = null
    let ctxRef = null
    let styleEl = null
    let observer = null
    let rafId = 0
    let disposed = false

    /** 权威目录缓存：{ providers: [{id,name,models:[{id,name}]}] } */
    let directory = null
    let directoryAt = 0
    let directoryFailedAt = 0
    /** 最近一次目录获取失败的原文（透出到状态条，便于定位卡点）。 */
    let directoryError = ''

    /** 最近一次检测结果快照 { results, balances, at }；跨菜单开关与软件重启保留。 */
    let lastRun = null
    /** 全部检测进行中：状态条不被缓存回填覆盖。 */
    let barBusy = false

    /** 行键 -> 模型行元素，供全部检测回填徽章。 */
    const rowByKey = new Map()
    /** 模型 id -> 行元素（全表唯一时可用）：供应商 id 空间对不上时的兜底匹配。 */
    const rowByModel = new Map()
    /** 行元素 -> 名字锚点（通用路径下用于把徽章插到模型名后面）。 */
    let rowAnchor = new WeakMap()
    /** 本次扫描的通用路径诊断信息（上报给宿主，便于远程定位 DOM 结构）。 */
    let lastDiagnostics = null

    /** 本页会话内已删除的模型键，防目录未刷新时行又冒出来。 */
    const deletedKeys = new Set()

    const keyOf = (provider, model) => `${provider}::${model}`

    function fetchDirectory(force = false) {
      if (doctor === null) return Promise.resolve()
      const now = Date.now()
      if (!force && directory !== null && now - directoryAt < DIRECTORY_TTL_MS) return Promise.resolve()
      if (!force && directoryFailedAt !== 0 && now - directoryFailedAt < DIRECTORY_RETRY_MS) return Promise.resolve()
      return doctor.directory().then((result) => {
        if (disposed) return
        if (result && result.ok !== false && Array.isArray(result.providers)) {
          directory = result
          directoryAt = Date.now()
          directoryFailedAt = 0
          directoryError = ''
          tokenIndexAt = 0
          scheduleEnhance()
        } else {
          directoryFailedAt = Date.now()
          directoryError = typeof result?.error === 'string' ? result.error : '响应里没有 providers'
        }
      }).catch((error) => {
        directoryFailedAt = Date.now()
        directoryError = error instanceof Error ? error.message : String(error)
      })
    }

    /* ---------------------------------------------------------------- */
    /* 通用行定位：不依赖任何菜单插件的类名                                */
    /* ---------------------------------------------------------------- */

    /** 归一化文本：折叠空白 + 小写，用于名字比对。 */
    function normText(value) {
      return String(value ?? '').replace(/\s+/gu, ' ').trim().toLowerCase()
    }

    /** 模型名/ID -> 候选条目索引；15 秒内复用。 */
    let tokenIndex = null
    let tokenIndexAt = 0

    function ensureTokenIndex() {
      if (tokenIndex !== null && Date.now() - tokenIndexAt < 15000) return tokenIndex
      const index = new Map()
      for (const provider of directory?.providers ?? []) {
        for (const model of provider.models) {
          const tokens = new Set([normText(model.name), normText(model.id)])
          for (const token of tokens) {
            if (token.length < 2) continue
            const list = index.get(token) ?? []
            list.push({
              providerId: provider.id,
              providerName: provider.name,
              modelId: model.id,
              modelName: model.name,
            })
            index.set(token, list)
          }
        }
      }
      tokenIndex = index
      tokenIndexAt = Date.now()
      return index
    }

    /** 元素是否像个可点击的「行」。 */
    function looksLikeRow(el) {
      const tag = el.tagName
      if (tag === 'BUTTON' || tag === 'LI' || tag === 'A') return true
      const role = el.getAttribute('role')
      if (role !== null && /^(option|menuitem|menuitemradio|listitem|treeitem|button)$/u.test(role)) return true
      if (el.hasAttribute('data-value') || el.hasAttribute('cmdk-item')) return true
      if (el.hasAttribute('tabindex')) return true
      try {
        if (window.getComputedStyle(el).cursor === 'pointer') return true
      } catch { /* 忽略计算样式失败 */ }
      return false
    }

    /** 从文本节点往上找最近的可点击行容器。 */
    function clickableRow(anchor, root) {
      let el = anchor
      let depth = 0
      while (el !== null && el !== root && depth < 8) {
        if (looksLikeRow(el)) return el
        el = el.parentElement
        depth += 1
      }
      return looksLikeRow(root) ? root : null
    }

    /** 候选条目里挑一个：多供应商同名时用上下文里的供应商名消歧。 */
    function pickEntry(entries, row) {
      if (entries.length === 1) return entries[0]
      let context = normText(row.textContent)
      let el = row.parentElement
      let depth = 0
      while (el !== null && depth < 3) {
        context += ` ${normText(el.textContent).slice(0, 400)}`
        el = el.parentElement
        depth += 1
      }
      const matched = entries.filter(
        (entry) => typeof entry.providerName === 'string'
          && entry.providerName.length > 0
          && context.includes(normText(entry.providerName)),
      )
      if (matched.length === 1) return matched[0]
      return entries[0]
    }

    /**
     * 在一个候选根容器里找出模型行：对每个文本节点做已知模型名命中，
     * 向上取最近的可点击祖先；若某「行」文本里出现过两个以上不同模型，则它是容器，排除。
     */
    function genericRowsIn(root) {
      const index = ensureTokenIndex()
      if (index.size === 0) return []
      const found = new Map()
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node !== null) {
        const raw = node.nodeValue
        if (raw !== null && raw.length > 0 && raw.length <= 200) {
          const text = normText(raw)
          if (text.length >= 2) {
            const anchor = node.parentElement
            if (anchor !== null) {
              for (const [token, entries] of index) {
                if (!text.includes(token)) continue
                const row = clickableRow(anchor, root)
                if (row === null) continue
                const current = found.get(row)
                if (current === undefined || token.length > current.token.length) {
                  found.set(row, { token, entries, anchor })
                }
              }
            }
          }
        }
        node = walker.nextNode()
      }
      // 排除「容器型行」：行文本里出现两个以上不同模型 → 它装的是列表，不是单行。
      for (const [row] of Array.from(found.entries())) {
        const rowText = normText(row.textContent)
        const distinct = new Set()
        for (const [token, entries] of index) {
          if (!rowText.includes(token)) continue
          for (const entry of entries) distinct.add(`${entry.providerId}::${entry.modelId}`)
          if (distinct.size > 1) break
        }
        if (distinct.size > 1) found.delete(row)
      }
      return Array.from(found.entries()).map(([row, hit]) => ({ row, ...hit }))
    }

    /** 根容器是否可见（不可见的弹层跳过，避免误伤收起的菜单）。 */
    function isVisible(el) {
      if (!el.isConnected) return false
      if (el.getClientRects().length > 0) return true
      return el.offsetParent !== null
    }

    /* ---------------------------------------------------------------- */
    /* 结果快照：加载 / 保存 / 回填                                       */
    /* ---------------------------------------------------------------- */

    function timeLabel(at) {
      try {
        return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      } catch {
        return ''
      }
    }

    function summarize(results) {
      let ok = 0
      let bad = 0
      for (const value of Object.values(results ?? {})) {
        if (value && value.ok === true) ok += 1
        else bad += 1
      }
      return { ok, bad, total: ok + bad }
    }

    function updateBar(text) {
      if (barBusy) return
      document.querySelectorAll('.dmd-allbar .dmd-status').forEach((node) => { node.textContent = text })
    }

    function updateBalance(balances) {
      if (!isRecord(balances)) return
      const parts = Object.entries(balances)
        .map(([providerId, value]) => `${providerLabel(providerId)}: ¥${value}`)
      document.querySelectorAll('.dmd-allbar .dmd-balance').forEach((node) => { node.textContent = parts.join(' · ') })
    }

    /** 把上次结果回填到当前菜单的行与状态条上；返回回填的行数。 */
    function paintLastRun(prefix) {
      if (barBusy || lastRun === null || !isRecord(lastRun.results)) return 0
      let painted = 0
      for (const [key, single] of Object.entries(lastRun.results)) {
        const separator = key.lastIndexOf('::')
        const modelId = separator >= 0 ? key.slice(separator + 2) : key
        const row = rowByKey.get(key) ?? rowByModel.get(modelId) ?? null
        if (row === null) continue
        paintChip(row, single)
        painted += 1
      }
      if (painted > 0) {
        const { ok, bad, total } = summarize(lastRun.results)
        const when = timeLabel(lastRun.at)
        updateBar(`${prefix}${ok} 通 / ${bad} 异常（共 ${total}）${when ? ` · ${when}` : ''}`)
        updateBalance(lastRun.balances)
      }
      return painted
    }

    /** 记住一次检测结果（覆盖式：永远只保留最近一次）并落盘。 */
    function rememberResults(results, balances) {
      lastRun = { results, balances: isRecord(balances) ? balances : {}, at: Date.now() }
      if (doctor !== null) void doctor.resultsSave(lastRun)
    }

    function loadResults() {
      if (doctor === null) return Promise.resolve()
      return doctor.resultsLoad().then((snapshot) => {
        if (disposed) return
        if (snapshot && isRecord(snapshot.results)) {
          lastRun = snapshot
          scheduleEnhance()
        }
      })
    }

    /* ---------------------------------------------------------------- */
    /* 行内元素构造                                                      */
    /* ---------------------------------------------------------------- */

    function chipOf(result) {
      const chip = document.createElement('span')
      if (!result || typeof result !== 'object' || result.ok === undefined) {
        chip.className = 'dmd-chip is-bad'
        chip.textContent = '✗ 通道异常'
        return chip
      }
      if (result.ok === true) {
        chip.className = 'dmd-chip is-ok'
        chip.textContent = `✓ ${Number.isFinite(result.ms) ? result.ms : '?'}ms`
        chip.title = '连通正常（1-token 探测）'
        return chip
      }
      const kind = typeof result.kind === 'string'
        ? result.kind
        : (typeof result.error === 'string' ? 'channel' : 'unsupported')
      const label = KIND_LABEL[kind] ?? '失败'
      const code = typeof result.status === 'number' && result.status > 0 ? ` ${result.status}` : ''
      chip.className = 'dmd-chip is-bad'
      chip.textContent = `✗${code} ${label}`
      const detail = typeof result.message === 'string' && result.message.length > 0
        ? ` · ${result.message}`
        : (typeof result.error === 'string' ? ` · ${result.error}` : '')
      chip.title = `HTTP ${result.status || '-'}${detail}`
      return chip
    }

    function wireDelete(button, provider, model, row) {
      let armed = false
      let timer = 0
      const disarm = () => {
        armed = false
        button.classList.remove('is-armed')
        button.textContent = '🗑'
        button.title = '从列表删除该模型（二次点击确认）'
      }
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        event.preventDefault()
        if (doctor === null) return
        if (!armed) {
          armed = true
          button.classList.add('is-armed')
          button.textContent = '确认删除?'
          clearTimeout(timer)
          timer = window.setTimeout(disarm, 2600)
          return
        }
        clearTimeout(timer)
        button.classList.remove('is-armed')
        button.textContent = '…'
        doctor.deleteModel(provider, model).then((result) => {
          if (disposed) return
          if (result && result.ok === true) {
            deletedKeys.add(keyOf(provider, model))
            const section = row.closest('section')
            row.remove()
            if (section !== null && section.querySelectorAll(ROW_SEL).length === 0) section.remove()
            fetchDirectory(true)
          } else {
            const message = result && typeof result.error === 'string' ? result.error : '删除失败'
            const chip = document.createElement('span')
            chip.className = 'dmd-chip is-bad'
            chip.textContent = '✗ 删除失败'
            chip.title = message
            button.replaceWith(chip)
            window.setTimeout(() => chip.remove(), 4000)
            disarm()
          }
        })
      })
      button.addEventListener('mousedown', (event) => event.stopPropagation())
      button.addEventListener('keydown', (event) => event.stopPropagation())
    }

    /** 行里作为「模型名」的锚点：通用路径记录文本节点父元素，兼容路径用名字元素。 */
    function labelAnchor(row) {
      const mapped = rowAnchor.get(row)
      if (mapped !== undefined && mapped.isConnected) return mapped
      return row.querySelector(NAME_SEL)
    }

    /** 把结果徽章插到模型名后面（随文字行内排，不占右侧按钮的位置）。 */
    function paintChip(row, result) {
      row.querySelectorAll('.dmd-chip').forEach((chip) => chip.remove())
      const chip = chipOf(result)
      const anchor = labelAnchor(row)
      if (anchor !== null && anchor !== undefined && anchor.parentNode !== null) {
        anchor.parentNode.insertBefore(chip, anchor.nextSibling)
      } else {
        row.appendChild(chip)
      }
      return chip
    }

    function enhanceRow(row, providerId, model) {
      const key = keyOf(providerId, model.id)
      if (deletedKeys.has(key)) {
        row.remove()
        return
      }
      // 映射登记放在早退之前：已挂过按钮的行每次扫描也要重新入表。
      rowByKey.set(key, row)
      const previous = rowByModel.get(model.id)
      if (previous === undefined) rowByModel.set(model.id, row)
      else if (previous !== row) rowByModel.set(model.id, null)
      if (row.querySelector('.dmd-actions') !== null) return

      // 按钮钉在选项右侧：行本身需要是定位上下文，并留出右侧空间。
      const computed = window.getComputedStyle(row)
      if (computed.position === 'static') row.style.position = 'relative'
      if (Number.parseFloat(computed.paddingRight) < 88) row.style.paddingRight = '88px'

      const actions = document.createElement('span')
      actions.className = 'dmd-actions'
      actions.dataset.dmdKey = key

      const refresh = document.createElement('span')
      refresh.className = 'dmd-btn dmd-refresh'
      refresh.setAttribute('role', 'button')
      refresh.textContent = '⟳'
      refresh.title = '检测该模型连通状况 / 是否欠费'
      refresh.addEventListener('click', (event) => {
        event.stopPropagation()
        event.preventDefault()
        if (doctor === null || refresh.classList.contains('is-busy')) return
        refresh.classList.add('is-busy')
        row.querySelectorAll('.dmd-chip').forEach((chip) => chip.remove())
        doctor.check(providerId, model.id).then((result) => {
          if (disposed) return
          refresh.classList.remove('is-busy')
          paintChip(row, result)
          rememberResults({ ...(lastRun?.results ?? {}), [key]: result }, lastRun?.balances)
        })
      })
      refresh.addEventListener('mousedown', (event) => event.stopPropagation())

      const del = document.createElement('span')
      del.className = 'dmd-btn dmd-delete'
      del.setAttribute('role', 'button')
      del.textContent = '🗑'
      del.title = '从列表删除该模型（二次点击确认）'
      wireDelete(del, providerId, model.id, row)

      actions.appendChild(refresh)
      actions.appendChild(del)
      row.appendChild(actions)
    }

    /* ---------------------------------------------------------------- */
    /* 「全部检测」条                                                    */
    /* ---------------------------------------------------------------- */

    /**
     * 在 host 里放一条「全部检测」。
     * @param host 承载容器
     * @param hint 初始状态文案
     * @param before 插入到该子节点之前（省略则插到最前）
     */
    function ensureAllBar(host, hint, before = null) {
      if (host === null || host === undefined) return
      const existing = host.querySelector('.dmd-allbar')
      if (existing !== null) {
        if (hint) {
          const status = existing.querySelector('.dmd-status')
          if (status !== null && status.textContent === '') status.textContent = hint
        }
        return
      }
      const bar = document.createElement('div')
      bar.className = 'dmd-allbar'
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = '⚡ 全部检测'
      button.title = '并发探测列表里全部模型的连通状况与额度'
      const status = document.createElement('span')
      status.className = 'dmd-status'
      const balance = document.createElement('span')
      balance.className = 'dmd-balance'
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        event.preventDefault()
        if (doctor === null || button.disabled) return
        button.disabled = true
        barBusy = true
        status.textContent = '探测中…'
        balance.textContent = ''
        rowByKey.forEach((row) => {
          row.querySelectorAll('.dmd-chip').forEach((chip) => chip.remove())
        })
        doctor.checkAll().then((result) => {
          if (disposed) return
          button.disabled = false
          barBusy = false
          if (!result || result.ok === false || !isRecord(result.results)) {
            status.textContent = `失败：${result && typeof result.error === 'string' ? result.error : '通道异常'}`
            return
          }
          rememberResults(result.results, result.balances)
          let okCount = 0
          let badCount = 0
          let unmatched = 0
          const entries = Object.entries(result.results)
          for (const [key, single] of entries) {
            const separator = key.lastIndexOf('::')
            const modelId = separator >= 0 ? key.slice(separator + 2) : key
            const row = rowByKey.get(key) ?? rowByModel.get(modelId) ?? null
            if (row === null) unmatched += 1
            else paintChip(row, single)
            if (single && single.ok === true) okCount += 1
            else badCount += 1
          }
          const suffix = unmatched > 0 ? ` · 未匹配 ${unmatched}` : ''
          const when = timeLabel(lastRun?.at ?? Date.now())
          status.textContent = `完成：${okCount} 通 / ${badCount} 异常（共 ${entries.length}）${suffix}${when ? ` · ${when}` : ''}`
          if (isRecord(result.balances)) {
            const parts = Object.entries(result.balances)
              .map(([providerId, value]) => `${providerLabel(providerId)}: ¥${value}`)
            balance.textContent = parts.join(' · ')
          }
        })
      })
      button.addEventListener('mousedown', (event) => event.stopPropagation())
      bar.appendChild(button)
      bar.appendChild(status)
      bar.appendChild(balance)
      if (hint) status.textContent = hint
      if (before !== null && before.parentNode === host) host.insertBefore(bar, before)
      else host.insertBefore(bar, host.firstChild)
    }

    function providerLabel(providerId) {
      const provider = directory?.providers?.find((p) => p.id === providerId)
      return provider?.name ?? providerId
    }

    /* ---------------------------------------------------------------- */
    /* 诊断上报（写进宿主文件，便于远程定位 DOM 结构，不影响功能）          */
    /* ---------------------------------------------------------------- */

    let reportSignature = ''
    let reportAt = 0

    function describe(el) {
      if (el === null || el === undefined) return null
      const cls = typeof el.className === 'string' ? el.className.trim().slice(0, 80) : ''
      const text = normText(el.textContent).slice(0, 50)
      return { tag: el.tagName, role: el.getAttribute('role') ?? '', cls, text }
    }

    function reportDiagnostics(state) {
      if (doctor === null) return
      const signature = JSON.stringify(state)
      if (signature === reportSignature) return
      if (Date.now() - reportAt < 1200) return
      reportSignature = signature
      reportAt = Date.now()
      void doctor.clientReport(state)
    }

    /* ---------------------------------------------------------------- */
    /* 菜单增强主逻辑                                                    */
    /* ---------------------------------------------------------------- */

    /** 兼容路径：dsh-reasoning-effort 的 `.re-model-menu` 结构。 */
    function enhanceLegacy(menu) {
      let wired = 0
      const panes = menu.querySelectorAll(PANE_SEL)
      panes.forEach((pane) => {
        const sections = pane.querySelectorAll('section')
        if (sections.length === 0) return
        sections.forEach((section) => {
          const title = section.querySelector(TITLE_SEL)?.textContent?.trim()
          if (title === undefined || title.length === 0) return
          const rows = Array.from(section.querySelectorAll(ROW_SEL))
          const group = directory?.providers?.find((p) => p.name === title || p.id === title)
          if (group !== undefined && rows.length === group.models.length) {
            rows.forEach((row, index) => {
              const model = group.models[index]
              const name = row.querySelector(NAME_SEL)?.textContent?.trim()
              if (name !== undefined && name !== model.name) return
              rowAnchor.set(row, row.querySelector(NAME_SEL) ?? row)
              enhanceRow(row, group.id, model)
              wired += 1
            })
            return
          }
          // 兜底：供应商显示名对不上时，按「模型显示名在全目录里唯一」反查
          rows.forEach((row) => {
            const name = row.querySelector(NAME_SEL)?.textContent?.trim()
            if (name === undefined || name.length === 0) return
            const hits = []
            for (const provider of directory?.providers ?? []) {
              for (const model of provider.models) {
                if (model.name === name) hits.push({ provider, model })
              }
            }
            if (hits.length !== 1) return
            rowAnchor.set(row, row.querySelector(NAME_SEL) ?? row)
            enhanceRow(row, hits[0].provider.id, hits[0].model)
            wired += 1
          })
        })
        let hint = ''
        if (directory === null) {
          hint = directoryFailedAt !== 0
            ? `模型医生：目录获取失败 · ${directoryError || '与宿主半通信异常'}`
            : '模型医生：目录获取中…'
        } else if (wired === 0) {
          hint = '模型医生：未匹配到模型行（目录与菜单不一致）'
        }
        ensureAllBar(pane, hint, pane.querySelector('section'))
      })
      return wired
    }

    /**
     * 通用路径：任何菜单渲染器（官方原生 / dsh-effort-slider / 其他弹层）。
     * 依据「已知模型名」定位行，向上取可点击祖先。
     */
    function enhanceGeneric(legacyWired) {
      const roots = Array.from(document.querySelectorAll(MENU_ROOT_SEL))
        .filter((root) => isVisible(root))
        .filter((root) => root.closest('.dmd-allbar') === null)
        .filter((root) => !root.classList.contains('dmd-allbar'))
      const samples = roots.slice(0, 6).map(describe)
      let wired = 0
      const rootStats = []
      for (const root of roots) {
        const hits = genericRowsIn(root)
        rootStats.push({ root: describe(root), rows: hits.length })
        if (hits.length < MIN_GENERIC_ROWS) continue
        let containerWired = 0
        for (const hit of hits) {
          const entry = pickEntry(hit.entries, hit.row)
          if (entry === undefined) continue
          rowAnchor.set(hit.row, hit.anchor)
          enhanceRow(hit.row, entry.providerId, { id: entry.modelId, name: entry.modelName })
          containerWired += 1
        }
        if (containerWired > 0) {
          wired += containerWired
          const barHost = hits[0].row.parentElement ?? root
          let hint = ''
          if (directory === null) {
            hint = directoryFailedAt !== 0
              ? `模型医生：目录获取失败 · ${directoryError || '与宿主半通信异常'}`
              : '模型医生：目录获取中…'
          }
          ensureAllBar(barHost, hint, hits[0].row)
        }
      }
      lastDiagnostics = {
        at: Date.now(),
        mode: legacyWired > 0 ? 'legacy+generic' : 'generic',
        tokens: ensureTokenIndex().size,
        providerCount: directory?.providers?.length ?? 0,
        modelCount: (directory?.providers ?? []).reduce((sum, p) => sum + p.models.length, 0),
        legacyWired,
        genericWired: wired,
        roots: rootStats.slice(0, 8),
        samples,
      }
      return wired
    }

    function enhance() {
      if (disposed) return
      if (directory === null || Date.now() - directoryAt >= DIRECTORY_TTL_MS) {
        void fetchDirectory()
      }
      rowByKey.clear()
      rowByModel.clear()
      rowAnchor = new WeakMap()

      const menu = document.querySelector(MENU_SEL)
      const legacyWired = menu === null ? 0 : enhanceLegacy(menu)
      const genericWired = enhanceGeneric(legacyWired)

      if (legacyWired + genericWired > 0) paintLastRun('上次结果：')
      if (lastDiagnostics !== null) {
        reportDiagnostics({
          ...lastDiagnostics,
          barCount: document.querySelectorAll('.dmd-allbar').length,
          actionCount: document.querySelectorAll('.dmd-actions').length,
        })
      }
    }

    function scheduleEnhance() {
      if (rafId !== 0 || disposed) return
      rafId = window.requestAnimationFrame(() => {
        rafId = 0
        enhance()
      })
    }

    /* ---------------------------------------------------------------- */
    /* apply                                                            */
    /* ---------------------------------------------------------------- */

    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    function apply(ctx) {
      ctxRef = ctx
      doctor = makeDoctor()

      ctx.effect(() => {
        styleEl = document.createElement('style')
        styleEl.dataset.plugin = 'dsh-model-doctor'
        styleEl.textContent = CSS
        document.head.appendChild(styleEl)
        return () => styleEl?.remove()
      }, 'model-doctor: styles')

      ctx.effect(() => {
        observer = new MutationObserver(scheduleEnhance)
        observer.observe(document.body, { childList: true, subtree: true })
        scheduleEnhance()
        return () => {
          disposed = true
          observer?.disconnect()
          if (rafId !== 0) window.cancelAnimationFrame(rafId)
        }
      }, 'model-doctor: observer')

      void loadResults()
    }

    module.exports = { apply, inject }
    return module.exports
  },
})
