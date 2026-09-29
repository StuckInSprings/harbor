import { variantLabel, type FanVariant } from '../../shared/fanout'
import { useEffect, useRef, useState } from 'react'
import type { Attachment, Prompt } from '../../shared/types'
import { ChevronDown, Plus, Return, Sliders, Stop } from './Icons'
import { formatTokens, shortModel } from '../lib/format'
import { PromptMenu, VariableForm, variablesIn } from './PromptMenu'
import { RichInput, type RichInputHandle } from './RichInput'
import { AttachmentChip } from './AttachmentChip'

export interface Segment {
  label: string
  tokens: number
  /** CSS custom property name carrying this segment's colour. */
  tone: string
}

interface Props {
  /** Changes when the conversation on screen does; the box takes focus on each change and when the window comes forward. */
  focusKey: string
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onStop: () => void
  streaming: boolean
  model: string | null
  onPickModel: () => void
  /** null when there is no conversation to attach settings to. */
  onOpenParams: (() => void) | null
  segments: Segment[]
  contextLength: number
  disabled: boolean
  /** null when the project has no folder, or the model cannot call tools. */
  agent: { on: boolean; toggle: () => void; reason: string | null }
  /** null unless the agent is on; plan is a way of running the agent, not a mode of its own. */
  plan: { on: boolean; toggle: () => void } | null
  /** Run commands without asking, for this project; null when there is no folder or no agent. */
  auto: { on: boolean; toggle: () => void } | null
  web: { on: boolean; toggle: () => void }
  /** null when the model cannot produce reasoning. */
  reasoning: { on: boolean; toggle: () => void; locked?: boolean } | null
  prompts: Prompt[]
  /** A built-in slash command was chosen; see COMMANDS in PromptMenu. */
  onCommand: (name: string, args?: string) => void
  /** Send the draft to several models at once; null when no model is chosen. */
  fanOut: {
    candidates: { id: string; name: string; current: boolean }[]
    /** The project's saved set, if one was saved. */
    layout: FanVariant[]
    onAsk: (variants: FanVariant[]) => void
    onSaveLayout: (variants: FanVariant[]) => void
  } | null
  onInspectPrompt: () => void
  attachments: Attachment[]
  onAttach: () => void
  onFiles: (files: File[]) => void
  onRemoveAttachment: (hash: string) => void
  /** Set when the model cannot read an attached image. */
  visionWarning: string | null
  notices: React.ReactNode
  /** A blocked run's question. Above everything, because nothing proceeds until it is answered. */
  approvals: React.ReactNode
  todos: React.ReactNode
  /** What the box says when empty; the default asks for a slash command. */
  placeholder?: string
}

