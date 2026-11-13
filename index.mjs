const ID = "aiproxy"
const DEFAULT_BASE_URL = "https://api.violinai.qzz.io"
const ICON_URL = "https://api.violinai.qzz.io/brand/favicon.png"
const MODEL_NPM = "@ai-sdk/openai-compatible"
const TIMEOUT_MS = 20_000

const record = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {})
const text = (value) => (typeof value === "string" ? value.trim() : "")
const number = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
const finitePositive = (value) => {
  const parsed = number(value)
  return parsed !== null && parsed >= 0 ? parsed : null
}

function metadataOf(auth) {
  return record(auth?.metadata)
}

function apiKeyOf(auth) {
  if (auth?.type === "api") return text(auth.key)
  return text(auth?.access)
}

function baseURLOf(auth) {
  const base = text(metadataOf(auth).baseURL || auth?.baseURL || DEFAULT_BASE_URL)
  return base.replace(/\/+$/, "").replace(/\/v1$/i, "")
}

function modelURLOf(auth) {
  return `${baseURLOf(auth)}/v1`
}

function consoleURLOf(auth) {
  return `${baseURLOf(auth)}/api/v1`
}

function cookieOf(auth) {
  return text(metadataOf(auth).cookies || auth?.cookies)
}

function credentialsOf(auth) {
  const metadata = metadataOf(auth)
  return {
    email: text(metadata.email || auth?.email),
    password: text(metadata.password || auth?.password),
  }
}

function safeError(error, fallback = "AiProxy 请求失败") {
  const status = Number(error?.status)
  if (status === 401 || status === 403) return "AiProxy 登录会话已过期，请重新登录"
  if (status === 404) return "AiProxy 未找到额度接口，请检查服务版本"
  if (status === 429) return "AiProxy 请求过于频繁，请稍后重试"
  if (error?.code === "timeout" || /timeout|timed out/i.test(String(error?.message ?? ""))) {
    return "AiProxy 请求超时"
  }
  return fallback
}

function splitSetCookie(value) {
  if (!value) return []
  return String(value).split(/,(?=[^;,=\s]+=[^;,]*)/g).map((part) => part.trim()).filter(Boolean)
}

function cookiePairs(cookieHeader) {
  const out = new Map()
  for (const part of String(cookieHeader ?? "").split(";")) {
    const index = part.indexOf("=")
    if (index <= 0) continue
    out.set(part.slice(0, index).trim(), part.slice(index + 1).trim())
  }
  return out
}

function mergeCookies(previous, response) {
  const out = cookiePairs(previous)
  const lines = typeof response?.headers?.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : splitSetCookie(response?.headers?.get("set-cookie"))
  for (const line of lines) {
    const first = line.split(";")[0]
    const index = first.indexOf("=")
    if (index <= 0) continue
    const name = first.slice(0, index).trim()
    const value = first.slice(index + 1).trim()
    if (!value || /(?:^|;)\s*max-age=0(?:;|$)/i.test(line)) out.delete(name)
    else out.set(name, value)
  }
  return [...out].map(([name, value]) => `${name}=${value}`).join("; ")
}

