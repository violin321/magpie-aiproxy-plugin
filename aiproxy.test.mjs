import test from "node:test"
import assert from "node:assert/strict"
import { _internal, AiProxyPlugin } from "./index.mjs"

const base = "https://aiproxy.example.test"

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function auth(extra = {}) {
  return {
    type: "api",
    key: "aiproxy-test-key",
    metadata: {
      baseURL: base,
      email: "owner@example.test",
      password: "password",
      ...extra,
    },
  }
}

test("parses AiProxy entitlement windows and wallet balance", () => {
  const result = _internal.parseEntitlements({
    balance_usd: 12.5,
    plans: [{
      plan: {
        id: "plan-1",
        name: "Starter",
        active: true,
        quota_limits: { window_hours: 5 },
      },
      remaining: {
        metric: "cost_usd",
        daily_used: 4,
        daily_limit: 10,
        weekly_used: 20,
        weekly_limit: 100,
      },
      resets: {
        daily: "2030-01-02T00:00:00Z",
        weekly: "2030-01-06T00:00:00Z",
      },
    }],
  })
  assert.equal(result.plan, "Starter")
  assert.equal(result.windows.length, 2)
  assert.equal(result.windows[0].used, 40)
  assert.equal(result.windows[0].unit, "USD")
  assert.equal(result.windows[0].resetsAt, "2030-01-02T00:00:00.000Z")
})

test("logs in, reads entitlements, and persists the session cookie", async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith("/auth/login")) {
      return response({ ok: true }, 200, { "set-cookie": "session=abc; Path=/; HttpOnly" })
    }
    if (String(url).endsWith("/user/me")) {
      assert.equal(new Headers(init.headers).get("cookie"), "session=abc")
      return response({ email: "owner@example.test", balance_usd: 12.5 })
    }
    if (String(url).endsWith("/user/entitlements")) {
      assert.equal(new Headers(init.headers).get("cookie"), "session=abc")
      return response({
        plans: [{
          plan: { name: "Starter", active: true },
          remaining: { metric: "requests", daily_used: 3, daily_limit: 10 },
        }],
      })
    }
    throw new Error(`unexpected ${url}`)
  }
  let saved
  const plugin = _internal.createPlugin({
    fetchImpl,
    client: { auth: { set: async ({ body }) => { saved = body } } },
  })
  const result = await plugin.auth.usage(async () => auth())
  assert.equal(result.plan, "Starter")
  assert.equal(result.balance, "$12.50")
  assert.equal(result.windows[0].used, 30)
  assert.equal(calls.filter((item) => item.url.endsWith("/auth/login")).length, 1)
  assert.equal(saved.key, "aiproxy-test-key")
  assert.equal(saved.metadata.cookies, "session=abc")
})

test("authorize returns an API credential without exposing secrets in errors", async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/auth/login")) return response({}, 401)
    throw new Error("unexpected")
  }
  const plugin = _internal.createPlugin({ fetchImpl })
  const method = plugin.auth.methods[0]
  const result = await method.authorize({
    baseURL: base,
    apiKey: "k".repeat(8),
    email: "owner@example.test",
    password: "test-password",
  })
  assert.equal(result.type, "failed")
  assert.match(result.error, /登录|会话|重新登录/)
  assert.doesNotMatch(result.error, /k{8}|test-password/)
})

test("model catalog uses the configured AiProxy API key", async () => {
  const fetchImpl = async (url, init = {}) => {
    assert.equal(String(url), `${base}/v1/models`)
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer aiproxy-test-key")
    return response({ data: [{ id: "gpt-test", name: "GPT Test" }] })
  }
  const plugin = _internal.createPlugin({ fetchImpl })
  const models = await plugin.provider.models({ id: "aiproxy", models: {} }, { auth: auth() })
  assert.equal(models["gpt-test"].providerID, "aiproxy")
  assert.equal(models["gpt-test"].api.url, `${base}/v1`)
})
