import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { TODO_EVENT_NAME } from "../common/constants"
import { applyTodoSnapshot, snapshotForConversation } from "../common/guards"
import { TodoFeedbackStatus, TodoItem, TodoListSnapshot } from "../common/types"

import { bridge, useServerEvent } from "./messaging"

import styles from "./styles/todo-panel.module.css"

interface TodoPanelProps {
  conversationId?: string
}

const newRequestId = () => window.crypto.randomUUID()

interface TodoTreeRow {
  item: TodoItem
  depth: number
  children: number
}

export const TodoPanel = ({ conversationId }: TodoPanelProps): JSX.Element => {
  const { t } = useTranslation()
  const [heldSnapshot, setHeldSnapshot] = useState<TodoListSnapshot>()
  const [feedbackStatus, setFeedbackStatus] = useState<TodoFeedbackStatus>()
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>({})
  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState(true)
  const [showCompleted, setShowCompleted] = useState(false)
  const [title, setTitle] = useState("")
  const [editing, setEditing] = useState<string>()
  const [editTitle, setEditTitle] = useState("")
  const [editDetails, setEditDetails] = useState("")
  const [editPriority, setEditPriority] = useState<TodoItem["priority"]>("normal")
  const conversationIdRef = useRef(conversationId)
  conversationIdRef.current = conversationId
  const snapshot = snapshotForConversation(conversationId, heldSnapshot)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!conversationId) {
      setHeldSnapshot(undefined)
      return
    }
    try {
      const next = await bridge.request(TODO_EVENT_NAME.getList, { conversationId })
      if (conversationIdRef.current === conversationId) {
        // A conversation with no list yet has no snapshot; the panel shows its empty state.
        setHeldSnapshot((current) => (next ? applyTodoSnapshot(conversationId, current, next) : current))
        setError("")
      }
    } catch (reason) {
      if (conversationIdRef.current === conversationId) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    }
  }, [conversationId])

  // A switch drops the previous conversation's list and error before the new list loads.
  useEffect(() => {
    setHeldSnapshot(undefined)
    setError("")
    void refresh()
  }, [refresh])

  useServerEvent(TODO_EVENT_NAME.changed, (next) => {
    if (next.conversationId === conversationIdRef.current) {
      setHeldSnapshot((current) => applyTodoSnapshot(conversationIdRef.current, current, next))
      setError("")
    }
  })

  useServerEvent(TODO_EVENT_NAME.feedbackStatus, (next) => {
    if (next.conversationId === conversationIdRef.current) setFeedbackStatus(next)
  })

  const retryFeedback = () => {
    if (!conversationId) return
    void bridge.request(TODO_EVENT_NAME.retryFeedback, { conversationId }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  const currentFeedback = feedbackStatus?.conversationId === conversationId ? feedbackStatus : undefined
  const planning = currentFeedback?.state === "planning" || currentFeedback?.state === "retrying"
  const planningFailed = currentFeedback?.state === "failed"

  const visibleItems = useMemo(() => {
    const items = snapshot?.items ?? []
    return showCompleted ? items : items.filter((item) => item.status !== "completed" && item.status !== "cancelled")
  }, [snapshot, showCompleted])

  // Items whose parent is hidden by the completed filter surface as roots, so no visible task disappears.
  const treeRows = useMemo(() => {
    const ids = new Set(visibleItems.map((item) => item.id))
    const childrenOf = new Map<string, TodoItem[]>()
    const roots: TodoItem[] = []
    for (const item of visibleItems) {
      if (item.parentId && ids.has(item.parentId)) {
        childrenOf.set(item.parentId, [...(childrenOf.get(item.parentId) ?? []), item])
      } else {
        roots.push(item)
      }
    }
    const rows: TodoTreeRow[] = []
    const seen = new Set<string>()
    const visit = (item: TodoItem, depth: number) => {
      if (seen.has(item.id)) return
      seen.add(item.id)
      const children = childrenOf.get(item.id) ?? []
      rows.push({ item, depth, children: children.length })
      if (!collapsedMap[item.id]) children.forEach((child) => visit(child, depth + 1))
    }
    roots.forEach((root) => visit(root, 0))
    visibleItems.forEach((item) => visit(item, 0))
    return rows
  }, [visibleItems, collapsedMap])
  const completedCount = snapshot?.items.filter((item) => item.status === "completed").length ?? 0
  const pendingCount = snapshot?.items.filter((item) => item.status !== "completed" && item.status !== "cancelled").length ?? 0
  // Finished work leaves the active panel; its items stay in history behind the header toggle.
  const retired = !planning && pendingCount === 0 && completedCount > 0

  const mutate = useCallback(async (action: () => Promise<TodoListSnapshot>): Promise<boolean> => {
    setBusy(true)
    setError("")
    try {
      const next = await action()
      setHeldSnapshot((current) => applyTodoSnapshot(conversationIdRef.current, current, next))
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  const addItem = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const cleaned = title.trim()
    if (!conversationId || !cleaned) return
    void mutate(() => bridge.request(TODO_EVENT_NAME.createItem, {
      conversationId,
      requestId: newRequestId(),
      title: cleaned
    })).then((saved) => { if (saved) setTitle("") })
  }

  const update = (item: TodoItem, patch: Partial<Pick<TodoItem, "title" | "details" | "status" | "priority" | "blockedReason" | "sortOrder">>) => {
    if (!conversationId) return
    void mutate(() => bridge.request(TODO_EVENT_NAME.updateItem, {
      conversationId,
      requestId: newRequestId(),
      itemId: item.id,
      expectedVersion: item.version,
      patch
    }))
  }

  const complete = (item: TodoItem) => {
    if (!conversationId) return
    void mutate(() => bridge.request(TODO_EVENT_NAME.completeItem, {
      conversationId,
      requestId: newRequestId(),
      itemId: item.id,
      expectedVersion: item.version
    }))
  }

  const evaluate = (item: TodoItem) => {
    if (!conversationId) return
    void mutate(() => bridge.request(TODO_EVENT_NAME.evaluateItem, { conversationId, itemId: item.id }))
  }

  const renderItem = ({ item, depth, children }: TodoTreeRow) => (
  <li key={item.id} className={styles.item} data-status={item.status} data-depth={depth} style={{ marginLeft: depth * 16 }}>
          <span className={styles.status} title={item.status.replace(/_/g, " ")} aria-label={item.status.replace(/_/g, " ")}>
            {item.status === "completed" ? "✓" : item.status === "blocked" ? "!" : "○"}
          </span>
          <div className={styles.itemHeader} onClick={() => setExpandedMap(prev => ({ ...prev, [item.id]: !prev[item.id] }))}>
            <span className={`codicon codicon-chevron-${expandedMap[item.id] ? "down" : "right"}`} aria-hidden="true" />
            <span className={styles.itemTitle}>{item.title}</span>
            {!!children && (
              <button
                type="button"
                className={styles.childToggle}
                aria-expanded={!collapsedMap[item.id]}
                aria-label={collapsedMap[item.id] ? t("todo-expand-children") : t("todo-collapse-children")}
                title={collapsedMap[item.id] ? t("todo-expand-children") : t("todo-collapse-children")}
                onClick={(event) => {
                  event.stopPropagation()
                  setCollapsedMap(prev => ({ ...prev, [item.id]: !prev[item.id] }))
                }}
              >
                <span className={`codicon codicon-chevron-${collapsedMap[item.id] ? "right" : "down"}`} aria-hidden="true" />
                <span className={styles.childCount}>{children}</span>
              </button>
            )}
          </div>
          {editing === item.id ? (
            <form className={styles.editForm} onSubmit={(event) => {
              event.preventDefault()
              update(item, { title: editTitle, details: editDetails, priority: editPriority })
              setEditing(undefined)
            }}>
              <input value={editTitle} maxLength={500} onChange={(event) => setEditTitle(event.target.value)} aria-label={t("todo-edit-title")} />
              <textarea value={editDetails} maxLength={8000} onChange={(event) => setEditDetails(event.target.value)} aria-label={t("todo-edit-details")} placeholder={t("todo-edit-details")} />
              <select value={editPriority} onChange={(event) => setEditPriority(event.target.value as TodoItem["priority"])} aria-label={t("todo-priority-label")}>
                <option value="low">{t("todo-priority-low")}</option>
                <option value="normal">{t("todo-priority-normal")}</option>
                <option value="high">{t("todo-priority-high")}</option>
                <option value="urgent">{t("todo-priority-urgent")}</option>
              </select>
              <button type="submit" disabled={busy || !editTitle.trim()}>{t("todo-save")}</button>
              <button type="button" disabled={busy} onClick={() => setEditing(undefined)}>{t("todo-cancel")}</button>
            </form>
          ) : (
            expandedMap[item.id] && (
              <div className={styles.itemBody}>
                <span className={styles.itemMeta}>{t(`todo-status-${item.status}`)} · {t(`todo-priority-${item.priority}`)}{item.source === "intent_compiler" ? ` · ${t("todo-source-intent-compiler")}` : ""}</span>
                {!!item.details && <span className={styles.details}>{item.details}</span>}
                {!!item.criteria?.length && <span className={styles.details}>{t("todo-acceptance-criteria")}: {item.criteria.map((criterion) => criterion.description).join(" · ")}</span>}
                {!!item.blockedReason && <span className={styles.blockedReason}>{item.blockedReason}</span>}
                <div className={styles.actions}>
                  <button type="button" disabled={busy || item.sortOrder === 0} title={t("todo-move-up")} onClick={() => update(item, { sortOrder: item.sortOrder - 1 })}>↑</button>
                  <button type="button" disabled={busy || item.sortOrder === (snapshot?.items.length ?? 1) - 1} title={t("todo-move-down")} onClick={() => update(item, { sortOrder: item.sortOrder + 1 })}>↓</button>
                  <button type="button" disabled={busy} onClick={() => { setEditing(item.id); setEditTitle(item.title); setEditDetails(item.details ?? ""); setEditPriority(item.priority) }}>{t("todo-edit")}</button>
                  {item.status === "completed" || item.status === "cancelled" ? (
                    <button type="button" disabled={busy} onClick={() => update(item, { status: "pending" })}>{t("todo-reopen")}</button>
                  ) : (
                    <>
                      {item.status === "in_review" && <button type="button" disabled={busy} onClick={() => evaluate(item)}>{t("todo-review-now")}</button>}
                      <button type="button" disabled={busy} onClick={() => complete(item)}>{t("todo-complete")}</button>
                      {item.status !== "blocked" ? (
                        <button type="button" disabled={busy} onClick={() => {
                          const reason = window.prompt(t("todo-block-reason"))
                          if (reason?.trim()) update(item, { status: "blocked", blockedReason: reason.trim() })
                        }}>{t("todo-block")}</button>
                      ) : (
                        <button type="button" disabled={busy} onClick={() => update(item, { status: "in_progress" })}>{t("todo-resume")}</button>
                      )}
                      <button type="button" disabled={busy} onClick={() => update(item, { status: "cancelled" })}>{t("todo-cancel-item")}</button>
                    </>
                  )}
                </div>
              </div>
              )
            )}
        </li>
  )

  return (
    <section className={styles.panel} aria-label={t("todo-title")}>
      <div className={styles.header}>
        <button type="button" className={styles.toggle} aria-expanded={expanded} onClick={() => setExpanded(prev => !prev)}>
                    <span className={`codicon codicon-chevron-${expanded ? "down" : "right"}`} aria-hidden="true" />
                    <strong>{t("todo-title")}</strong>
                    <span className={styles.count}>{pendingCount} {t("todo-of")} {(snapshot?.items.length ?? 0)} {t("todo-open")}</span>
                  </button>
        {!!completedCount && <span className={styles.completedCount}>{completedCount} {t("todo-completed-count")}</span>}
        {retired && (
          <button type="button" className={styles.showCompleted} aria-pressed={showCompleted} onClick={() => setShowCompleted((value) => !value)}>
            {showCompleted ? t("todo-hide-completed") : t("todo-show-completed")}
          </button>
        )}
      </div>
      {expanded && !(retired && !showCompleted) && (
        <div className={styles.content}>
          {!conversationId ? (
            <p className={styles.empty}>{t("todo-start-chat")}</p>
          ) : (
            <>
              <form className={styles.addForm} onSubmit={addItem}>
                <input value={title} maxLength={500} onChange={(event) => setTitle(event.target.value)} placeholder={t("todo-add-placeholder")} aria-label={t("todo-add-placeholder")} />
                <button type="submit" disabled={busy || !title.trim()}>{t("todo-add")}</button>
              </form>
              {!!error && <p className={styles.error} role="alert">{error}</p>}
              {planning && <p className={styles.planning} role="status">{t("todo-planning")}</p>}
              {planningFailed && (
                <div className={styles.error} role="alert">
                  <span>{t("todo-feedback-failed")}{currentFeedback?.error ? `: ${currentFeedback.error}` : ""}</span>
                  <button type="button" disabled={busy || planning} onClick={retryFeedback}>{t("todo-retry")}</button>
                </div>
              )}
              {treeRows.length ? <ul className={styles.list}>{treeRows.map(renderItem)}</ul> : !retired && <p className={styles.empty}>{planning ? t("todo-planning-empty") : t("todo-empty")}</p>}
              {!!completedCount && !retired && (
                <button type="button" className={styles.showCompleted} onClick={() => setShowCompleted((value) => !value)}>
                  {showCompleted ? t("todo-hide-completed") : t("todo-show-completed")}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
