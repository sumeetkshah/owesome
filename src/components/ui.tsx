import { useEffect, useState, type ReactNode } from 'react'
import type { Member } from '../lib/api'
import { memberColor } from '../lib/format'
import { onToast } from '../lib/toast'

function initials(name: string) {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

export function Avatar({ member, size }: { member: Member; size?: 'sm' | 'lg' }) {
  return (
    <span className={`avatar ${size ?? ''}`} style={{ background: memberColor(member) }} aria-hidden>
      {initials(member.name)}
    </span>
  )
}

export function Sheet({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true">
        <div className="sheet-grip" />
        <div className="sheet-head">
          <h2 className="display h2">{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    let timer: number | undefined
    onToast((m) => {
      setMsg(m)
      clearTimeout(timer)
      timer = window.setTimeout(() => setMsg(null), 2400)
    })
    return () => {
      onToast(null)
      clearTimeout(timer)
    }
  }, [])
  return msg ? (
    <div className="toast" role="status">
      {msg}
    </div>
  ) : null
}

export function Brand({ onClick }: { onClick?: () => void }) {
  return (
    <button className="brand" onClick={onClick}>
      owe<span>some.</span>
    </button>
  )
}
