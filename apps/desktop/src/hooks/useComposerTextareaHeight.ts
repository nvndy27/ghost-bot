import { useLayoutEffect, useRef } from 'react'

export function useComposerTextareaHeight(draft: string) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const textarea = ref.current
    if (!textarea) return
    const fit = () => {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`
    }
    fit()
    let width = textarea.clientWidth
    const observer = new ResizeObserver(() => {
      if (textarea.clientWidth === width) return
      width = textarea.clientWidth
      fit()
    })
    observer.observe(textarea)
    return () => observer.disconnect()
  }, [draft])

  return ref
}