async function responseJSON(response) {
  let body
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`)
    error.status = response.status
    error.body = body
    throw error
  }
  return body
}

async function requestJSON(fetchImpl, url, init = {}) {
  let response
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init.headers ?? {}),
      },
      signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    })
  } catch (error) {
    const wrapped = new Error("network")
    wrapped.code = error?.name === "TimeoutError" ? "timeout" : "network"
    wrapped.cause = error
    throw wrapped
  }
  return responseJSON(response)
}

function dataOf(body) {
  const value = record(body)
  return value.data && typeof value.data === "object" && !Array.isArray(value.data)
    ? value.data
    : value
}

function dateOf(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value
    return new Date(milliseconds).toISOString()
  }
  if (typeof value === "string" && value.trim()) {
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined
  }
  return undefined
}

function unitOf(metric, windowName) {
  if (windowName === "budget" || metric === "cost_usd") return "USD"
  if (["total_tokens", "input_tokens", "output_tokens"].includes(metric)) return "tokens"
  if (metric === "requests") return "requests"
  return "quota"
}

function metricLabel(metric) {
  if (metric === "cost_usd") return "费用"
  if (metric === "requests") return "请求数"
  if (metric === "total_tokens") return "总 Token"
  if (metric === "input_tokens") return "输入 Token"
  if (metric === "output_tokens") return "输出 Token"
  return "平台额度"
}

function windowLabel(name) {
  return { window: "周期", daily: "每日", weekly: "每周", budget: "预算" }[name] ?? name
}

function windowSpan(name, plan) {
  if (name === "window") {
    const hours = finitePositive(record(plan?.quota_limits).window_hours)
    if (hours !== null) return hours * 3600
  }
  if (name === "daily") return 86400
  if (name === "weekly") return 7 * 86400
  if (name === "budget") return 30 * 86400
  return undefined
}

const windowAliases = {
  window: ["window", "rolling", "five_hour", "fiveHour"],
  daily: ["daily", "day"],
  weekly: ["weekly", "week", "7d", "seven_day", "sevenDay"],
  budget: ["budget", "monthly", "month"],
}

function windowPart(source, name, suffix) {
  const input = record(source)
  for (const alias of windowAliases[name] ?? [name]) {
    const nested = record(input[alias])
    if (nested[suffix] !== undefined) return nested[suffix]
    const camel = `${suffix}${alias[0].toUpperCase()}${alias.slice(1)}`
    if (nested[camel] !== undefined) return nested[camel]
    for (const key of [`${alias}_${suffix}`, `${alias}${suffix[0].toUpperCase()}${suffix.slice(1)}`]) {
      if (input[key] !== undefined) return input[key]
    }
  }
  for (const alias of windowAliases[name] ?? [name]) {
    for (const key of [`${alias}_${suffix}`, `${alias}${suffix[0].toUpperCase()}${suffix.slice(1)}`]) {
      if (input[key] !== undefined) return input[key]
    }
  }
  return undefined
}

function windowReset(source, name) {
  return windowPart(source, name, "reset_at")
    ?? windowPart(source, name, "resetAt")
    ?? windowPart(source, name, "resets_at")
    ?? windowPart(source, name, "resetsAt")
}

function quotaWindows(source, prefix, plan, scope = "group") {
  const input = record(source)
  const metric = text(input.metric)
  const windows = []
  for (const name of ["window", "daily", "weekly", "budget"]) {
    const limit = finitePositive(windowPart(input, name, "limit"))
    const used = finitePositive(windowPart(input, name, "used"))
    const remaining = finitePositive(windowPart(input, name, "remaining"))
    const usedPercent = finitePositive(windowPart(input, name, "used_percent"))
    if ((limit ?? 0) <= 0 && (used ?? 0) <= 0 && (remaining ?? 0) <= 0 && usedPercent === null) continue
    const effectiveLimit = limit ?? (used !== null && remaining !== null ? used + remaining : null)
    const effectiveUsed = used ?? (effectiveLimit !== null && remaining !== null ? effectiveLimit - remaining : null)
    const row = {
      name: `${prefix} · ${windowLabel(name)}`,
      window: name,
      scope,
      unit: unitOf(metric, name),
      ...(effectiveLimit !== null ? { limit: effectiveLimit } : {}),
      ...(effectiveUsed !== null ? { amount: effectiveUsed, used: effectiveLimit ? (effectiveUsed / effectiveLimit) * 100 : undefined } : {}),
      ...(effectiveUsed === null && usedPercent !== null ? { used: usedPercent } : {}),
      ...(remaining !== null ? { display: `${remaining} / ${effectiveLimit ?? "?"} ${unitOf(metric, name)}` } : {}),
      ...(windowSpan(name, plan) ? { span: windowSpan(name, plan) } : {}),
      ...(metric ? { aside: false } : {}),
    }
    if (effectiveUsed === null && effectiveLimit === null && remaining === null) continue
    windows.push(row)
  }
  return windows
}

function parseEntitlements(body) {
  const data = dataOf(body)
  const plans = Array.isArray(data.plans) ? data.plans : []
  const windows = []
  const errors = []
  const planNames = []
  let until

  for (const entry of plans) {
    const plan = record(entry?.plan)
    const remaining = record(entry?.remaining)
    const resets = record(entry?.resets)
    const name = text(plan.name) || "AiProxy 套餐"
    planNames.push(name)
    until ??= dateOf(plan.current_period_end || plan.expires_at || entry?.expires_at)
    const metrics = Array.isArray(remaining.metrics) && remaining.metrics.length ? remaining.metrics : [remaining]
    const seen = new Set()
    for (const metric of metrics) {
      const metricObject = record(metric)
      const metricName = text(metricObject.metric)
      if (seen.has(metricName)) continue
      seen.add(metricName)
      const parsed = quotaWindows(metricObject, `${name}${metricName ? ` · ${metricLabel(metricName)}` : ""}`, plan)
      for (const row of parsed) {
        const reset = dateOf(windowReset(metricObject, row.window) || resets[row.window])
        if (reset) row.resetsAt = reset
        if (metricName) row.display = row.display ? `${row.display} · ${metricLabel(metricName)}` : metricLabel(metricName)
      }
      windows.push(...parsed)
    }
    if (remaining.error) errors.push(`${name}：额度暂不可用`)
    if (plan.active === false) errors.push(`${name}：套餐已停用`)
  }
  return {
    plan: planNames.join(" + ") || "AiProxy",
    ...(until ? { until } : {}),
    windows,
    ...(errors.length ? { error: errors.join("; ") } : {}),
  }
}

function parseLegacyQuotas(body) {
  const data = dataOf(body)
  const quotas = Array.isArray(data.quotas) ? data.quotas : Array.isArray(body) ? body : []
  const windows = []
  for (const quota of quotas) {
    const item = record(quota)
    const plan = record(item.plan)
    const remaining = record(item.remaining)
    const name = text(plan.name) || text(item.credential?.name) || "AiProxy Key"
    windows.push(...quotaWindows(remaining, name, plan, "key"))
    windows.push(...quotaWindows(record(item.credential_remaining), `${name} · Key`, plan, "key"))
    windows.push(...quotaWindows(record(item.source), `${name} · 共享来源`, plan, "group"))
  }
  return { plan: "AiProxy", windows }
}

async function loginWithResponse(fetchImpl, auth) {
  const credentials = credentialsOf(auth)
  if (!credentials.email || !credentials.password) {
    const error = new Error("AiProxy 额度读取需要控制台邮箱和密码")
    error.code = "missing_credentials"
    throw error
  }
  let response
  try {
    response = await fetchImpl(`${consoleURLOf(auth)}/auth/login`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(credentials),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    })
  } catch (error) {
    const wrapped = new Error("network")
    wrapped.code = "network"
    wrapped.cause = error
    throw wrapped
  }
  const body = await responseJSON(response)
  return { body, cookies: mergeCookies(cookieOf(auth), response) }
}

async function readSession(fetchImpl, auth) {
  let current = { ...auth, metadata: { ...metadataOf(auth) } }
  if (!cookieOf(current)) {
    const loggedIn = await loginWithResponse(fetchImpl, current)
    current.metadata.cookies = loggedIn.cookies
    if (!current.metadata.cookies) {
      const error = new Error("AiProxy 登录未返回会话 Cookie")
      error.code = "missing_cookie"
      throw error
    }
    return current
  }
  return current
}

async function authenticatedJSON(fetchImpl, auth, path) {
  const cookies = cookieOf(auth)
  return requestJSON(fetchImpl, `${consoleURLOf(auth)}${path}`, {
    headers: { cookie: cookies },
  })
}

function balanceText(value) {
  const amount = number(value)
  return amount === null ? undefined : `$${amount.toFixed(2)}`
}

function modelRow(provider, model, baseURL) {
  const id = text(model?.id || model)
  if (!id) return null
  return {
    id,
    providerID: provider.id,
    name: text(model?.name) || id,
    api: { id, url: baseURL, npm: MODEL_NPM },
    status: "active",
    headers: {},
    options: {},
    reasoning: Boolean(model?.reasoning),
    tool_call: true,
    limit: {
      context: Math.max(0, Math.trunc(number(model?.context_length || model?.context_window) ?? 0)),
      output: Math.max(0, Math.trunc(number(model?.max_output_tokens) ?? 0)),
    },
    capabilities: {
      temperature: true,
      reasoning: Boolean(model?.reasoning),
      attachment: false,
      toolcall: true,
      input: { text: true, image: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    variants: {},
    free: false,
  }
}

function createPlugin({ fetchImpl = globalThis.fetch, client = {} } = {}) {
  async function persistSession(auth) {
    if (typeof client?.auth?.set !== "function") return
    const current = metadataOf(auth)
    await client.auth.set({
      path: { id: ID },
      body: {
        type: "api",
        key: apiKeyOf(auth),
        metadata: { ...current },
      },
    }).catch(() => {})
  }

  async function usage(getAuth) {
    let auth
    try {
      auth = await getAuth()
    } catch {
      return { plan: "AiProxy", windows: [], error: "AiProxy 登录状态不可读", signIn: "kept" }
    }
    if (!auth || auth.type !== "api" || !apiKeyOf(auth)) return {}

    let session
    try {
      session = await readSession(fetchImpl, auth)
      if (cookieOf(session) !== cookieOf(auth)) await persistSession(session)
    } catch (error) {
      return { plan: "AiProxy", windows: [], error: safeError(error, error?.code === "missing_credentials" ? "AiProxy 额度读取需要控制台邮箱和密码" : "AiProxy 登录失败"), signIn: "kept" }
    }

    let me
    try {
      me = await authenticatedJSON(fetchImpl, session, "/user/me")
    } catch (error) {
      if (Number(error?.status) === 401 || Number(error?.status) === 403) {
        try {
          session.metadata.cookies = (await loginWithResponse(fetchImpl, session)).cookies
          await persistSession(session)
          me = await authenticatedJSON(fetchImpl, session, "/user/me")
        } catch (retryError) {
          return { plan: "AiProxy", windows: [], error: safeError(retryError, "AiProxy 登录会话已过期，请重新登录"), signIn: "kept" }
        }
      } else {
        return { plan: "AiProxy", windows: [], error: safeError(error), signIn: "kept" }
      }
    }

    const account = dataOf(me)
    const result = {
      plan: "AiProxy",
      ...(text(account.name || account.display_name || account.email) ? { user: text(account.name || account.display_name || account.email) } : {}),
      ...(balanceText(account.balance_usd) ? { balance: balanceText(account.balance_usd) } : {}),
      windows: [],
      signIn: "kept",
    }

    let entitlementError
    try {
      const entitlements = await authenticatedJSON(fetchImpl, session, "/user/entitlements")
      Object.assign(result, parseEntitlements(entitlements))
    } catch (error) {
      entitlementError = error
      if (Number(error?.status) === 404) {
        try {
          const quotas = await authenticatedJSON(fetchImpl, session, "/user/quotas")
          Object.assign(result, parseLegacyQuotas(quotas))
          entitlementError = undefined
        } catch (legacyError) {
          entitlementError = legacyError
        }
      }
    }
    if (entitlementError) {
      result.error = safeError(entitlementError, "AiProxy 套餐额度读取失败")
    }
    return result
  }

  return {
    auth: {
      provider: ID,
      icon: ICON_URL,
      maxConcurrency: 8,
      usage,
      loader: async (getAuth) => {
        const auth = await getAuth()
        const key = apiKeyOf(auth)
        if (!key) return {}
        return { baseURL: modelURLOf(auth), apiKey: key }
      },
      methods: [
        {
          type: "api",
          label: "AiProxy API key + console login",
          prompts: [
            {
              type: "text",
              key: "baseURL",
              message: "AiProxy base URL",
              placeholder: DEFAULT_BASE_URL,
              validate: (value) => {
                try {
                  const url = new URL(text(value) || DEFAULT_BASE_URL)
                  if (!["http:", "https:"].includes(url.protocol)) return "请输入 http(s) 地址"
                  return undefined
                } catch {
                  return "请输入有效的 AiProxy 地址"
                }
              },
            },
            {
              type: "password",
              key: "apiKey",
              message: "AiProxy API key（模型请求用）",
              validate: (value) => (text(value) ? undefined : "API key 不能为空"),
            },
            {
              type: "text",
              key: "email",
              message: "AiProxy 控制台邮箱（读取额度用）",
              validate: (value) => (text(value) ? undefined : "邮箱不能为空"),
            },
            {
              type: "password",
              key: "password",
              message: "AiProxy 控制台密码（读取额度用）",
              validate: (value) => (text(value) ? undefined : "密码不能为空"),
            },
          ],
          async authorize(inputs = {}) {
            const baseURL = text(inputs.baseURL) || DEFAULT_BASE_URL
            const apiKey = text(inputs.apiKey)
            const email = text(inputs.email)
            const password = text(inputs.password)
            if (!apiKey || !email || !password) return { type: "failed", error: "API key、控制台邮箱和密码都必须填写" }
            const auth = {
              type: "api",
              key: apiKey,
              metadata: { baseURL, email, password },
            }
            try {
              const session = await readSession(fetchImpl, auth)
              const me = dataOf(await authenticatedJSON(fetchImpl, session, "/user/me"))
              return {
                type: "success",
                key: apiKey,
                accountId: text(me.email || me.name || email),
                metadata: { ...auth.metadata, cookies: cookieOf(session) },
              }
            } catch (error) {
              return { type: "failed", error: safeError(error, "AiProxy 登录失败，请检查地址、邮箱和密码") }
            }
          },
        },
      ],
    },
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        const key = apiKeyOf(auth)
        if (!key) return provider?.models ?? {}
        let body
        try {
          body = await requestJSON(fetchImpl, `${modelURLOf(auth)}/models`, {
            headers: { authorization: `Bearer ${key}` },
          })
        } catch {
          return provider?.models ?? {}
        }
        const models = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
        const result = {}
        for (const model of models) {
          const row = modelRow(provider, model, modelURLOf(auth))
          if (row) result[row.id] = row
        }
        return Object.keys(result).length ? result : provider?.models ?? {}
      },
    },
  }
}

export const AiProxyPlugin = async (options = {}) => createPlugin(options)
export const _internal = {
  createPlugin,
  dataOf,
  mergeCookies,
  parseEntitlements,
  parseLegacyQuotas,
  quotaWindows,
  baseURLOf,
  modelURLOf,
  consoleURLOf,
  safeError,
}
