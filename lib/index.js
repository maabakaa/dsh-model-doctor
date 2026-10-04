/**
 * dsh-model-doctor — Host half.
 *
 * 为对话输入区模型选择菜单提供三项能力的回环 RPC 通道（挂在前缀路由上，与
 * dsh-reasoning-effort 同一套信封协议）：
 *
 *   directory    权威模型目录（llm 服务），客户端用它把 DOM 行映射回 provider/model
 *   check        对单个模型直连网关发一次 1-token 探测，回报连通性/欠费/限流/鉴权
 *   checkAll     并发探测全部已配置模型的连通状况（附带 siliconflow 余额）
 *   deleteModel  从 llm-pi-ai 用户配置里移除一个模型（写前自动备份配置文档）
 *
 * 本半永不记录密钥内容；密钥仅按次从凭据 refs（.credentials.yaml）或进程环境解析，
 * 只在内存中拼进 Authorization 头。
 *
 * @module dsh-model-doctor
 */

import { copyFileSync, readdirSync, unlinkSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-model-doctor'

/**
 * 硬依赖：settings（读/写 llm-pi-ai 配置）与 llm（权威模型目录）。
 * connection/webServer 仅 Web profile 存在，通道经 ctx.inject 挂载，不进这里。
 */
export const inject = ['settings', 'llm']

/** 承载各供应商网关路由的 DSH 配置命名空间。 */
const LLM_NS = 'llm-pi-ai'
/** 与浏览器半共享的回环 RPC 前缀路由（保留：信封协议通道）。 */
const RPC_CHANNEL = '/dsh-model-doctor'
/**
 * /api 共享通道下的路由基路径。这是桌面端浏览器半实测可达的机制
 * （同 dsh-memory-board：宿主 ctx.connection.fetch.register + 客户端裸 fetch）。
 */
const API_BASE = '/api/model-doctor'
/** 单模型探测超时。 */
const PING_TIMEOUT_MS = 15000
/** checkAll 并发上限。 */
const CHECK_ALL_CONCURRENCY = 4
/** 配置文档备份保留份数。 */
const BACKUP_KEEP = 5

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function okResult(value) {
  return { ok: true, value }
}

function failResult(code, message) {
  // `details` 是连接信封的一部分：浏览器半会拒绝 details 非对象的失败结果。
  return { ok: false, error: { code, message, details: {} } }
}

/** 深拷贝（结构化克隆语义的朴素实现，配置对象都是 plain JSON）。 */
function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/* ------------------------------------------------------------------ */
/* 凭据解析：.credentials.yaml refs 段 + 进程环境                       */
/* ------------------------------------------------------------------ */

let refsCache = null
let refsCacheAt = 0

/** 解析 refs 段（扁平 KEY: value），缓存 60 秒；只缓存在本进程内存里。 */
function credentialRefs() {
  if (refsCache !== null && Date.now() - refsCacheAt < 60000) return refsCache
  refsCache = {}
  refsCacheAt = Date.now()
  try {
    const base = process.env.DSH_HOME || join(homedir(), '.dsh')
    const text = readFileSync(join(base, '.credentials.yaml'), 'utf8')
    const start = text.search(/^refs:\s*$/m)
    if (start < 0) return refsCache
    const lines = text.slice(start).split(/\r?\n/)
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (line.trim().length === 0) continue
      if (!/^\s/.test(line)) break
      const m = /^ {2}([A-Za-z0-9_]+):(?:\s+(.*))?$/u.exec(line)
      if (m && m[2] !== undefined) {
        refsCache[m[1]] = m[2].trim().replace(/^['"]|['"]$/gu, '')
      }
    }
  } catch {
    // 读不到凭据文件时按空表处理，由调用方报「缺少凭据」。
  }
  return refsCache
}

function resolveApiKey(envName) {
  if (typeof envName !== 'string' || envName.length === 0) return undefined
  const refs = credentialRefs()
  if (Object.prototype.hasOwnProperty.call(refs, envName) && refs[envName].length > 0) {
    return refs[envName]
  }
  return process.env[envName]
}

/* ------------------------------------------------------------------ */
/* llm-pi-ai 配置读取                                                  */
/* ------------------------------------------------------------------ */

function describeRows(settings) {
  try {
    const rows = settings.describe()
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

function llmDescriptor(settings) {
  return describeRows(settings).find((row) => isRecord(row) && row.ns === LLM_NS) ?? null
}

/** 合并视图里的 providers 路由表（内置目录 + 用户覆盖）。 */
function mergedProviders(settings) {
  const value = llmDescriptor(settings)?.value
  return isRecord(value) && isRecord(value.providers) ? value.providers : {}
}

/**
 * 官方内置供应商的兜底路由：它们不出现在 llm-pi-ai 配置里（DeepSeek 官方账号走
 * 平台适配器），但同样可以直连探测——密钥按 refs / 进程环境解析。
 */
const BUILTIN_ROUTES = [
  {
    match: /deepseek/i,
    route: { baseURL: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', displayName: 'DeepSeek（官方）' },
  },
]

/** 解析一个 provider 的网关路由：llm-pi-ai 配置优先，其次官方内置兜底。 */
function routeFor(settings, providerId) {
  const configured = mergedProviders(settings)[providerId]
  if (isRecord(configured)) return configured
  for (const entry of BUILTIN_ROUTES) {
    if (entry.match.test(String(providerId))) return entry.route
  }
  return undefined
}

/** 用户层（patch 文档）里的 llm-pi-ai 配置。 */
function userConfig(settings) {
  const user = llmDescriptor(settings)?.user
  return isRecord(user) ? user : {}
}

function modelArrayOf(route) {
  if (!isRecord(route) || !Array.isArray(route.models)) return []
  return route.models
}

function modelIdOf(entry) {
  return isRecord(entry) ? entry.id : entry
}

/* ------------------------------------------------------------------ */
/* 连通探测                                                            */
/* ------------------------------------------------------------------ */

function classifyStatus(status) {
  if (status === 401 || status === 402 || status === 403) return 'auth'
  if (status === 429) return 'quota'
  if (status === 404) return 'notfound'
  if (status >= 500) return 'server'
  return 'badrequest'
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function extractMessage(parsed, text) {
  if (isRecord(parsed)) {
    const error = parsed.error
    if (typeof error === 'string') return error
    if (isRecord(error)) {
      const code = typeof error.code === 'string' || typeof error.code === 'number' ? ` [${error.code}]` : ''
      if (typeof error.message === 'string' && error.message.length > 0) return `${error.message}${code}`
    }
    if (typeof parsed.message === 'string' && parsed.message.length > 0) return parsed.message
  }
  return (text ?? '').slice(0, 200)
}

/**
 * 直连网关发一次最小 chat 请求。200 = 连通；4xx/5xx 的状态码与报文能直接
 * 区分欠费（403/额度类）、限流（429）、鉴权失败（401）、模型不存在（404）。
 */
async function pingModel(route, model) {
  const started = Date.now()
  const base = (typeof route?.baseURL === 'string' ? route.baseURL : '').replace(/\/+$/u, '')
  if (base.length === 0) {
    return { ok: false, status: 0, kind: 'config', message: '该供应商未配置 baseURL，无法探测', ms: 0 }
  }
  const keyName = typeof route?.apiKeyEnv === 'string' ? route.apiKeyEnv : ''
  const key = resolveApiKey(keyName)
  if (key === undefined) {
    return { ok: false, status: 0, kind: 'auth', message: `缺少凭据 ${keyName || '(未声明 apiKeyEnv)'}`, ms: 0 }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), PING_TIMEOUT_MS)
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: controller.signal,
    })
    const ms = Date.now() - started
    const text = await response.text().catch(() => '')
    if (response.ok) {
      return { ok: true, status: response.status, kind: 'ok', message: '', ms }
    }
    return {
      ok: false,
      status: response.status,
      kind: classifyStatus(response.status),
      message: extractMessage(safeJson(text), text).slice(0, 300),
      ms,
    }
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    return {
      ok: false,
      status: 0,
      kind: 'network',
      message: aborted ? `超时（>${Math.round(PING_TIMEOUT_MS / 1000)}s 无响应）` : String(error?.message ?? error).slice(0, 300),
      ms: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 探测账户余额：siliconflow 走 /v1/user/info，DeepSeek 官方走 /user/balance；
 * 其余供应商没有公开余额端点，跳过（返回 undefined）。
 */
async function probeBalance(route, providerId) {
  try {
    const base = (typeof route?.baseURL === 'string' ? route.baseURL : '').replace(/\/+$/u, '')
    if (base.length === 0) return undefined
    const deepseek = /deepseek/i.test(base) || /deepseek/i.test(String(providerId ?? ''))
    if (!deepseek && !/siliconflow/i.test(base)) return undefined
    const key = resolveApiKey(typeof route?.apiKeyEnv === 'string' ? route.apiKeyEnv : '')
    if (key === undefined) return undefined
    const root = base.replace(/\/v1$/u, '')
    const target = deepseek ? `${root}/user/balance` : `${root}/v1/user/info`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      const response = await fetch(target, {
        headers: { authorization: `Bearer ${key}` },
        signal: controller.signal,
      })
      if (!response.ok) return undefined
      const parsed = safeJson(await response.text().catch(() => ''))
      const balance = deepseek
        ? parsed?.balance_infos?.[0]?.total_balance
        : (parsed?.data?.balance ?? parsed?.balance)
      return typeof balance === 'string' || typeof balance === 'number' ? String(balance) : undefined
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ */
/* 上一次检测结果（跨菜单开关与软件重启保留，覆盖写=只留最近一次）        */
/* ------------------------------------------------------------------ */

/** 结果快照文件：DSH_HOME 下（默认 ~/.dsh），单文件覆盖写。 */
function resultsFile() {
  const base = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(base, 'model-doctor-results.json')
}

async function readStoredResults() {
  try {
    const parsed = JSON.parse(await readFile(resultsFile(), 'utf8'))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function writeStoredResults(snapshot) {
  try {
    const file = resultsFile()
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(snapshot), 'utf8')
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* 权威模型目录                                                        */
/* ------------------------------------------------------------------ */

async function directoryOf(llm) {
  if (llm === undefined || typeof llm.listProviders !== 'function') {
    return { providers: [] }
  }
  // 注意：listProviders() 同步返回数组（见 llm 服务契约），不能对它挂 .catch。
  let infos = []
  try {
    infos = await llm.listProviders()
  } catch {
    infos = []
  }
  const providers = []
  for (const info of Array.isArray(infos) ? infos : []) {
    if (!isRecord(info) || typeof info.id !== 'string') continue
    let models = []
    try {
      models = await llm.listModels(info.id)
    } catch {
      models = []
    }
    providers.push({
      id: info.id,
      name: typeof info.name === 'string' && info.name.length > 0 ? info.name : info.id,
      models: (Array.isArray(models) ? models : [])
        .filter((m) => isRecord(m) && typeof m.id === 'string')
        .map((m) => ({ id: m.id, name: typeof m.name === 'string' && m.name.length > 0 ? m.name : m.id })),
    })
  }
  return { providers }
}

/* ------------------------------------------------------------------ */
/* 删除模型（写用户层配置，写前备份配置文档）                            */
/* ------------------------------------------------------------------ */

async function backupDocument(settings) {
  try {
    const doc = await settings.prepareDocument()
    if (typeof doc !== 'string' || doc.length === 0) return null
    const stamp = new Date().toISOString().replace(/[-:T]/gu, '').slice(0, 14)
    const target = `${doc}.dsh-model-doctor-${stamp}.bak`
    copyFileSync(doc, target)
    try {
      const dir = dirname(doc)
      const head = `${basename(doc)}.dsh-model-doctor-`
      const olds = readdirSync(dir)
        .filter((name) => name.startsWith(head) && name.endsWith('.bak'))
        .sort()
      while (olds.length > BACKUP_KEEP) unlinkSync(join(dir, olds.shift()))
    } catch {
      // 清理旧备份失败不影响本次删除。
    }
    return target
  } catch {
    return null
  }
}

/**
 * 从配置中移除一个模型：
 *  - 用户层声明了它 → 原位删除（最后一个模型则连供应商路由一起移除）；
 *  - 只存在于内置目录 → 用合并视图减去该模型后固化为用户覆盖；
 *  - 两边都找不到 → 返回 not-found（无法管理内置深层目录）。
 */
async function deleteModel(settings, provider, model) {
  const descriptor = llmDescriptor(settings)
  if (descriptor === null) {
    return { ok: false, code: 'no-config', message: '当前配置没有 llm-pi-ai 命名空间，无从删除' }
  }
  const user = deepClone(userConfig(settings))
  const merged = isRecord(descriptor.value) ? descriptor.value : {}
  if (!isRecord(user.providers)) user.providers = {}

  const userRoute = isRecord(user.providers[provider]) ? user.providers[provider] : undefined
  const mergedRoute = isRecord(merged.providers?.[provider]) ? merged.providers[provider] : undefined
  const inUser = userRoute !== undefined && modelArrayOf(userRoute).some((m) => modelIdOf(m) === model)
  const inMerged = mergedRoute !== undefined && modelArrayOf(mergedRoute).some((m) => modelIdOf(m) === model)

  if (!inUser && !inMerged) {
    return {
      ok: false,
      code: 'not-found',
      message: `模型 ${model} 不在 llm-pi-ai 的 ${provider} 配置里（可能来自内置目录），无法删除`,
    }
  }

  const backup = await backupDocument(settings)

  if (inUser) {
    const rest = modelArrayOf(userRoute).filter((m) => modelIdOf(m) !== model)
    if (rest.length === 0) {
      // 显式声明的路由不允许空 models：删到只剩零个时整条路由一起移除。
      delete user.providers[provider]
    } else {
      userRoute.models = rest
    }
  } else if (mergedRoute !== undefined) {
    const route = deepClone(mergedRoute)
    route.models = modelArrayOf(route).filter((m) => modelIdOf(m) !== model)
    if (route.models.length === 0) {
      return { ok: false, code: 'last-model', message: '该模型是内置目录中此供应商的最后一个，不支持删除' }
    }
    user.providers[provider] = route
  }

  try {
    await settings.replace(LLM_NS, user)
  } catch (error) {
    return {
      ok: false,
      code: 'write-failed',
      message: `写入配置失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return { ok: true, provider, model, backup }
}

/* ------------------------------------------------------------------ */
/* 回环 RPC 通道（信封协议与 dsh-reasoning-effort 完全一致）             */
/* ------------------------------------------------------------------ */

const MAX_REQUEST_BYTES = 64 * 1024

function parseEnvelope(value) {
  if (!isRecord(value) || value.type !== 'client-request') return undefined
  if (typeof value.rpcId !== 'string' || value.rpcId.length === 0) return undefined
  if (typeof value.method !== 'string' || value.method.length === 0) return undefined
  return { rpcId: value.rpcId, method: value.method, payload: value.payload }
}

function envelopeOf(rpcId, result) {
  return JSON.stringify({ type: 'server-response', rpcId, result })
}

function endpointOf(url) {
  if (typeof url !== 'string') return undefined
  const pathname = url.split('?')[0] ?? ''
  const prefix = `${RPC_CHANNEL}/`
  if (!pathname.startsWith(prefix)) return undefined
  const endpoint = pathname.slice(prefix.length)
  return /^[A-Za-z0-9_$.-]+$/u.test(endpoint) ? endpoint : undefined
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const decoder = new TextDecoder()
    let bytes = 0
    request.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_REQUEST_BYTES) {
        reject(new Error('body too large'))
        return
      }
      chunks.push(decoder.decode(chunk, { stream: true }))
    })
    request.on('end', () => {
      try {
        chunks.push(decoder.decode())
        resolve(JSON.parse(chunks.join('')))
      } catch (error) {
        reject(error instanceof Error ? error : new Error('body is not JSON'))
      }
    })
    request.on('error', (error) => {
      reject(error instanceof Error ? error : new Error('request stream failed'))
    })
  })
}

/* ------------------------------------------------------------------ */
/* apply                                                               */
/* ------------------------------------------------------------------ */

export function apply(ctx) {
  const settings = ctx.get('settings')
  if (settings === undefined || typeof settings.describe !== 'function') return
  const llm = ctx.get('llm')

  /** 并发探测菜单里出现的全部模型（权威目录 ∪ 已配置路由）。 */
  async function checkAll() {
    const providers = mergedProviders(settings)
    const tasks = []
    const seen = new Set()
    const push = (providerId, model) => {
      if (typeof providerId !== 'string' || typeof model !== 'string') return
      if (providerId.length === 0 || model.length === 0) return
      const key = `${providerId}::${model}`
      if (seen.has(key)) return
      seen.add(key)
      tasks.push({ provider: providerId, model })
    }
    try {
      const listed = await directoryOf(llm)
      for (const provider of listed.providers) {
        for (const model of provider.models) push(provider.id, model.id)
      }
    } catch {
      // 目录拿不到时退化为只探测配置里声明的模型。
    }
    for (const [providerId, route] of Object.entries(providers)) {
      for (const entry of modelArrayOf(route)) push(providerId, modelIdOf(entry))
    }
    const results = {}
    let index = 0
    const worker = async () => {
      while (index < tasks.length) {
        const task = tasks[index]
        index += 1
        const route = routeFor(settings, task.provider)
        results[`${task.provider}::${task.model}`] = isRecord(route)
          ? await pingModel(route, task.model)
          : { ok: false, status: 0, kind: 'unsupported', message: '该供应商没有可直连的网关路由，无法探测', ms: 0 }
      }
    }
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(CHECK_ALL_CONCURRENCY, tasks.length)) }, worker),
    )
    const balances = {}
    const providerIds = new Set([...Object.keys(providers), ...tasks.map((task) => task.provider)])
    for (const providerId of providerIds) {
      const route = routeFor(settings, providerId)
      if (!isRecord(route)) continue
      const balance = await probeBalance(route, providerId)
      if (balance !== undefined) balances[providerId] = balance
    }
    return { results, balances }
  }

  async function answer(endpoint, payload) {
    const request = isRecord(payload) ? payload : {}
    switch (endpoint) {
      case 'directory': {
        try {
          return okResult(await directoryOf(llm))
        } catch (error) {
          return failResult('directory-failed', `目录获取失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      case 'check': {
        const provider = typeof request.provider === 'string' ? request.provider : ''
        const model = typeof request.model === 'string' ? request.model : ''
        if (provider.length === 0 || model.length === 0) {
          return failResult('invalid-request', 'provider 和 model 必填')
        }
        const route = routeFor(settings, provider)
        if (!isRecord(route)) {
          return okResult({ ok: false, status: 0, kind: 'unsupported', message: '该供应商没有可直连的网关路由，无法探测', ms: 0 })
        }
        try {
          return okResult(await pingModel(route, model))
        } catch (error) {
          return failResult('check-failed', `探测失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      case 'checkAll': {
        try {
          return okResult(await checkAll())
        } catch (error) {
          return failResult('check-all-failed', `批量探测失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      case 'deleteModel': {
        const provider = typeof request.provider === 'string' ? request.provider : ''
        const model = typeof request.model === 'string' ? request.model : ''
        if (provider.length === 0 || model.length === 0) {
          return failResult('invalid-request', 'provider 和 model 必填')
        }
        return okResult(await deleteModel(settings, provider, model))
      }
      case 'resultsLoad': {
        return okResult(await readStoredResults())
      }
      case 'resultsSave': {
        if (!isRecord(request.results)) {
          return failResult('invalid-request', 'results 必须是对象')
        }
        const snapshot = {
          results: request.results,
          balances: isRecord(request.balances) ? request.balances : {},
          at: typeof request.at === 'number' && Number.isFinite(request.at) ? request.at : Date.now(),
        }
        const saved = await writeStoredResults(snapshot)
        return okResult({ ok: saved, at: snapshot.at })
      }
      default:
        return failResult('not-found', `未知端点 ${JSON.stringify(endpoint)}`)
    }
  }

  // ── 主通道：/api 下的显式路由（桌面端浏览器半走这条；逐条注册，不靠 pathname 分派）
  ctx.inject(['connection'], (routeCtx) => {
    const connection = routeCtx.get('connection')
    const fetchRegistry = connection?.fetch
    if (fetchRegistry === undefined || typeof fetchRegistry.register !== 'function') return
    routeCtx.effect(() => {
      const disposers = []
      for (const endpoint of ['directory', 'check', 'checkAll', 'deleteModel', 'resultsLoad', 'resultsSave']) {
        try {
          disposers.push(fetchRegistry.register({
            path: `${API_BASE}/${endpoint}`,
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: async (request) => {
              let payload = {}
              try {
                payload = await request.json()
              } catch {
                payload = {}
              }
              let result
              try {
                result = await answer(endpoint, isRecord(payload) ? payload : {})
              } catch (error) {
                result = failResult(
                  'channel-failed',
                  `通道处理失败：${error instanceof Error ? error.message : String(error)}`,
                )
              }
              return new Response(JSON.stringify(result), {
                status: 200,
                headers: {
                  'content-type': 'application/json; charset=utf-8',
                  'cache-control': 'no-store',
                },
              })
            },
          }))
        } catch (error) {
          console.error(
            `[dsh-model-doctor] /api 路由注册失败 ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose?.()
          } catch {
            // 注销失败不影响其余路由。
          }
        }
      }
    }, 'model-doctor: /api routes')
  })

  // ── 备用通道：自建前缀路由 + client-request 信封（保留，不影响主通道）
  ctx.inject(['connection', 'webServer'], (routeCtx) => {
    const connection = routeCtx.get('connection')
    const webServer = routeCtx.get('webServer')
    if (connection === undefined || webServer === undefined || typeof webServer.register !== 'function') return
    routeCtx.effect(() => webServer.register({
      kind: 'prefix',
      path: RPC_CHANNEL,
      handler: async (request, response) => {
        const rejection = connection.requestRejection(request)
        if (rejection !== undefined) {
          response.writeHead(rejection)
          response.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        const endpoint = endpointOf(request.url)
        if (request.method !== 'POST' || endpoint === undefined) {
          response.writeHead(404)
          response.end('not found')
          return
        }
        const mediaType = String(request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
        if (mediaType !== 'application/json') {
          response.writeHead(415)
          response.end('content type must be application/json')
          return
        }
        let body
        try {
          body = await readJsonBody(request)
        } catch {
          response.writeHead(400)
          response.end('body is not JSON')
          return
        }
        const message = parseEnvelope(body)
        if (message === undefined || message.method !== endpoint) {
          response.writeHead(400)
          response.end('invalid client-request message')
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        try {
          response.end(envelopeOf(message.rpcId, await answer(endpoint, message.payload)))
        } catch (error) {
          response.end(envelopeOf(message.rpcId, failResult(
            'channel-failed',
            `通道处理失败：${error instanceof Error ? error.message : String(error)}`,
          )))
        }
      },
    }), 'model-doctor: rpc channel')
  })
}
