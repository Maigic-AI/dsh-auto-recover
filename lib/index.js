/**
 * dsh-auto-recover — Host plugin.
 *
 * Automatically resumes sessions that stalled on a provider quota error
 * (`QUOTA` / `RATE_LIMIT`) once the quota is replenished.
 *
 * Supported quota sources (mirrors CodexBar's providers):
 *   - DeepSeek   : GET https://api.deepseek.com/user/balance  (is_available + balance_infos)
 *   - z.ai / GLM : GET https://api.z.ai/api/monitor/usage/quota/limit
 *                  (BigModel CN: https://open.bigmodel.cn/.../quota/limit)
 *                  (data.limits[] with TOKENS_LIMIT/CREDIT_LIMIT, remaining, nextResetTime)
 *
 * Control surface:
 *   - /auto_recover [on|off|status]   (human command)
 *   - auto_recover_status             (model tool)
 *
 * Composition note: this plugin is process-global — it watches every agent's
 * request errors and resumes across sessions — so mount it in the HOST
 * composition (one instance), not in an agent preset.
 */

import z from '@deepseek-ai/schemastery'

export const name = 'auto-recover'

export const inject = ['timer', 'commands', 'tools', 'goals', 'agents', 'credentials', 'settings']

/** Small logger that degrades to the process console when ctx.logger is absent. */
function makeLogger(ctx) {
  if (ctx && ctx.logger && typeof ctx.logger.info === 'function') return ctx.logger
  return {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  }
}

