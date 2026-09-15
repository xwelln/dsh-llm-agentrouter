/**
 * Tests over the bundle patch, run with `node --test`.
 *
 * The patch is data, so what can rot is its agreement with the code beside it:
 * the sentinel host the fence rewrites, the single route the endpoint switch
 * assumes, and the group name the model picker shows.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'

import { Config } from '../lib/index.js'

const patch = load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))
const providers = patch.find((row) => row.id === 'llm-pi-ai').config.providers
const route = providers.agentrouter
const anthropicRoute = providers['agentrouter-anthropic']
const responsesRoute = providers['agentrouter-responses']

test('exactly three relay routes are declared, one per protocol', () => {
  // 协议是路由级配置（适配器按路由的 api 字段构建请求），一条路由只能是一种
  // 协议，所以三种协议就是三条路由。第二条同协议路由只会让选择器里的模型
  // 重复出现，而不会增加任何能力。
  assert.deepEqual(
    Object.keys(providers),
    ['agentrouter', 'agentrouter-anthropic', 'agentrouter-responses'],
    'each protocol is one route; a duplicate protocol would double models in the picker',
  )
  assert.equal(route.api, 'openai-completions')
  assert.equal(anthropicRoute.api, 'anthropic-messages')
  assert.equal(responsesRoute.api, 'openai-responses')
})

test('every route baseURL addresses the host the fence rewrites', () => {
  const { sentinel, endpoints } = Config({})
  for (const declared of [route, anthropicRoute, responsesRoute]) {
    assert.equal(new URL(declared.baseURL).host, sentinel, 'an unrewritten sentinel is the point of the design')
  }
  for (const host of Object.values(endpoints)) {
    assert.notEqual(host, sentinel, 'the sentinel must never be a real endpoint')
  }
})

test('the two OpenAI-shaped routes keep the /v1 prefix, the Anthropic one drops it', () => {
  // 三个 SDK 各自拼接路径：Chat Completions 拼 /chat/completions，Responses 拼
  // /responses，两者都需要 baseURL 以 /v1 结尾；Anthropic 的 SDK 自己拼
  // /v1/messages，baseURL 只能到主机根，否则变成 /v1/v1/messages。
  assert.equal(new URL(route.baseURL).pathname, '/v1')
  assert.equal(new URL(responsesRoute.baseURL).pathname, '/v1')
  assert.equal(new URL(anthropicRoute.baseURL).pathname, '/')
})

test('every route shares one credential reference', () => {
  // 同一个中转站账号：三条路由引用同一个密钥环境变量，凭据仍然只存放在
  // $DSH_HOME/.credentials.yaml 或进程环境中。
  for (const declared of [route, anthropicRoute, responsesRoute]) {
    assert.equal(declared.apiKeyEnv, 'AGENTROUTER_API_KEY')
  }
})

test('the picker group titles are names, not notices', () => {
  // The group title is the only string this plugin can put in that menu, which
  // makes it tempting to explain the endpoint there. It is a label: one group,
  // one name. Guidance belongs to the settings card, which owns the switch.
  assert.equal(route.displayName, 'AgentRouter')
  // 两个协议兄弟路由的分组名只标注协议差异，端点解释同样留在设置卡片里。
  assert.equal(anthropicRoute.displayName, 'AgentRouter (Anthropic)')
  assert.equal(responsesRoute.displayName, 'AgentRouter (Responses)')
})

test('the plugin row is inserted so the fence and the switch actually load', () => {
  const insert = patch.at(-1).insert
  assert.deepEqual(insert, [{ id: 'llm-agentrouter', name: 'dsh-llm-agentrouter' }])
})

test('every model declares the levels the relay was probed with', () => {
  const ids = route.models.map((model) => model.id)
  assert.deepEqual(ids, ['claude-opus-5', 'claude-opus-4-8', 'gpt-5.6-sol', 'deepseek-v4-flash', 'glm-5.3'])

  const wire = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  for (const model of route.models) {
    const levels = Object.entries(model.reasoningEfforts)
    assert.ok(
      levels.some(([level]) => level !== 'off'),
      `${model.id} must offer a thinking level`,
    )
    for (const [level, spelling] of levels) {
      if (level === 'off' && spelling === null) continue
      assert.ok(
        wire.includes(spelling),
        `${model.id}.${level} sends "${spelling}", which the relay's enum does not accept`,
      )
    }
  }
})

test('a model offers Off only when the relay lets it stop thinking', () => {
  // The relay refuses every level outside low/high/max for glm-5.3, naming the
  // reason: the model always thinks. Withholding `off` is therefore the honest
  // declaration — offering it would render a switch the upstream rejects.
  const offers = new Map(route.models.map((model) => [model.id, 'off' in model.reasoningEfforts]))
  assert.equal(offers.get('glm-5.3'), false)
  for (const id of ['claude-opus-5', 'claude-opus-4-8', 'gpt-5.6-sol', 'deepseek-v4-flash']) {
    assert.equal(offers.get(id), true, `${id} was probed with a working Off`)
  }
})

test('deepseek-v4-flash can actually stop thinking', () => {
  // Omitting `reasoning_effort` still returns reasoning content for this model,
  // so an empty `off:` would render a switch that changes nothing. Only the
  // relay's own `none` disables it.
  const efforts = route.models.find((model) => model.id === 'deepseek-v4-flash').reasoningEfforts
  assert.equal(efforts.off, 'none')
})

test('the anthropic route restates the catalog: adaptive thinking, xhigh/max only', () => {
  // 照抄 pi-ai 官方目录 anthropic provider 的声明：Opus 5 / 4.8 是自适应思考
  // 模型，只提供 xhigh / max 两档，没有 off；compat 三个开关原样复述。
  assert.deepEqual(anthropicRoute.models.map((model) => model.id), ['claude-opus-5', 'claude-opus-4-8'])
  for (const model of anthropicRoute.models) {
    assert.deepEqual(Object.keys(model.reasoningEfforts), ['xhigh', 'max'], `${model.id} offers only the adaptive levels`)
    assert.ok(!('off' in model.reasoningEfforts), 'an adaptive-thinking model has no Off')
    assert.equal(model.contextWindow, 1000000)
    assert.equal(model.maxTokens, 128000)
  }
  assert.equal(anthropicRoute.compat.forceAdaptiveThinking, true)
  assert.equal(anthropicRoute.compat.supportsTemperature, false)
  assert.equal(anthropicRoute.compat.supportsStrictTools, true)
})

test('the responses route restates the catalog, including its own off spelling', () => {
  // 照抄官方目录 openai provider 对 gpt-5.6-sol 的声明。Responses 协议下
  // off 的线上拼写是 none——与 Chat Completions 路由上方的 off:（空值）不同，
  // 这正是两条路由分开声明的原因。minimal 在目录里被钉为不支持，路由里
  // 的表达是整行省略。
  assert.deepEqual(responsesRoute.models.map((model) => model.id), ['gpt-5.6-sol'])
  const model = responsesRoute.models[0]
  assert.equal(model.reasoningEfforts.off, 'none')
  assert.ok(!('minimal' in model.reasoningEfforts), 'minimal is pinned unsupported, so the route omits it')
  assert.equal(model.contextWindow, 272000)
  assert.equal(model.maxTokens, 128000)
  assert.equal(responsesRoute.compat.supportsStrictMode, true)
})

test('compat fields the adapter withholds from a hand-declared route are absent', () => {
  // pi-ai 的适配器把每个 compat 字段分为 offer / withhold：withhold 的字段
  // 只允许它自己的内置目录为厂商路由设置，手写路由声明它们是加载错误
  // （ Responses 协议实际报错：«which is not configurable here»）。此处断言
  // 三条路由都没碰任何 withhold 字段，让宿主起不来的问题在离线测试就能拦住。
  const withheld = [
    'supportsOpenAIGrammarTools',
    'supportsToolSearch',
    'supportsExplicitPromptCacheMode',
    'openRouterRouting',
    'vercelGatewayRouting',
    'sendSessionAffinityHeaders',
    'sessionAffinityFormat',
    'supportsToolReferences',
  ]
  for (const declared of [route, anthropicRoute, responsesRoute]) {
    for (const field of withheld) {
      assert.ok(
        declared.compat?.[field] === undefined,
        `provider "${declared.displayName}" sets compat "${field}", which the adapter withholds from a hand-declared route`,
      )
    }
  }
})

test('every declared effort level except off carries its wire spelling', () => {
  // 路由 DSL 里声明档位就必须给出线上拼写，只有 off 可以留空（表示不发送）；
  // 目录里的 thinkingLevelMap { minimal: null } 表示"该档不支持"，换到路由里
  // 的正确表达是整行省略——省略即钉死不支持。这条守卫把那个实际报错过的
  // 形状（«needs the wire value dispatch should send»）在离线测试就拦下来。
  const declared = [route, anthropicRoute, responsesRoute].flatMap((provider) =>
    provider.models.map((model) => ({ provider: provider.displayName, model })),
  )
  for (const { provider, model } of declared) {
    for (const [level, spelling] of Object.entries(model.reasoningEfforts)) {
      if (level === 'off' && spelling === null) continue
      assert.ok(
        typeof spelling === 'string' && spelling.length > 0,
        `${provider} / ${model.id} level "${level}" is declared without a wire spelling; omit the line to pin it unsupported`,
      )
    }
  }
})
