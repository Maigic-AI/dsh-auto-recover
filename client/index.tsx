/**
 * dsh-auto-recover — Client UI scaffold (reference, not built).
 *
 * This file mirrors the dynamic-plugin prototype's browser half and documents
 * what the optional session UI should render once it is integrated through the
 * harness client toolchain + a Typert Remote (see client/README.md).
 *
 * NOT built as-is: `host.call` below must be replaced by a Typert Remote
 * (ctx.remote.autoRecover.*), and the file needs bundling via tsdown +
 * the harness client bundler before `dsh.client` can serve it.
 */

import * as React from 'react'

export const name = 'auto-recover-client'

export const inject = ['slots', 'timer', 'remote']

export function apply(ctx: any) {
  const slots = ctx.slots

  // --- Reference components (adapted from the prototype) ---

  const providerLabel = (p: string | null) => {
    if (p === 'deepseek') return 'DeepSeek'
    if (p === 'zai') return 'z.ai'
    return p || '额度'
  }

  const countdown = (ms: number) => {
    const diff = ms - Date.now()
    if (diff <= 0) return '即将恢复'
    const mins = Math.ceil(diff / 60000)
    const h = Math.floor(mins / 60)
    const m = mins % 60
    return h > 0 ? (m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`) : `${m} 分钟`
  }

  const stuckText = (st: any) => {
    const p = providerLabel(st.quotaProvider)
    if (st.nextResetAt) {
      return `⚠ 已被 ${p} 限额，预计 ${new Date(st.nextResetAt).toLocaleString()}（${countdown(st.nextResetAt)} 后）恢复`
    }
    if (st.quotaProvider === 'zai') return `⚠ 已被 ${p} 限额，恢复时间未知（等待重置或充值）`
    return `⚠ ${p} 余额不足，等待充值`
  }

  function useAutoState(sessionId: string) {
    const [st, setSt] = React.useState({ enabled: false, stuck: false, quotaProvider: null, nextResetAt: null })
    React.useEffect(() => {
      let live = true
      const load = async () => {
        try {
          // REPLACE with: ctx.remote.autoRecover.getState(sessionId)
          const s = await host.call('getState', { sessionId })
          if (live && s) setSt(s)
        } catch (_e) { /* ignore */ }
      }
      load()
      const stop = ctx.interval(load, 8000)
      return () => { live = false; if (stop) stop() }
    }, [sessionId])
    return [st, setSt] as const
  }

  function Toggle(props: { sessionId?: string }) {
    const [st, setSt] = useAutoState(props.sessionId ?? '')
    if (props.sessionId == null) return null
    const onToggle = async () => {
      const next = !st.enabled
      setSt({ ...st, enabled: next })
      try {
        // REPLACE with: ctx.remote.autoRecover.setEnabled(props.sessionId, next)
        const s = await host.call('setEnabled', { sessionId: props.sessionId, enabled: next })
        if (s) setSt({ ...st, ...s })
      } catch (_e) { /* ignore */ }
    }
    const label = st.enabled ? (st.stuck ? '自动恢复·限额中' : '自动恢复·开') : '自动恢复'
    return React.createElement('button', {
      type: 'button',
      'data-on': st.enabled ? 'true' : 'false',
      'data-stuck': st.stuck ? 'true' : 'false',
      onClick: onToggle,
      title: st.stuck ? '本会话已被限额，等待额度恢复后自动续跑' : '开启后，额度恢复时自动续跑当前会话',
    }, label)
  }

  function Status(props: { sessionId?: string }) {
    const [st] = useAutoState(props.sessionId ?? '')
    if (!st.enabled && !st.stuck) return null
    const text = st.stuck ? stuckText(st) : '自动恢复已开启：额度恢复后将自动续跑'
    return React.createElement('div', { 'data-on': st.enabled ? 'true' : 'false' }, text)
  }

  // --- Slot registrations ---

  slots.inject('conversation.session.header.utilities', () => slots.register(
    { name: 'conversation.session.header.utilities', id: 'auto-recover-toggle', order: 100, label: '自动恢复' },
    (props: any) => React.createElement(Toggle, { sessionId: props.sessionId }),
  ))

  slots.inject('conversation.composer.dock', () => slots.register(
    { name: 'conversation.composer.dock', id: 'auto-recover-status', order: 100, label: '自动恢复状态' },
    (props: any) => React.createElement(Status, { sessionId: props.sessionId }),
  ))
}