export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  streaming,
  focusKey,
  model,
  onPickModel,
  onOpenParams,
  segments,
  contextLength,
  disabled,
  agent,
  plan,
  auto,
  web,
  reasoning,
  prompts,
  onCommand,
  fanOut,
  attachments,
  onAttach,
  onFiles,
  onRemoveAttachment,
  visionWarning,
  notices,
  approvals,
  onInspectPrompt,
  todos,
  placeholder
}: Props): React.JSX.Element {
  const ref = useRef<RichInputHandle>(null)
  // Typing should be possible the moment a conversation, or the window, is in front.
  useEffect(() => {
    ref.current?.focus()
  }, [focusKey])
  useEffect(() => {
    const onFocus = (): void => {
      const el = document.activeElement
      if (!el || el === document.body) ref.current?.focus()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])
  const [showBreakdown, setShowBreakdown] = useState(false)
  const [filling, setFilling] = useState<Prompt | null>(null)
  const [dragging, setDragging] = useState(false)
  /*
    The fan-out chooser: the conversation's model plus the favourites, each
    ticked or not. Favourites are the natural shortlist — starring a model is
    already the gesture for "one I reach for".
  */
  const [asking, setAsking] = useState(false)
  const [chosen, setChosen] = useState<string[]>([])
  /* The same model again, under other samplers: the split Msty draws, without the panes. */
  const [variants, setVariants] = useState<FanVariant[]>([])
  const [temp, setTemp] = useState('1.2')
  const openAsk = (): void => {
    if (!fanOut) return
    setChosen(fanOut.candidates.map((c) => c.id))
    setVariants([])
    setAsking(true)
  }
  const askSet = (): FanVariant[] => [...chosen.map((id) => ({ model: id })), ...variants]
  const useLayout = (): void => {
    if (!fanOut) return
    setChosen(fanOut.layout.filter((v) => !v.params || Object.keys(v.params).length === 0).map((v) => v.model))
    setVariants(fanOut.layout.filter((v) => v.params && Object.keys(v.params).length > 0))
  }
  const addVariant = (): void => {
    const t = Number(temp)
    if (!model || !Number.isFinite(t) || t < 0 || t > 2) return
    setVariants((list) => [...list, { model, params: { temperature: t } }])
  }

  /*
    The slash menu opens only when the draft starts with a slash, which keeps it
    out of the way of ordinary text that happens to contain one.
  */
  const slashQuery =
    value.startsWith('/') && !value.includes('\n') && !filling ? value.slice(1) : null

  const choose = (p: Prompt): void => {
    if (variablesIn(p.body).length > 0) setFilling(p)
    else {
      onChange(p.body)
      ref.current?.focus()
    }
  }

  // The slash menu handles Enter, Tab and the arrows while it is open; the box leaves them to it.
  const menuOwns = (key: string): boolean => slashQuery !== null && ['Enter', 'Tab', 'ArrowUp', 'ArrowDown'].includes(key)
  const submit = (): void => {
    if (!streaming && value.trim()) onSubmit()
  }

  const usedTokens = segments.reduce((sum, s) => sum + s.tokens, 0)
  const share = contextLength > 0 ? Math.min(usedTokens / contextLength, 1) : 0

  return (
    <div className="composer">
      <div className="composer__inner">
        {todos}

        {filling && (
          <VariableForm
            prompt={filling}
            onDone={(text) => {
              setFilling(null)
              onChange(text)
              ref.current?.focus()
            }}
            onCancel={() => setFilling(null)}
          />
        )}

        {slashQuery !== null && (
          <PromptMenu
            prompts={prompts}
            filter={slashQuery}
            onPick={choose}
            onCommand={(name, args) => {
              onChange('')
              onCommand(name, args)
            }}
            onClose={() => onChange('')}
          />
        )}
        {approvals}
        {notices}
        {visionWarning && <div className="composer__warn">{visionWarning}</div>}

        {attachments.length > 0 && (
          <div className="atts">
            {attachments.map((a) => (
              <AttachmentChip key={a.hash} attachment={a} onRemove={onRemoveAttachment} />
            ))}
          </div>
        )}

        <div
          className="composer__box"
          data-dragging={dragging}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            const files = Array.from(e.dataTransfer.files)
            if (files.length === 0) return
            e.preventDefault()
            setDragging(false)
            onFiles(files)
          }}
        >
          <RichInput
            ref={ref}
            value={value}
            onChange={onChange}
            onSubmit={submit}
            ownedKeys={menuOwns}
            onPasteFiles={onFiles}
            placeholder={disabled ? 'Add an OpenRouter key in Settings to start' : placeholder ?? 'Type / for commands'}
            disabled={disabled}
          />

          {asking && fanOut && (
            <div className="askmany">
              <div className="askmany__head">
                <span className="sounding">Ask at once</span>
                <span className="askmany__hint">
                  {fanOut.candidates.length > 1
                    ? 'Replies open side by side; keep the one you like.'
                    : 'Star models in the picker and they appear here; or ask this one again at another temperature below.'}
                </span>
              </div>
              {fanOut.candidates.map((c) => (
                <label className="askmany__row" key={c.id}>
                  <input
                    type="checkbox"
                    checked={chosen.includes(c.id)}
                    onChange={(e) =>
                      setChosen((list) =>
                        e.target.checked ? [...list, c.id] : list.filter((id) => id !== c.id)
                      )
                    }
                  />
                  <span className="askmany__name">{c.name}</span>
                  {c.current && <span className="row__badge">current</span>}
                </label>
              ))}
              {variants.map((v, i) => (
                <div className="askmany__row" key={`${v.model}-${i}`}>
                  <input type="checkbox" checked readOnly onChange={() => setVariants((list) => list.filter((_, j) => j !== i))} />
                  <span className="askmany__name">
                    {shortModel(v.model)} <span className="sounding">{variantLabel(v)}</span>
                  </span>
                  <span className="row__badge">again</span>
                </div>
              ))}
              {model && (
                <div className="askmany__row askmany__variant">
                  <span className="askmany__hint">Also ask {shortModel(model)} at temperature</span>
                  <input className="askmany__temp" type="number" min={0} max={2} step={0.1} value={temp} onChange={(e) => setTemp(e.target.value)} />
                  <button className="btn" onClick={addVariant} title="The same model once more, under this temperature, so the two can be compared">
                    Add
                  </button>
                </div>
              )}
              <div className="askmany__actions">
                {fanOut.layout.length > 0 && (
                  <button className="btn" onClick={useLayout} title={`The saved set: ${fanOut.layout.map((v) => `${shortModel(v.model)} ${variantLabel(v)}`.trim()).join(', ')}`}>
                    Use layout
                  </button>
                )}
                <button className="btn" disabled={askSet().length === 0} onClick={() => fanOut.onSaveLayout(askSet())} title="Keep this set as the project's layout, to ask again with one click">
                  Save as layout
                </button>
                <span style={{ flex: 1 }} />
                <button className="btn" onClick={() => setAsking(false)}>
                  Cancel
                </button>
                <button
                  className="btn btn--primary"
                  disabled={askSet().length === 0}
                  onClick={() => {
                    setAsking(false)
                    fanOut.onAsk(askSet())
                  }}
                >
                  Ask {askSet().length} {askSet().length === 1 ? 'time' : 'times'}
                </button>
              </div>
            </div>
          )}

          {streaming ? (
            <button className="send send--stop" onClick={onStop} title="Stop" aria-label="Stop">
              <Stop size={14} />
            </button>
          ) : (
            <button
              className="send"
              onClick={onSubmit}
              disabled={disabled || (!value.trim() && attachments.length === 0) || !model}
              title="Send (Return)"
             aria-label="Send (Return)">
              <Return size={15} />
            </button>
          )}
        </div>

        {/*
          The controls sit under the box as words, not pills: what is on reads
          in ink, what is off in the faint tone. The model is on the right,
          where the eye goes last.
        */}
        <div className="composer__bar">
            <button
              className="agent-toggle"
              aria-pressed={agent.on && !agent.reason}
              disabled={!!agent.reason}
              onClick={agent.toggle}
              title={
                agent.reason ??
                'The model can read, search and edit files inside the project folder.'
              }
             aria-label={
                agent.reason ??
                'The model can read, search and edit files inside the project folder.'
              }>
              {agent.reason ? 'Chat only' : agent.on ? 'Agent' : 'Chat only'}
            </button>

            {plan && (
              <button
                className="agent-toggle agent-toggle--plan"
                aria-pressed={plan.on}
                onClick={plan.toggle}
                title="Read only. The model can look through the project and say what it would do, but cannot write files or run commands until this is off."
              >
                Plan
              </button>
            )}

            {auto && (
              <button
                className="agent-toggle agent-toggle--auto"
                aria-pressed={auto.on}
                onClick={auto.toggle}
                title={
                  auto.on
                    ? 'Commands run without asking, in this project. Only inside a folder under version control; the hard deny list still refuses the dangerous ones. Click to go back to asking.'
                    : 'Ask before every command that is not already allowed. Click to let the agent run commands on its own — for this project, and only while its folder is under version control.'
                }
               aria-label={
                  auto.on
                    ? 'Commands run without asking, in this project. Only inside a folder under version control; the hard deny list still refuses the dangerous ones. Click to go back to asking.'
                    : 'Ask before every command that is not already allowed. Click to let the agent run commands on its own — for this project, and only while its folder is under version control.'
                }>
                {auto.on ? 'Auto' : 'Ask'}
              </button>
            )}

            {onOpenParams && (
              <button className="icon-btn" onClick={onOpenParams} title="Sampling parameters" aria-label="Sampling parameters">
                <Sliders size={14} />
              </button>
            )}

            <button className="icon-btn" onClick={onAttach} title="Attach images, PDFs or text files" aria-label="Attach images, PDFs or text files">
              <Plus size={14} />
            </button>

            <button
              className="agent-toggle"
              aria-pressed={web.on}
              onClick={web.toggle}
              title="Let the model search the web. Billed per search, on top of tokens, and what it finds is untrusted."
            >
              Web
            </button>

            {reasoning && (
              <button
                className="agent-toggle"
                aria-pressed={reasoning.on}
                onClick={reasoning.toggle}
                disabled={reasoning.locked}
                title={reasoning.locked ? 'This model always reasons; it cannot be turned off.' : 'Ask the model to show its reasoning. Costs extra tokens.'}
              >
                Reasoning
              </button>
            )}

            <span className="composer__spacer" />

            <button className="composer__model" onClick={onPickModel}>
              {model ? shortModel(model) : 'Choose a model'}
              <ChevronDown size={12} />
            </button>

            {streaming ? (
              <span className="row__spinner" title="Working" />
            ) : (
              fanOut && (
                <button
                  className="icon-btn"
                  onClick={openAsk}
                  disabled={disabled || (!value.trim() && attachments.length === 0)}
                  title="Ask several models at once and compare the replies"
                >
                  ⇉
                </button>
              )
            )}
        </div>

        {/*
          The sounding line — context depth, drawn as a chart mark. The ticks are
          fixed quarter marks so you read depth by position, not by colour alone.
        */}
        {contextLength > 0 && (
          <div
            className="sounding-line"
            role="button"
            tabIndex={0}
            onClick={onInspectPrompt}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onInspectPrompt()
            }}
            onMouseEnter={() => setShowBreakdown(true)}
            onMouseLeave={() => setShowBreakdown(false)}
          >
            <div className="sounding-line__track" data-deep={share > 0.75}>
              {segments.map((seg) => (
                <span
                  key={seg.label}
                  className="sounding-line__seg"
                  style={{
                    width: `${(seg.tokens / contextLength) * 100}%`,
                    background: `var(${seg.tone})`
                  }}
                />
              ))}
              <div className="sounding-line__ticks" aria-hidden="true">
                <span /><span /><span /><span />
              </div>
            </div>

            <span className="sounding">
              {formatTokens(usedTokens)} / {formatTokens(contextLength)}
            </span>

            {showBreakdown && usedTokens > 0 && (
              <div className="breakdown">
                {segments
                  .filter((seg) => seg.tokens > 0)
                  .map((seg) => (
                    <div className="breakdown__row" key={seg.label}>
                      <span className="breakdown__dot" style={{ background: `var(${seg.tone})` }} />
                      <span className="breakdown__label">{seg.label}</span>
                      <span className="sounding">{formatTokens(seg.tokens)}</span>
                    </div>
                  ))}
                <div className="breakdown__hint sounding">Click to read the system prompt</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