export function apply(ctx, config) {
  const logger = makeLogger(ctx)

  // Injected (Cordis waits for these before calling apply — avoids the
  // concurrent-mount race where ctx.get() would return undefined).
  const goals = ctx.goals
  const agents = ctx.agents
  const credentials = ctx.credentials
  const settings = ctx.settings
  const commands = ctx.commands
  const tools = ctx.tools

  const POLL_MS = 30000
  const FETCH_TIMEOUT_MS = 15000
  const API_MIN_INTERVAL_MS = 300000

  const enabledSessions = new Map() // sessionId -> { enabledAt }
  const stuckSessions = new Map() // sessionId -> record

  // --- per-session persistence (optional; degrades to in-memory when settings is absent) ---
  const AUTO_RECOVER_NS = 'auto-recover'
  let settingsReady = false
  if (settings && typeof settings.register === 'function') {
    try {
      settings.register(AUTO_RECOVER_NS, z.object({ sessions: z.array(z.string()).default([]) }), { base: { sessions: [] } })
      settingsReady = true
      const persisted = settings.get(AUTO_RECOVER_NS)
      const sessions = (persisted && Array.isArray(persisted.sessions)) ? persisted.sessions : []
      for (const sid of sessions) {
        if (typeof sid === 'string' && sid) enabledSessions.set(sid, { enabledAt: 0 })
      }
    } catch (error) {
      settingsReady = false
      logger.warn('[auto-recover] settings persistence unavailable: ' + String(error && error.message || error))
    }
  }
  async function persistEnabledSessions() {
    if (!settings || !settingsReady) return
    try {
      await settings.update(AUTO_RECOVER_NS, { sessions: Array.from(enabledSessions.keys()) })
    } catch (error) {
      logger.warn('[auto-recover] persist failed: ' + String(error && error.message || error))
    }
  }

  function quotaProviderFor(provider) {
    if (provider == null) return undefined
    const p = String(provider).toLowerCase()
    if (p === 'deepseek') return 'deepseek'
    if (/(?:zai|glm|bigmodel|zhipu)/.test(p)) return 'zai'
    return undefined
  }

  async function resolveKey(refName) {
    if (!credentials) return undefined
    try {
      const hit = await credentials.resolve(refName)
      return hit && typeof hit.value === 'string' && hit.value !== '' ? hit.value : undefined
    } catch (error) {
      logger.error(`[auto-recover] resolve credential failed ${refName}: ${String(error && error.message || error)}`)
      return undefined
    }
  }

  // Discover the credential ref (apiKeyEnv) for a pi-ai provider route from settings.
  async function discoverApiKeyEnv(provider) {
    if (!settings || !provider) return null
    try {
      const ns = settings.get('llm-pi-ai')
      const route = ns && ns.providers && ns.providers[provider]
      if (route && typeof route.apiKeyEnv === 'string' && route.apiKeyEnv) return route.apiKeyEnv
    } catch (error) {}
    return null
  }

  async function resolveProviderKey(provider, qp) {
    const discovered = await discoverApiKeyEnv(provider)
    if (discovered) {
      const key = await resolveKey(discovered)
      if (key) return key
    }
    const fallbacks = {
      deepseek: ['DEEPSEEK_API_KEY', 'DEEPSEEK_KEY'],
      zai: ['ZAI_CODING_CN_API_KEY', 'Z_AI_API_KEY', 'BIGMODEL_API_KEY', 'ZHIPU_API_KEY', 'ZHIPUAI_API_KEY', 'GLM_API_KEY'],
    }
    for (const ref of (fallbacks[qp] || [])) {
      const key = await resolveKey(ref)
      if (key) return key
    }
    return null
  }

  // Extract a wall-clock reset time ("YYYY-MM-DD HH:mm:ss") from a provider error message.
  function parseResetTimeFromMessage(message) {
    if (typeof message !== 'string' || !message) return null
    const m = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(message)
    if (!m) return null
    const y = parseInt(m[1], 10)
    const mo = parseInt(m[2], 10)
    const d = parseInt(m[3], 10)
    const h = parseInt(m[4], 10)
    const mi = parseInt(m[5], 10)
    const s = m[6] ? parseInt(m[6], 10) : 0
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null
    const t = new Date(y, mo - 1, d, h, mi, s).getTime()
    return Number.isFinite(t) ? t : null
  }

  // A follow-up message injected to reopen the turn of a non-goal session.
  function continueMessage() {
    return {
      id: 'ark-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12),
      role: 'user',
      content: [{ type: 'text', text: '之前的任务因额度限制被中断，现在额度已恢复。请继续之前未完成的任务，从上次中断处接着推进。' }],
      source: { kind: 'user' },
    }
  }

  // Authenticated HTTPS GET using Node's global fetch (available in the host process).
  async function httpGet(url, key) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
      const resp = await fetch(url, {
        headers: { Authorization: 'Bearer ' + (key || ''), Accept: 'application/json' },
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      const body = await resp.text()
      return { status: resp.status, body }
    } catch (error) {
      return { error: String(error && error.message || error) }
    }
  }

  function parseDeepseek(body) {
    let j
    try { j = JSON.parse(body) } catch (error) { return { available: false, nextResetAt: null, error: 'bad deepseek response' } }
    let balance = 0
    const infos = Array.isArray(j.balance_infos) ? j.balance_infos : []
    for (const info of infos) {
      const b = parseFloat(info && info.total_balance)
      if (Number.isFinite(b)) balance += b
    }
    const isAvailable = j.is_available === true
    const available = isAvailable && balance > 0
    return { available, nextResetAt: null, summary: { kind: 'deepseek', balance, isAvailable } }
  }

  const ZAI_WINDOW = { 1: 1440, 3: 60, 5: 1, 6: 10080 }
  function parseZai(body) {
    let j
    try { j = JSON.parse(body) } catch (error) { return { available: false, nextResetAt: null, error: 'bad z.ai response' } }
    const data = j && j.data
    if (!data || !Array.isArray(data.limits)) {
      return { available: false, nextResetAt: null, error: 'z.ai: ' + (j && j.msg ? j.msg : 'invalid quota response') }
    }
    const tokenLimits = data.limits
      .filter((l) => l && (l.type === 'TOKENS_LIMIT' || l.type === 'CREDIT_LIMIT'))
      .map((l) => ({
        windowMinutes: (ZAI_WINDOW[l.unit] && l.number > 0) ? l.number * ZAI_WINDOW[l.unit] : null,
        remaining: l.remaining,
        percentage: l.percentage,
        nextResetTime: l.nextResetTime,
      }))
      .sort((a, b) => (a.windowMinutes == null ? Number.MAX_SAFE_INTEGER : a.windowMinutes) - (b.windowMinutes == null ? Number.MAX_SAFE_INTEGER : b.windowMinutes))
    if (tokenLimits.length === 0) {
      return { available: false, nextResetAt: null, error: 'z.ai: no token/credit limits', summary: { kind: 'zai', limits: 0 } }
    }
    const primary = tokenLimits[0]
    const now = Date.now()
    let available = false
    let nextResetAt = null
    if (typeof primary.remaining === 'number' && primary.remaining > 0) available = true
    if (typeof primary.percentage === 'number' && primary.percentage < 100) available = true
    if (typeof primary.nextResetTime === 'number' && primary.nextResetTime > 0) {
      if (primary.nextResetTime <= now) available = true
      else nextResetAt = primary.nextResetTime
    }
    for (const l of tokenLimits) {
      if (typeof l.nextResetTime === 'number' && l.nextResetTime > now) {
        if (nextResetAt == null || l.nextResetTime < nextResetAt) nextResetAt = l.nextResetTime
      }
    }
    const remaining = typeof primary.remaining === 'number' ? primary.remaining : null
    const percentage = typeof primary.percentage === 'number' ? primary.percentage : null
    return { available, nextResetAt, summary: { kind: 'zai', limits: tokenLimits.length, remaining, percentage } }
  }

  function zaiEndpoints(provider) {
    const p = String(provider || '').toLowerCase()
    const cn = p.indexOf('cn') >= 0 || p.indexOf('bigmodel') >= 0 || p.indexOf('zhipu') >= 0
    const cnUrl = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'
    const globalUrl = 'https://api.z.ai/api/monitor/usage/quota/limit'
    return cn ? [cnUrl, globalUrl] : [globalUrl, cnUrl]
  }

  async function checkQuota(qp, provider) {
    try {
      const key = await resolveProviderKey(provider, qp)
      if (qp === 'deepseek') {
        if (!key) return { available: false, nextResetAt: null, error: '缺少 DeepSeek 密钥' }
        const r = await httpGet('https://api.deepseek.com/user/balance', key)
        if (r.error) return { available: false, nextResetAt: null, error: r.error }
        if (r.status !== 200) return { available: false, nextResetAt: null, error: 'deepseek HTTP ' + r.status }
        return parseDeepseek(r.body)
      }
      if (qp === 'zai') {
        if (!key) return { available: false, nextResetAt: null, error: '缺少 z.ai 密钥（无法查询配额）' }
        for (const url of zaiEndpoints(provider)) {
          const r = await httpGet(url, key)
          if (r.error) continue
          if (r.status === 200) {
            const parsed = parseZai(r.body)
            if (!parsed.error) return parsed
          }
        }
        return { available: false, nextResetAt: null, error: 'z.ai quota API 查询失败' }
      }
      return { available: false, nextResetAt: null, error: 'unknown provider ' + qp }
    } catch (error) {
      return { available: false, nextResetAt: null, error: String(error && error.message || error) }
    }
  }

  // Detect quota exhaustion. The goal round driver disarms the goal itself on agent/error.
  ctx.on('agent/request-error', (payload, next) => {
    try {
      const failure = payload && payload.failure
      const code = failure && failure.code
      if (code !== 'QUOTA' && code !== 'RATE_LIMIT') return next()
      const agent = payload && payload.agent
      const sessionId = agent && agent.id
      if (sessionId == null || !enabledSessions.has(sessionId)) return next()
      const qp = quotaProviderFor(payload.provider)
      if (!qp) {
        logger.info('[auto-recover] provider not gated: ' + String(payload && payload.provider))
        return next()
      }
      const msgResetAt = parseResetTimeFromMessage(failure.message)
      const retryAfter = failure.providerRetryAfterMs ? Date.now() + failure.providerRetryAfterMs : null
      const rec = {
        sessionId,
        provider: String(payload.provider),
        quotaProvider: qp,
        detectedAt: Date.now(),
        lastCheckAt: null,
        lastApiCheckAt: null,
        nextResetAt: msgResetAt || retryAfter || null,
        lastSummary: null,
        lastError: null,
        resumedAt: null,
      }
      if (goals) {
        try { const view = goals.get(agent); if (view) { rec.goalId = view.id; rec.goalRevision = view.revision } } catch (error) {}
      }
      stuckSessions.set(sessionId, rec)
      logger.info(`[auto-recover] session ${sessionId} stuck on ${qp} (${code}) resetAt=${rec.nextResetAt || 'unknown'}`)
    } catch (error) {
      logger.error('[auto-recover] request-error handler failed: ' + String(error && error.message || error))
    }
    return next()
  })

  const lastResumeAt = new Map() // sessionId -> ts; guards against resume storms
  async function maybeResume(sessionId, rec) {
    if (!agents) return false
    const last = lastResumeAt.get(sessionId) || 0
    if (Date.now() - last < 300000) return false
    lastResumeAt.set(sessionId, Date.now())
    const agent = agents.get(sessionId)
    if (!agent) return false
    let view
    if (goals) {
      try { view = goals.get(agent) } catch (error) { view = undefined }
    }
    // Goal path: re-arm a disarmed, still-active goal (round driver continues).
    if (view && view.activation === 'disarmed' && (view.phase === 'active' || view.phase === 'paused' || view.phase === 'blocked')) {
      try {
        goals.resume(agent, { id: view.id, revision: view.revision })
        rec.resumedAt = Date.now()
        logger.info('[auto-recover] resumed goal session ' + sessionId)
        return true
      } catch (error) {
        rec.lastError = 'resume failed: ' + String(error && error.message || error)
        logger.error('[auto-recover] resume failed ' + sessionId + ': ' + String(error && error.message || error))
        return false
      }
    }
    // Already running (transient quota recovered on its own): nothing to do.
    if (view && view.activation === 'armed') return true
    // No goal, or a completed goal: inject a continue message to reopen the turn.
    try {
      agent.followup(continueMessage())
      rec.resumedAt = Date.now()
      logger.info('[auto-recover] injected continue into session ' + sessionId)
      return true
    } catch (error) {
      rec.lastError = 'followup failed: ' + String(error && error.message || error)
      logger.error('[auto-recover] followup failed ' + sessionId + ': ' + String(error && error.message || error))
      return false
    }
  }

  async function pollOnce(sessionId, rec) {
    const now = Date.now()
    if (rec.nextResetAt != null && now >= rec.nextResetAt) {
      const cleared = await maybeResume(sessionId, rec)
      if (cleared) stuckSessions.delete(sessionId)
      return
    }
    if (rec.nextResetAt != null && rec.lastApiCheckAt != null && now - rec.lastApiCheckAt < API_MIN_INTERVAL_MS) return
    rec.lastApiCheckAt = now
    rec.lastCheckAt = now
    const q = await checkQuota(rec.quotaProvider, rec.provider)
    if (q.error) { rec.lastError = q.error; return }
    rec.lastError = null
    rec.lastSummary = q.summary
    if (q.nextResetAt != null) rec.nextResetAt = q.nextResetAt
    if (q.available) {
      const cleared = await maybeResume(sessionId, rec)
      if (cleared) stuckSessions.delete(sessionId)
    }
  }

  let polling = false
  ctx.interval(async () => {
    if (polling) return
    polling = true
    try {
      for (const [sessionId, rec] of Array.from(stuckSessions.entries())) {
        await pollOnce(sessionId, rec)
      }
    } catch (error) {
      // Never let a rejection escape into the host process: an unhandled
      // rejection in an interval callback can kill the Electron main process.
      logger.error('[auto-recover] poll failed: ' + String(error && error.message || error))
    } finally {
      polling = false
    }
  }, POLL_MS)

  // ---- Control surface: /auto_recover command + auto_recover_status tool ----

  function stateFor(sessionId) {
    const rec = stuckSessions.get(sessionId)
    return {
      enabled: enabledSessions.has(sessionId),
      stuck: rec ? true : false,
      quotaProvider: rec ? rec.quotaProvider : null,
      provider: rec ? rec.provider : null,
      detectedAt: rec ? rec.detectedAt : null,
      nextResetAt: rec ? rec.nextResetAt : null,
      lastError: rec ? rec.lastError : null,
    }
  }

  function renderStatus(sessionId) {
    const s = stateFor(sessionId)
    const lines = ['Auto-recover: ' + (s.enabled ? 'enabled' : 'disabled')]
    if (s.stuck) {
      lines.push('Quota provider: ' + s.quotaProvider)
      lines.push('Detected at: ' + (s.detectedAt ? new Date(s.detectedAt).toLocaleString() : 'unknown'))
      lines.push('Next reset: ' + (s.nextResetAt ? new Date(s.nextResetAt).toLocaleString() : 'unknown (waiting for recharge)'))
      if (s.lastError) lines.push('Last error: ' + s.lastError)
    } else if (s.enabled) {
      lines.push('Status: watching for quota exhaustion')
    }
    return lines.join('\n')
  }

  if (commands && typeof commands.register === 'function') try {
    commands.register({
      name: 'auto_recover',
      description: 'enable, disable, or view automatic resume after quota recovery for this session',
      input: { hint: '[on|off|status]' },
      handler: (invocation) => {
        const agent = invocation && invocation.agent
        const sessionId = agent && agent.id
        if (sessionId == null) return { kind: 'error', text: 'auto_recover: no active session' }
        const input = String((invocation && invocation.rawInput) || '').trim().toLowerCase()
        if (input === '' || input === 'status') {
          return { kind: 'success', text: renderStatus(sessionId) }
        }
        if (input === 'on') {
          if (!enabledSessions.has(sessionId)) enabledSessions.set(sessionId, { enabledAt: Date.now() })
          persistEnabledSessions()
          return { kind: 'success', text: 'Auto-recover enabled for this session.\n' + renderStatus(sessionId) }
        }
        if (input === 'off') {
          enabledSessions.delete(sessionId)
          stuckSessions.delete(sessionId)
          persistEnabledSessions()
          return { kind: 'success', text: 'Auto-recover disabled for this session.' }
        }
        return { kind: 'error', text: 'Usage: /auto_recover [on|off|status]' }
      },
    })
  } catch (error) {
    logger.error('[auto-recover] command registration failed: ' + String(error && error.message || error))
  }

  if (tools && typeof tools.register === 'function') try {
    tools.register({
      name: 'auto_recover_status',
      description: 'Read the auto-recover state for the current session: whether it is quota-limited and when it will next resume.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            stuck: { type: 'boolean' },
            text: { type: 'string' },
          },
          required: ['enabled', 'stuck', 'text'],
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: async (_args, exec) => {
        const sessionId = exec && exec.agent ? exec.agent.id : undefined
        if (sessionId == null) return { enabled: false, stuck: false, text: 'auto_recover: no active session' }
        const s = stateFor(sessionId)
        return { enabled: s.enabled, stuck: s.stuck, text: renderStatus(sessionId) }
      },
    })
  } catch (error) {
    logger.error('[auto-recover] tool registration failed: ' + String(error && error.message || error))
  }

  // ---- Model schedule: time-window default-model switching ----
  // Declared in the composition entry config as `modelSchedule`:
  //   windows:  [{ start: "14:00", end: "18:00", weekdays: [1,2,3,4,5],
  //                excludeDates: ["2026-10-01"],
  //                selection: { provider, model, reasoningEffort } }]
  //   fallback: { provider, model, reasoningEffort }
  // Switches fire only on window boundary crossings, so a manual default-model
  // change inside a window is never reverted until the next boundary.
  const schedule = config && config.modelSchedule
  let scheduleArmed = false
  let lastInside = false

  function parseHHMM(value) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''))
    if (!m) return null
    const h = Number(m[1])
    const mi = Number(m[2])
    if (h > 23 || mi > 59) return null
    return h * 60 + mi
  }

  function windowActive(w, now) {
    const s = parseHHMM(w.start)
    const e = parseHHMM(w.end)
    if (s == null || e == null) return false
    if (Array.isArray(w.weekdays) && w.weekdays.length > 0) {
      const isoDay = now.getDay() === 0 ? 7 : now.getDay() // 1=Mon..7=Sun
      if (!w.weekdays.includes(isoDay)) return false
    }
    if (Array.isArray(w.excludeDates) && w.excludeDates.length > 0) {
      const date = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
      if (w.excludeDates.includes(date)) return false
    }
    const cur = now.getHours() * 60 + now.getMinutes()
    return s <= e ? cur >= s && cur < e : cur >= s || cur < e // supports overnight windows
  }

  function currentWindow() {
    if (!schedule || !Array.isArray(schedule.windows)) return null
    const now = new Date()
    return schedule.windows.find((w) => w && windowActive(w, now)) || null
  }

  function sameSelection(a, b) {
    if (!a || !b) return false
    return a.provider === b.provider && a.model === b.model && (a.reasoningEffort ?? null) === (b.reasoningEffort ?? null)
  }

  function agentDefaultModelService() {
    try { return ctx.get('agentDefaultModel') } catch { return null }
  }

  async function applyScheduleSelection(selection, reason) {
    const adm = agentDefaultModelService()
    if (!adm || typeof adm.saveSelection !== 'function') {
      logger.warn('[model-schedule] agentDefaultModel service unavailable; cannot switch default model')
      return false
    }
    try {
      const cur = typeof adm.currentSelection === 'function' ? adm.currentSelection() : null
      if (sameSelection(cur, selection)) return false
      await adm.saveSelection({ provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort })
      logger.info(`[model-schedule] ${reason}: default -> ${selection.provider}/${selection.model} (${selection.reasoningEffort ?? 'default effort'})`)
      return true
    } catch (error) {
      logger.error('[model-schedule] saveSelection failed: ' + String(error && error.message || error))
      return false
    }
  }

  async function applyDesired(inside, w) {
    if (inside && w && w.selection) await applyScheduleSelection(w.selection, 'peak window entered')
    else if (!inside && schedule.fallback) await applyScheduleSelection(schedule.fallback, 'window exited')
  }

  async function evaluateSchedule(force) {
    if (!schedule) return
    const w = currentWindow()
    const inside = !!w
    if (!scheduleArmed) {
      scheduleArmed = true
      lastInside = inside
      if (force) { await applyDesired(inside, w); return }
      if (inside && w && w.selection && schedule.fallback) {
        // Restart landed inside a window: realign only when the fallback model
        // is still active (the boundary switch was missed); never override a
        // manual selection with anything else.
        try {
          const adm = agentDefaultModelService()
          const cur = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null
          if (sameSelection(cur, schedule.fallback)) await applyScheduleSelection(w.selection, 'startup realign')
        } catch (error) {}
      }
      return
    }
    if (force) { await applyDesired(inside, w); return }
    if (inside !== lastInside) {
      lastInside = inside
      await applyDesired(inside, w)
    }
  }

  function renderScheduleStatus() {
    if (!schedule) return 'Model schedule: not configured.'
    const w = currentWindow()
    const lines = ['Model schedule: ' + ((schedule.windows && schedule.windows.length) || 0) + ' window(s); now ' + (w ? 'INSIDE a window' : 'outside all windows')]
    for (const win of schedule.windows || []) {
      const days = Array.isArray(win.weekdays) && win.weekdays.length > 0 ? ' weekdays=' + win.weekdays.join(',') : ' every day'
      const sel = win.selection ? ' -> ' + win.selection.provider + '/' + win.selection.model + ' (' + (win.selection.reasoningEffort ?? 'default effort') + ')' : ' -> (no selection)'
      lines.push('- ' + win.start + '-' + win.end + days + sel)
    }
    if (schedule.fallback) lines.push('fallback -> ' + schedule.fallback.provider + '/' + schedule.fallback.model + ' (' + (schedule.fallback.reasoningEffort ?? 'default effort') + ')')
    try {
      const adm = agentDefaultModelService()
      const cur = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null
      if (cur) lines.push('current default: ' + cur.provider + '/' + cur.model + (cur.reasoningEffort ? ' (' + cur.reasoningEffort + ')' : ''))
    } catch (error) {}
    return lines.join('\n')
  }

  if (schedule) {
    ctx.interval(() => {
      evaluateSchedule(false).catch((error) => logger.error('[model-schedule] tick failed: ' + String(error && error.message || error)))
    }, 30000)
    evaluateSchedule(false).catch((error) => logger.error('[model-schedule] arm failed: ' + String(error && error.message || error)))
    logger.info('[model-schedule] armed with ' + ((schedule.windows && schedule.windows.length) || 0) + ' window(s)')
  }

  if (commands && typeof commands.register === 'function') try {
    commands.register({
      name: 'model_schedule',
      description: 'view the time-window default-model schedule; sync applies the scheduled selection now',
      input: { hint: '[status|sync]' },
      handler: (invocation) => {
        const input = String((invocation && invocation.rawInput) || '').trim().toLowerCase()
        if (!schedule) return { kind: 'error', text: 'model_schedule: no modelSchedule config in the plugin composition entry.' }
        if (input === 'sync') {
          evaluateSchedule(true).catch((error) => logger.error('[model-schedule] sync failed: ' + String(error && error.message || error)))
          return { kind: 'success', text: renderScheduleStatus() + '\n(sync dispatched)' }
        }
        return { kind: 'success', text: renderScheduleStatus() }
      },
    })
  } catch (error) {
    logger.error('[auto-recover] model_schedule command registration failed: ' + String(error && error.message || error))
  }
}
