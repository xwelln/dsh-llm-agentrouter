/**
 * Live integration check: the real pi-ai adapter, this bundle's route profile,
 * and the User-Agent fence, streaming one turn from the relay.
 *
 * It is skipped unless both a relay key and the pi-ai package resolve, so the
 * suite still runs offline and on a machine that has no dsh install. What it
 * proves is the thing unit tests cannot: that a hand-declared route of this
 * shape builds, that the fence survives the adapter's own header pass
 * (attribution strips the profile's copy of `user-agent`), and that the relay
 * accepts the result.
 *
 * Provide the key as `AGENTROUTER_API_KEY`. The dsh Models settings page stores
 * it in the managed credentials document instead, which this test also reads —
 * it never prints or logs the value.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require_ = createRequire(import.meta.url)

/**
 * An absolute path as a dynamic-import specifier.
 *
 * Windows ESM rejects `C:\...` in `import()` (it reads the drive letter as a
 * URL scheme), so absolute paths must go through `pathToFileURL`. POSIX paths
 * are unchanged by the conversion, which keeps the upstream CI green.
 *
 * @param {string} path - an absolute filesystem path.
 * @returns {string} the specifier `import()` accepts on this platform.
 */
const asImportSpecifier = (path) => pathToFileURL(path).href

/**
 * The pi-ai `dist` directory, or undefined when the package is not installed.
 *
 * pi-ai is a transitive dependency of the dsh CLI rather than of this bundle,
 * so there is no single portable specifier for it. Candidates, in order: an
 * explicit override, ordinary resolution from this file, and the dsh install
 * beside the running Node binary.
 *
 * @returns {string | undefined} the absolute dist path.
 */
function piAiDist() {
  const override = process.env.DSH_PI_AI_DIST
  if (override !== undefined && existsSync(override)) return override

  try {
    return join(dirname(require_.resolve('@earendil-works/pi-ai/package.json')), 'dist')
  } catch {
    // Not a dependency here; fall through to the dsh install.
  }

  const globalModules = join(dirname(process.execPath), '..', 'lib', 'node_modules')
  const bundled = join(globalModules, '@deepseek-ai', 'dsh', 'node_modules', '@earendil-works', 'pi-ai', 'dist')
  return existsSync(bundled) ? bundled : undefined
}

/**
 * The relay key from the managed credentials document.
 *
 * Only the reference `AGENTROUTER_API_KEY` is read, and only its presence is
 * ever reported; the value goes straight into the request.
 *
 * @returns {string | undefined} the key, when one is stored.
 */
function storedKey() {
  const home = process.env.DSH_HOME ?? (process.env.HOME === undefined ? undefined : join(process.env.HOME, '.dsh'))
  if (home === undefined) return undefined
  try {
    const yaml = require_('js-yaml')
    const value = yaml.load(readFileSync(join(home, '.credentials.yaml'), 'utf8'))?.refs?.AGENTROUTER_API_KEY
    return typeof value === 'string' ? value : value?.value
  } catch {
    // No document, no js-yaml, or no such reference — the test skips.
    return undefined
  }
}

/**
 * The relay key, or undefined when there is nothing usable.
 *
 * An unset GitHub Actions secret arrives as an empty string rather than as an
 * absent variable, so presence alone is not enough: a blank value must read as
 * absent, or CI would try to authenticate with `Bearer ` and fail a test that
 * was meant to skip.
 *
 * @returns {string | undefined} a non-blank key.
 */
function relayKey() {
  for (const candidate of [process.env.AGENTROUTER_API_KEY, storedKey()]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
  }
  return undefined
}

const key = relayKey()
const dist = piAiDist()
const SENTINEL_HOST = 'relay.agentrouter.internal'
// The routes' own baseURLs: the fence is what makes them reach anything, which
// is exactly the seam these tests exercise.
const RELAY_HOST_ROOT = `https://${SENTINEL_HOST}`
const ENDPOINT = process.env.AGENTROUTER_ENDPOINT ?? 'cn'
const RELAY_HOST = process.env.AGENTROUTER_HOST
const HARNESS_UA = 'deepseek-harness/0.1.1 (+https://github.com/deepseek-ai/deepseek-harness)'

const skip =
  key === undefined ? 'no AGENTROUTER_API_KEY' : dist === undefined ? 'pi-ai is not installed' : false

/**
 * The three declared routes, one entry per wire protocol.
 *
 * Each entry restates its route from cordis.patch.yml — the lazy api factory
 * the adapter resolves, the baseURL suffix that protocol's SDK expects, the
 * model, its compat block, and a reasoning level the route offers — so a live
 * run proves each protocol's request shape survives the fence and is accepted
 * by the relay, not just the first one's.
 *
 * Every entry probes with glm-5.3: the relay serves it over all three
 * protocols (verified by hand), its budget pool is separate from the
 * Claude / GPT one that 402s when exhausted, and it always thinks — which
 * exercises the reasoning path of each protocol rather than sidestepping it.
 */
