import { useRef, useState } from 'react'
import type { TeamAppearance } from '@ghost-bot/shared-types/ipc'
import type { WorkspaceBot } from '../types/workspace.ts'
import { TeamAvatar } from './TeamAvatar.tsx'

function crop(image: HTMLImageElement, position: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Image crop unavailable')
  const side = Math.min(image.naturalWidth, image.naturalHeight)
  context.drawImage(image, (image.naturalWidth - side) * position / 100,
    (image.naturalHeight - side) * position / 100, side, side, 0, 0, 128, 128)
  return canvas.toDataURL('image/png')
}

export function TeamAvatarEditor({ appearance, bots, memberIds, onChange, onBusyChange }: {
  appearance: TeamAppearance
  bots: WorkspaceBot[]
  memberIds: string[]
  onChange: (appearance: TeamAppearance) => void
  onBusyChange: (busy: boolean) => void
}) {
  const [source, setSource] = useState<HTMLImageElement | null>(null)
  const [position, setPosition] = useState(50)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operation = useRef(0)

  async function chooseImage() {
    const bridge = window.ghostBot
    if (!bridge || busy) return
    const id = ++operation.current
    setBusy(true)
    onBusyChange(true)
    setError(null)
    try {
      const dataUrl = await bridge.pickTeamAvatar()
      if (!dataUrl) return
      const image = new Image()
      image.src = dataUrl
      await image.decode()
      if (id !== operation.current) return
      if (!image.naturalWidth || !image.naturalHeight ||
          image.naturalWidth > 3072 || image.naturalHeight > 3072 ||
          image.naturalWidth * image.naturalHeight > 4000000) throw new Error('Image dimensions exceed the limit')
      const normalized = crop(image, 50)
      setPosition(50)
      setSource(image)
      onChange({ mode: 'upload', dataUrl: normalized })
    } catch (err) {
      if (id === operation.current) setError(err instanceof Error ? err.message : 'Image unavailable')
    } finally {
      if (id === operation.current) {
        setBusy(false)
        onBusyChange(false)
      }
    }
  }

  return (
    <fieldset className="gb-team-avatar-editor" disabled={busy}>
      <legend>Group avatar</legend>
      <TeamAvatar appearance={appearance} memberIds={memberIds} bots={bots} size={64} />
      <label>
        Bot avatar snapshot
        <select aria-label="Bot avatar snapshot" value="" onChange={(event) => {
          const bot = bots.find((entry) => entry.id === event.target.value)
          if (bot) {
            setError(null)
            setSource(null)
            onChange({ mode: 'bot', avatar: bot.avatar })
          }
        }}>
          <option value="">Choose a bot</option>
          {bots.map((bot) => <option value={bot.id} key={bot.id}>{bot.name}</option>)}
        </select>
      </label>
      <button type="button" className="gb-btn-outline" onClick={() => void chooseImage()} disabled={!window.ghostBot}>Upload image</button>
      <button type="button" className="gb-btn-outline" onClick={() => {
        setSource(null)
        setError(null)
        onChange({ mode: 'auto' })
      }} disabled={appearance.mode === 'auto'}>Reset to Auto</button>
      {source && <label>
        Square crop position
        <input type="range" min="0" max="100" value={position} aria-label="Square crop position"
          onChange={(event) => {
            const next = Number(event.target.value)
            setPosition(next)
            onChange({ mode: 'upload', dataUrl: crop(source, next) })
          }} />
      </label>}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  )
}
