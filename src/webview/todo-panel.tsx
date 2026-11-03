import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { TODO_EVENT_NAME } from "../common/constants"
import { TodoItem, TodoListSnapshot } from "../common/types"

import { bridge, useServerEvent } from "./messaging"

import styles from "./styles/todo-panel.module.css"

interface TodoPanelProps {
  conversationId?: string
}

const newRequestId = () => window.crypto.randomUUID()

export const TodoPanel = ({ conversationId }: TodoPanelProps): JSX.Element => {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<TodoListSnapshot>()
  const [expanded, setExpanded] = useState(false)
  const [showCompleted, setShowCompleted] = useState(false)
  const [title, setTitle] = useState("")
  const [editing, setEditing] = useState<string>()
  const [editTitle, setEditTitle] = useState("")
  const [editDetails, setEditDetails] = useState("")
  const [editPriority, setEditPriority] = useState<TodoItem["priority"]>("normal")
  const conversationIdRef = useRef(conversationId)
  conversationIdRef.current = conversationId
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!conversationId) {
      setSnapshot(undefined)
      return
    }
    try {
      const next = await bridge.request(TODO_EVENT_NAME.getList, { conversationId })
      if (conversationIdRef.current === conversationId) {
        setSnapshot(next)
        setError("")
      }
    } catch (reason) {
      if (conversationIdRef.current === conversationId) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    }
  }, [conversationId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useServerEvent(TODO_EVENT_NAME.changed, (next) => {
    if (next.conversationId === conversationId) {
      setSnapshot(next)
      setError("")
    }
  })

  const visibleItems = useMemo(() => {
    const items = snapshot?.items ?? []
    return showCompleted ? items : items.filter((item) => item.status !== "completed" && item.status !== "cancelled")
  }, [snapshot, showCompleted])
  const completedCount = snapshot?.items.filter((item) => item.status === "completed").length ?? 0
  const pendingCount = snapshot?.items.filter((item) => item.status !== "completed" && item.status !== "cancelled").length ?? 0

  const mutate = useCallback(async (action: () => Promise<TodoListSnapshot>): Promise<boolean> => {
    setBusy(true)
    setError("")
    try {
      setSnapshot(await action())
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

  const renderItem = (item: TodoItem) => (
    <li key={item.id} className={styles.item} data-status={item.status} style={{ marginLeft: item.parentId ? 16 : 0 }}>
      <span className={styles.status} title={item.status.replace(/_/g, " ")} aria-label={item.status.replace(/_/g, " ")}>
        {item.status === "completed" ? "✓" : item.status === "blocked" ? "!" : "○"}
      </span>
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
        <div className={styles.itemBody}>
          <span className={styles.itemTitle}>{item.title}</span>
          <span className={styles.itemMeta}>{t(`todo-status-${item.status}`)} · {t(`todo-priority-${item.priority}`)}{item.source === "intent_compiler" ? ` · ${t("todo-source-intent-compiler")}` : ""}</span>
          {!!item.details && <span className={styles.details}>{item.details}</span>}
          {!!item.acceptanceCriteria?.length && <span className={styles.details}>{t("todo-acceptance-criteria")}: {item.acceptanceCriteria.join(" · ")}</span>}
          {!!item.blockedReason && <span className={styles.blockedReason}>{item.blockedReason}</span>}
          <div className={styles.actions}>
            <button type="button" disabled={busy || item.sortOrder === 0} title={t("todo-move-up")} onClick={() => update(item, { sortOrder: item.sortOrder - 1 })}>↑</button>
            <button type="button" disabled={busy || item.sortOrder === (snapshot?.items.length ?? 1) - 1} title={t("todo-move-down")} onClick={() => update(item, { sortOrder: item.sortOrder + 1 })}>↓</button>
            <button type="button" disabled={busy} onClick={() => { setEditing(item.id); setEditTitle(item.title); setEditDetails(item.details ?? ""); setEditPriority(item.priority) }}>{t("todo-edit")}</button>
            {item.status === "completed" || item.status === "cancelled" ? (
              <button type="button" disabled={busy} onClick={() => update(item, { status: "pending" })}>{t("todo-reopen")}</button>
            ) : (
              <>
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
      )}
    </li>
  )

  return (
    <section className={styles.panel} aria-label={t("todo-title")}>
      <div className={styles.header}>
        <button type="button" className={styles.toggle} onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
          <span className={`codicon codicon-chevron-${expanded ? "down" : "right"}`} aria-hidden="true" />
          <strong>{t("todo-title")}</strong>
          <span className={styles.count}>{pendingCount} {t("todo-of")} {(snapshot?.items.length ?? 0)} {t("todo-open")}</span>
        </button>
        {!!completedCount && <span className={styles.completedCount}>{completedCount} {t("todo-completed-count")}</span>}
      </div>
      {expanded && (
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
              {visibleItems.length ? <ul className={styles.list}>{visibleItems.map(renderItem)}</ul> : <p className={styles.empty}>{t("todo-empty")}</p>}
              {!!completedCount && (
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