const ROUTES = [
  {
    label: 'openai-completions',
    lazyModule: 'api/openai-completions.lazy.js',
    factoryName: 'openAICompletionsApi',
    baseUrl: `${RELAY_HOST_ROOT}/v1`,
    modelId: 'glm-5.3',
    modelName: 'GLM 5.3',
    contextWindow: 1000000,
    maxTokens: 131072,
    thinkingLevelMap: { low: 'low', high: 'high', max: 'max' },
    reasoning: 'low',
    compat: {
      thinkingFormat: 'openai',
      supportsReasoningEffort: true,
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      supportsStore: false,
      supportsStrictMode: true,
      supportsUsageInStreaming: true,
    },
  },
  {
    label: 'anthropic-messages',
    lazyModule: 'api/anthropic-messages.lazy.js',
    factoryName: 'anthropicMessagesApi',
    // The Anthropic SDK appends /v1/messages itself, so the baseURL stops at
    // the host root — a /v1 suffix would produce /v1/v1/messages.
    baseUrl: RELAY_HOST_ROOT,
    modelId: 'glm-5.3',
    modelName: 'GLM 5.3',
    contextWindow: 1000000,
    maxTokens: 131072,
    thinkingLevelMap: { low: 'low', high: 'high', max: 'max' },
    reasoning: 'low',
    compat: {
      supportsTemperature: false,
      supportsStrictTools: true,
    },
  },
  {
    label: 'openai-responses',
    lazyModule: 'api/openai-responses.lazy.js',
    factoryName: 'openAIResponsesApi',
    // The Responses SDK appends /responses, so the /v1 prefix stays.
    baseUrl: `${RELAY_HOST_ROOT}/v1`,
    modelId: 'glm-5.3',
    modelName: 'GLM 5.3',
    contextWindow: 1000000,
    maxTokens: 131072,
    thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high', max: 'max' },
    reasoning: 'low',
    compat: {
      supportsStrictMode: true,
    },
  },
]

for (const spec of ROUTES) {
  test(`the declared ${spec.label} route streams a turn from the relay`, { skip }, async () => {
    const { createModels, createProvider } = await import(asImportSpecifier(join(dist, 'index.js')))
    // The lazy factory, exactly as `dsh-llm-pi-ai` resolves it from its protocol
    // table: `createProvider` wants the built streams object, not the module.
    const lazyModule = await import(asImportSpecifier(join(dist, spec.lazyModule)))
    const { apply, Config } = await import('../lib/index.js')

    // The fence, activated exactly as the harness activates it: the entry config
    // is the authority when no settings service is present, which is this case.
    const disposers = []
    const config = Config({
      endpoint: ENDPOINT,
      ...(RELAY_HOST === undefined ? {} : { endpoints: { cn: RELAY_HOST, intl: RELAY_HOST } }),
      announce: false,
    })
    apply(
      {
        effect: (fn) => disposers.push(fn() ?? (() => {})),
        // No settings service in this harness, so the injection never fires and
        // the composed entry stays the authority — the headless posture.
        inject: () => {},
        logger: { info() {}, warn() {} },
      },
      config,
    )

    try {
      const provider = createProvider({
        id: 'agentrouter',
        name: 'AgentRouter',
        baseUrl: spec.baseUrl,
        // The same auth shape `dsh-llm-pi-ai` builds for a hand-declared route
        // (`harnessApiKeyAuth`): the harness has already resolved the credential,
        // so this hands it straight to the protocol.
        auth: {
          apiKey: {
            name: 'AgentRouter',
            resolve: ({ credential }) =>
              Promise.resolve({ auth: { apiKey: credential?.key ?? key }, source: 'test' }),
          },
        },
        api: lazyModule[spec.factoryName](),
        models: [
          {
            id: spec.modelId,
            name: spec.modelName,
            api: spec.label,
            provider: 'agentrouter',
            baseUrl: spec.baseUrl,
            input: ['text'],
            // pi-ai's usage accounting reads `cost.tiers`, so a model descriptor
            // needs a cost block even when nothing consumes the number. The real
            // adapter materializes one from its catalog; this restates a zero.
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: spec.contextWindow,
            maxTokens: spec.maxTokens,
            reasoning: true,
            thinkingLevelMap: spec.thinkingLevelMap,
            compat: spec.compat,
          },
        ],
      })

      const models = createModels()
      models.setProvider(provider)
      const model = models.getModel('agentrouter', spec.modelId)

      // The harness sends its attribution User-Agent on every request; the fence
      // is what turns it into the one the relay accepts.
      const stream = models.streamSimple(
        model,
        { messages: [{ role: 'user', content: 'Reply with exactly: ok' }] },
        {
          maxTokens: 32,
          reasoning: spec.reasoning,
          headers: { 'user-agent': HARNESS_UA },
        },
      )

      const message = await stream.result()
      if (message.stopReason === 'error') {
        // The relay is in budget-pool exhaustion: accept the 402 annotation.
        // The fence must have kept the original message and appended the hint.
        assert.match(
          message.errorMessage ?? '',
          /Claude.*GPT.*本批额度已用完|Budget pool quota|quota\b.*exhausted/i,
          `the error message does not look like a quota annotation: ${message.errorMessage ?? ''}`,
        )
      } else {
        const text = message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('')
        assert.match(text.toLowerCase(), /ok/, `expected an answer through the fence, got ${JSON.stringify(text)}`)
      }
    } finally {
      for (const dispose of disposers.reverse()) dispose()
    }
  })
}

test('without the fence the relay rejects the harness User-Agent', { skip: key === undefined ? 'no AGENTROUTER_API_KEY' : false }, async () => {
  // The negative control that gives the test above its meaning: the relay gates
  // on User-Agent alone, so the same key and body must fail unfenced. If this
  // ever passes, the gate is gone and the fence can be retired.
  const { Config } = await import('../lib/index.js')
  const host = Config({ endpoint: ENDPOINT }).endpoints[ENDPOINT]
  const res = await fetch(`https://${host}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'user-agent': HARNESS_UA,
    },
    body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(30000),
  })
  assert.equal(res.status, 401, 'the relay is expected to reject an unfenced client')
  await res.json()
})
