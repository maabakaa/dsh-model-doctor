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
    /** 官方菜单（@deepseek-ai/dsh-client-ui-model-selection）：类名是 CSS Module 哈希
     *  （形如 `wq12jW_option wq12jW_modelOption`），但局部名稳定，用后缀匹配；
     *  模型行是 `button[role="menuitemradio"]`，且 `title` 属性就是模型名。 */
    const OFFICIAL_ROW_SEL = '[role="menuitemradio"]'
    const OFFICIAL_MENU_SUFFIX = '_menu'
    const OFFICIAL_OPTION_SUFFIX = 'modelOption'
    const OFFICIAL_NAME_SUFFIX = 'modelName'
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
.dmd-actions{position:absolute;right:6px;top:50%;transform:translateY(-50%);display:inline-flex;align-items:center;gap:4px;z-index:2}
.dmd-btn{width:24px;height:24px;line-height:23px;text-align:center;font-size:15px;border-radius:8px;cursor:pointer;user-select:none;color:inherit;background:color-mix(in srgb,currentColor 8%,transparent);opacity:.72;flex-shrink:0}
.dmd-btn:hover{opacity:1;background:color-mix(in srgb,currentColor 18%,transparent)}
.dmd-btn.dmd-refresh.is-busy{opacity:1;animation:dmd-spin 0.9s linear infinite}
.dmd-btn.dmd-delete:hover{color:#e5484d}
.dmd-btn.is-armed{width:auto;padding:0 9px;color:#e5484d;opacity:1;font-size:12px;font-weight:600;line-height:26px}
@keyframes dmd-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
.dmd-chip{font-size:11px;line-height:17px;padding:0 7px;margin-left:2px;border-radius:999px;white-space:nowrap;vertical-align:middle;display:inline-block;flex:none;box-sizing:border-box;width:84px;text-align:center;overflow:hidden;text-overflow:ellipsis}
.dmd-chip.is-stale{opacity:.45}
.dmd-chip.is-ok{color:#2fa96e;background:color-mix(in srgb,#2fa96e 16%,transparent)}
.dmd-chip.is-bad{color:#e5484d;background:color-mix(in srgb,#e5484d 14%,transparent)}
.dmd-chip.is-warn{color:#d08700;background:color-mix(in srgb,#d08700 16%,transparent)}
/* max-width 是关键：官方菜单是 width:max-content，状态条文字不能把菜单撑宽 */
.dmd-allbar{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;padding:6px 10px;margin:2px 4px;font-size:11px;border-radius:8px;background:color-mix(in srgb,currentColor 6%,transparent);max-width:208px}
.dmd-allbar button{font:inherit;font-size:11px;line-height:16px;padding:2px 9px;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 25%,transparent);background:transparent;color:inherit;cursor:pointer;flex:none}
.dmd-allbar button:disabled,.dmd-allbar button.is-busy{opacity:.45;cursor:default}
.dmd-allbar .dmd-status,.dmd-allbar .dmd-balance{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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
    /** 通用（文本聚类）路径统计。 */
    let lastGenericStats = null
    /** 官方路径统计。 */
    let lastOfficialStats = null
    /** 本轮扫描是否改动过菜单 DOM（用于决定要不要让官方菜单立刻重新锚定）。 */
    let mutatedThisPass = false
    let reanchorAt = 0
    /** 上一轮看到的官方菜单尺寸（宽x高）：尺寸一变就立刻让官方重新锚定。 */
    let lastMenuSize = ''

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

    /** 折叠文本：去掉一切非字母数字（含空格、连字符、点），用于宽松名字比对。
     *  「gpt-4o mini」与「gpt-4o-mini」折叠后同为 gpt4omini。 */
    function foldText(value) {
      return String(value ?? '').toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/gu, '')
    }

    /** 元素类名里是否含某个局部名（CSS Module 哈希前缀无关）。 */
    function hasClassToken(el, token) {
      const cls = typeof el.className === 'string' ? el.className : ''
      return cls.toLowerCase().includes(token.toLowerCase())
    }

    /** 目录里按 名字/ID 找模型：先精确原名，再折叠名。 */
    function findModelsByName(name) {
      const raw = normText(name)
      const folded = foldText(name)
      const hits = []
      if (raw.length === 0) return hits
      for (const provider of directory?.providers ?? []) {
        for (const model of provider.models) {
          const exact = normText(model.name) === raw || normText(model.id) === raw
          const loose = !exact
            && folded.length >= 3
            && (foldText(model.name) === folded || foldText(model.id) === folded)
          if (!exact && !loose) continue
          hits.push({
            providerId: provider.id,
            providerName: provider.name,
            modelId: model.id,
            modelName: model.name,
          })
        }
      }
      return hits
    }

    /** 模型名/ID -> 候选条目索引；15 秒内复用。 */
    let tokenIndex = null
    let tokenIndexAt = 0
    /** 预编译的 token 正则（先粗筛文本节点，避免对每个节点做全量比对）。 */
    let tokenRegex = null
    /** [token, entries] 按 token 长度降序：优先匹配更具体的名字。 */
    let tokenPairs = []

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
      tokenPairs = Array.from(index.entries()).sort((a, b) => b[0].length - a[0].length)
      tokenRegex = tokenPairs.length === 0
        ? null
        : new RegExp(tokenPairs.map(([token]) => token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|'), 'u')
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
     * 全文档找出「命中了已知模型名」的最小行容器。
     * 不再依赖任何菜单根选择器：先用预编译正则粗筛文本节点，再逐一确认 token 命中，
     * 然后向上取最近的可点击祖先。
     */
    function minimalMatches(root) {
      const index = ensureTokenIndex()
      const found = new Map()
      if (index.size === 0 || tokenRegex === null) return found
      const record = (row, token, entries, anchor) => {
        const current = found.get(row)
        if (current === undefined || token.length > current.token.length) {
          found.set(row, { token, entries, anchor })
        }
      }
      const scan = (pairs, folded) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node !== null) {
          const raw = node.nodeValue
          if (raw !== null && raw.length > 1 && raw.length <= 200) {
            const text = folded ? foldText(raw) : normText(raw)
            if (text.length >= 2 && (folded || tokenRegex.test(text))) {
              const anchor = node.parentElement
              if (anchor !== null) {
                for (const [token, entries] of pairs) {
                  if (token.length > text.length || !text.includes(token)) continue
                  const row = clickableRow(anchor, root)
                  if (row === null) continue
                  record(row, token, entries, anchor)
                }
              }
            }
          }
          node = walker.nextNode()
        }
      }
      scan(tokenPairs, false)
      // 原名对不上时（菜单显示名与目录写法不同，如空格 vs 连字符）再做一遍折叠匹配
      if (found.size < 2) {
        const foldedPairs = []
        for (const [token, entries] of tokenPairs) {
          const folded = foldText(token)
          if (folded.length >= 3) foldedPairs.push([folded, entries])
        }
        foldedPairs.sort((a, b) => b[0].length - a[0].length)
        if (foldedPairs.length > 0) scan(foldedPairs, true)
      }
      // 排除「容器型行」：行文本里出现两个以上不同模型 → 它装的是列表，不是单行。
      for (const [row] of Array.from(found.entries())) {
        if (countDistinctModels(row, index) > 1) found.delete(row)
      }
      return found
    }

    /** 一个元素里出现了几个不同模型（>1 说明它是容器）。 */
    function countDistinctModels(el, index) {
      const text = normText(el.textContent)
      const distinct = new Set()
      for (const [token, entries] of index) {
        if (!text.includes(token)) continue
        for (const entry of entries) distinct.add(`${entry.providerId}::${entry.modelId}`)
        if (distinct.size > 1) return distinct.size
      }
      return distinct.size
    }

    /** 容器是否像弹层（绝对定位或带菜单语义），用于排除正文里碰巧出现的模型名。 */
    function isPopoverish(el) {
      let node = el
      let depth = 0
      while (node !== null && node !== document.body && depth < 4) {
        const role = typeof node.getAttribute === 'function' ? node.getAttribute('role') : null
        if (typeof role === 'string' && /^(menu|listbox|dialog|alertdialog)$/u.test(role)) return true
        try {
          const position = window.getComputedStyle(node).position
          if (position === 'absolute' || position === 'fixed') return true
        } catch { /* 忽略计算样式失败 */ }
        node = node.parentElement
        depth += 1
      }
      return false
    }

    /** 把命中的行按容器聚类：同一父节点下 ≥2 行才算一个菜单。 */
    function clusterRows(found) {
      const byParent = new Map()
      for (const [row, hit] of found.entries()) {
        const parent = row.parentElement ?? document.body
        const list = byParent.get(parent) ?? []
        list.push({ row, ...hit })
        byParent.set(parent, list)
      }
      const clusters = []
      const orphans = []
      for (const [parent, list] of byParent.entries()) {
        if (list.length >= 1) clusters.push({ host: parent, rows: list })
        else orphans.push(...list)
      }
      if (orphans.length >= 1) {
        const byGrand = new Map()
        for (const hit of orphans) {
          const grand = hit.row.parentElement?.parentElement ?? document.body
          const list = byGrand.get(grand) ?? []
          list.push(hit)
          byGrand.set(grand, list)
        }
        for (const [grand, list] of byGrand.entries()) {
          if (list.length >= 1) clusters.push({ host: grand, rows: list })
        }
      }
      return clusters
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
            // 焦点若在被删行上，移除后焦点会落到 body → 官方 onBlur 会关闭菜单，
            // 所以先把焦点转移到相邻的模型行再移除。
            const hadFocus = row === document.activeElement
            const neighbour = row.nextElementSibling ?? row.previousElementSibling
            mutatedThisPass = true
            row.remove()
            if (section !== null && section.querySelectorAll(ROW_SEL).length === 0) section.remove()
            if (hadFocus) {
              const target = (neighbour !== null && neighbour.isConnected ? neighbour : null)
                ?? document.querySelector('[role="menuitemradio"]')
              if (target !== null && typeof target.focus === 'function') target.focus()
            }
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
      mutatedThisPass = true
      // 官方行是 flex 行（align-items:center / nowrap）。徽章必须作为同一行的弹性项插在
      // 按钮之前；插进 .optionCopy（纵向 flex）会多出一行、把行高和菜单尺寸一起改掉，
      // 那样官方 place() 下次滚动才会重算位置 —— 表现就是「一滚动菜单就跳位」。
      const actions = row.querySelector(':scope > .dmd-actions')
      if (actions !== null) {
        row.insertBefore(chip, actions)
        return chip
      }
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
      if (Number.parseFloat(computed.paddingRight) < 62) row.style.paddingRight = '62px'

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
      mutatedThisPass = true
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
      mutatedThisPass = true
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = '⚡ 全部检测'
      button.title = '并发探测列表里全部模型的连通状况与额度'
      const status = document.createElement('span')
      status.className = 'dmd-status'
      const balance = document.createElement('span')
      balance.className = 'dmd-balance'
      // 忙碌用标记而不是 disabled：被禁用的聚焦元素会把焦点丢给 body，
      // 而官方菜单在根节点上监听 onBlur（portal 的事件仍走 React 树冒泡），
      // 焦点一离开菜单就会 setOpen(false) —— 表现就是「点全部检测菜单被关掉」。
      let busy = false
      const setBusy = (value) => {
        busy = value
        button.classList.toggle('is-busy', value)
        button.setAttribute('aria-busy', value ? 'true' : 'false')
        button.style.pointerEvents = value ? 'none' : ''
      }
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        event.preventDefault()
        if (doctor === null || busy) return
        setBusy(true)
        barBusy = true
        status.textContent = '探测中…'
        balance.textContent = ''
        // 只把旧结果「变灰」，绝不删除：删徽章会让行变窄、菜单跟着变窄，
        // 而官方 place() 要等下次滚动才重算 —— 表现就是检测期间一滚动菜单就右移。
        rowByKey.forEach((row) => {
          row.querySelectorAll('.dmd-chip').forEach((chip) => chip.classList.add('is-stale'))
        })
        doctor.checkAll().then((result) => {
          if (disposed) return
          setBusy(false)
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
          // 状态条文案变长也会改菜单尺寸：补一次重锚定
          reanchorOfficialMenu(true)
        })
      })
      // preventDefault 阻止焦点转移到本按钮：焦点一旦离开菜单，官方 onBlur 就会关闭菜单
      button.addEventListener('mousedown', (event) => {
        event.preventDefault()
        event.stopPropagation()
      })
      button.addEventListener('pointerdown', (event) => event.stopPropagation())
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
    /** 最近一次写入的报告是否包含「菜单已打开」的现场。 */
    let lastReportHadMenu = false

    function describe(el) {
      if (el === null || el === undefined) return null
      const cls = typeof el.className === 'string' ? el.className.trim().slice(0, 80) : ''
      const text = normText(el.textContent).slice(0, 50)
      return { tag: el.tagName, role: el.getAttribute('role') ?? '', cls, text }
    }

    function reportDiagnostics(state, menuVisible = false) {
      if (doctor === null) return
      const { at, ...rest } = state
      const signature = JSON.stringify(rest)
      const now = Date.now()
      const isError = typeof state.error === 'string'
      // 报告里已经留下「菜单打开」的现场时，不要被随后「菜单关闭」的空扫描覆盖（错误除外）
      if (!menuVisible && !isError && lastReportHadMenu) return
      if (!isError && signature === reportSignature && now - reportAt < (menuVisible ? 5000 : 1200)) return
      if (now - reportAt < 400) return
      reportSignature = signature
      reportAt = now
      lastReportHadMenu = menuVisible
      void doctor.clientReport(state)
    }

    /* ---------------------------------------------------------------- */
    /* 菜单增强主逻辑                                                    */
    /* ---------------------------------------------------------------- */

    /** 官方模型行的名字：优先 title 属性（官方就是 model.name），再 _modelName 文本。 */
    function officialRowName(row) {
      const title = row.getAttribute('title')
      if (typeof title === 'string' && title.trim().length > 0) return title.trim()
      const nameEl = row.querySelector(`[class*="${OFFICIAL_NAME_SUFFIX}"]`)
      const text = nameEl?.textContent?.trim()
      if (text !== undefined && text.length > 0) return text
      return (row.textContent ?? '').trim()
    }

    /**
     * 官方路径（首选）：直接按官方 DOM 契约定位模型行，不靠文本猜。
     * 行 = `button[role="menuitemradio"]`（类名含 modelOption，或名字能对上目录）；
     * 名字取 `title` 属性 → 与权威目录比对得到 provider/model。
     */
    function enhanceOfficial() {
      const rows = Array.from(document.querySelectorAll(OFFICIAL_ROW_SEL)).filter((row) => {
        if (hasClassToken(row, OFFICIAL_OPTION_SUFFIX)) return true
        // 没有 modelOption 类时（契约变化）退一步：名字能对上目录才算模型行，
        // 这样 effort（力度）面板里的 menuitemradio 不会被误加按钮。
        return findModelsByName(officialRowName(row)).length > 0
      })
      if (rows.length === 0) return { rows: 0, wired: 0, samples: [], menuFound: false }
      const samples = []
      let wired = 0
      let unmatched = 0
      for (const row of rows) {
        const name = officialRowName(row)
        const hits = findModelsByName(name)
        if (samples.length < 8) {
          samples.push({ cls: String(row.className ?? '').slice(0, 70), title: name.slice(0, 40), hits: hits.length })
        }
        if (hits.length === 0) {
          unmatched += 1
          continue
        }
        const entry = pickEntry(hits, row)
        const isNew = row.querySelector('.dmd-actions') === null
        rowAnchor.set(row, row.querySelector(`[class*="${OFFICIAL_NAME_SUFFIX}"]`) ?? row)
        enhanceRow(row, entry.providerId, { id: entry.modelId, name: entry.modelName })
        if (isNew) wired += 1
      }
      // 状态条插到菜单顶层（一次），而不是每个供应商分组各插一条
      const menuRoot = rows[0].closest(`[class*="${OFFICIAL_MENU_SUFFIX}"]`)
        ?? rows[0].closest('[role="menu"]')
        ?? rows[0].parentElement
      let hint = ''
      if (directory === null) {
        hint = directoryFailedAt !== 0
          ? `模型医生：目录获取失败 · ${directoryError || '与宿主半通信异常'}`
          : '模型医生：目录获取中…'
      } else if (unmatched > 0) {
        hint = `模型医生：${unmatched} 个模型未匹配上目录`
      }
      ensureAllBar(menuRoot, hint, menuRoot?.firstChild ?? null)
      return { rows: rows.length, wired, samples, unmatched, menuFound: true }
    }

    /** 官方路径：dsh-reasoning-effort 的 `.re-model-menu` 结构。 */
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
     * 依据「已知模型名」在全文定位行，按容器聚类成菜单，再逐行增强。
     */
    function enhanceGeneric(legacyWired) {
      const index = ensureTokenIndex()
      const roots = Array.from(document.querySelectorAll(MENU_ROOT_SEL)).filter((root) => isVisible(root))
      const hits = minimalMatches(document.body)
      const clusters = clusterRows(hits)
      let wired = 0
      let registered = 0
      let unmatched = 0
      const clusterStats = []
      for (const cluster of clusters) {
        let newlyWired = 0
        for (const hit of cluster.rows) {
          const entry = pickEntry(hit.entries, hit.row)
          if (entry === undefined) {
            unmatched += 1
            continue
          }
          const isNew = hit.row.querySelector('.dmd-actions') === null
          rowAnchor.set(hit.row, hit.anchor)
          enhanceRow(hit.row, entry.providerId, { id: entry.modelId, name: entry.modelName })
          registered += 1
          if (isNew) newlyWired += 1
        }
        clusterStats.push({
          host: describe(cluster.host),
          rows: cluster.rows.length,
          wired: newlyWired,
        })
        if (cluster.rows.length >= MIN_GENERIC_ROWS) {
          const first = cluster.rows[0]
          let hint = ''
          if (directory === null) {
            hint = directoryFailedAt !== 0
              ? `模型医生：目录获取失败 · ${directoryError || '与宿主半通信异常'}`
              : '模型医生：目录获取中…'
          } else if (newlyWired === 0 && first.row.querySelector('.dmd-actions') === null) {
            hint = '模型医生：模型行未匹配上目录'
          }
          const barHost = first.row.parentElement ?? cluster.host
          ensureAllBar(barHost, hint, first.row)
        }
      }
      lastGenericStats = {
        legacyWired,
        genericWired: wired,
        registered,
        unmatched,
        hitCount: hits.size,
        visibleRoots: roots.length,
        clusters: clusterStats.slice(0, 8),
        samples: roots.slice(0, 5).map(describe),
      }
      return registered > 0 ? Math.max(1, wired) : 0
    }

    /** 菜单结构快照（仅菜单可见时生成，便于远程确认 DOM 契约是否变化）。 */
    function dumpMenu() {
      const menuRoot = document.querySelector(`[class*="${OFFICIAL_MENU_SUFFIX}"]`)
        ?? document.querySelector(MENU_SEL)
        ?? document.querySelector('[role="menu"]')
      if (menuRoot === null || !isVisible(menuRoot)) return null
      const nodes = []
      const walk = (el, depth) => {
        if (nodes.length >= 40 || depth > 4) return
        nodes.push({
          d: depth,
          tag: el.tagName,
          cls: (typeof el.className === 'string' ? el.className : '').slice(0, 70),
          role: el.getAttribute('role') ?? '',
          title: (el.getAttribute('title') ?? '').slice(0, 40),
          text: normText(el.textContent).slice(0, 36),
        })
        for (const child of Array.from(el.children).slice(0, 12)) walk(child, depth + 1)
      }
      walk(menuRoot, 0)
      return { root: describe(menuRoot), nodes }
    }

    function enhance() {
      if (disposed) return
      try {
        enhanceInner()
      } catch (error) {
        // 任何异常都要留痕：否则菜单开着时崩在中间，诊断文件会一直停留在旧状态
        reportDiagnostics({
          at: Date.now(),
          mode: 'error',
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error
            ? String(error.stack ?? '').split('\n').slice(0, 5).join(' | ').slice(0, 500)
            : '',
          href: window.location.href.slice(0, 120),
        }, true)
      }
    }

    /**
     * 让官方菜单立刻按当前尺寸重新锚定。
     *
     * 官方 place() 只在 window 的 scroll（捕获）与 resize 时重算，而它把菜单放在
     * 「触发按钮上方、底部对齐」的位置（y = trigger.top - 8 - 菜单高，x = trigger.right - 菜单宽）。
     * 我们的按钮/徽章/状态条会让菜单变宽，如果不在改动后立刻重算，位置就要等用户
     * 下次滚动才更新 —— 表现就是「一往下滑菜单就跳位」。
     * 这里向菜单派发一个 scroll 事件：它不冒泡，所以只会在捕获阶段命中官方监听，
     * 不会惊动其它监听 window 滚动（冒泡阶段）的组件。
     */
    function reanchorOfficialMenu(force = false) {
      const menu = document.querySelector(`[class*="${OFFICIAL_MENU_SUFFIX}"]`)
      if (menu === null) return
      const now = Date.now()
      if (!force && now - reanchorAt < 200) return
      reanchorAt = now
      try {
        // 官方 place() 同时监听 window 的 scroll（捕获阶段）与 resize：
        // 前者精准（不冒泡，不会惊动其它滚动监听），后者作为保底。
        menu.dispatchEvent(new Event('scroll'))
        window.dispatchEvent(new Event('resize'))
      } catch { /* 忽略派发失败 */ }
    }

    /** 菜单尺寸（宽x高）是否与上一轮不同；不同就说明位置需要立刻重算。 */
    function officialMenuSizeChanged() {
      const menu = document.querySelector(`[class*="${OFFICIAL_MENU_SUFFIX}"]`)
      if (menu === null) {
        lastMenuSize = ''
        return false
      }
      const size = `${menu.offsetWidth}x${menu.offsetHeight}`
      if (size === lastMenuSize) return false
      lastMenuSize = size
      return true
    }

    function enhanceInner() {
      if (directory === null || Date.now() - directoryAt >= DIRECTORY_TTL_MS) {
        void fetchDirectory()
      }
      rowByKey.clear()
      rowByModel.clear()
      rowAnchor = new WeakMap()
      mutatedThisPass = false

      // ① 官方路径（首选，按官方 DOM 契约精确取行）
      const official = enhanceOfficial()
      lastOfficialStats = official
      // ② 兼容路径（dsh-reasoning-effort）
      const menu = document.querySelector(MENU_SEL)
      const legacyWired = menu === null ? 0 : enhanceLegacy(menu)
      // ③ 通用兜底（未知渲染器）：前两条都没命中时才跑全文文本聚类
      const genericWired = official.menuFound || legacyWired > 0 ? 0 : enhanceGeneric(legacyWired)
      if (official.menuFound || legacyWired > 0) lastGenericStats = null

      const wired = official.wired + legacyWired + genericWired
      if (wired > 0) paintLastRun('上次结果：')
      if (official.menuFound) {
        // 兜底：无论尺寸变化是谁造成的（我们加/删元素、官方自身重渲染、状态条文案变长），
        // 只要实测尺寸变了，就立刻让官方重新锚定，绝不把这个问题留给用户的下一次滚动。
        const sizeChanged = officialMenuSizeChanged()
        if (mutatedThisPass || sizeChanged) reanchorOfficialMenu(sizeChanged)
      }

      const menuVisible = official.menuFound || menu !== null
      reportDiagnostics({
        at: Date.now(),
        href: window.location.href.slice(0, 120),
        tokens: ensureTokenIndex().size,
        providerCount: directory?.providers?.length ?? 0,
        modelCount: (directory?.providers ?? []).reduce((sum, p) => sum + p.models.length, 0),
        directoryError,
        official: lastOfficialStats,
        legacyWired,
        generic: lastGenericStats,
        menuDump: dumpMenu(),
        barCount: document.querySelectorAll('.dmd-allbar').length,
        actionCount: document.querySelectorAll('.dmd-actions').length,
      }, menuVisible)
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
