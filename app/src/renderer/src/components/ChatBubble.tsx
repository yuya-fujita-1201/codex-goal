import type { ReactNode } from 'react'

interface ChatBubbleProps {
  role: 'user' | 'assistant'
  // Streaming bubbles render dynamic text plus a blinking cursor; finalized
  // bubbles use static `text`. Either supply text or children.
  text?: string
  children?: ReactNode
  // True when this is the still-streaming assistant turn — adds a subtle
  // cursor and a slightly different border so the user can tell what's live.
  streaming?: boolean
  // ISO timestamp shown in the corner. Optional.
  ts?: string | null
}

export default function ChatBubble({
  role,
  text,
  children,
  streaming = false,
  ts
}: ChatBubbleProps): JSX.Element {
  const isUser = role === 'user'
  const align = isUser ? 'justify-end' : 'justify-start'
  const bubbleClasses = isUser
    ? 'bg-blue-700 text-blue-50'
    : streaming
      ? 'bg-bg-secondary text-zinc-100 ring-1 ring-purple-600/60'
      : 'bg-bg-secondary text-zinc-100'

  return (
    <div className={`flex w-full ${align}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words ${bubbleClasses}`}
      >
        {children ?? (
          <>
            {text ?? ''}
            {streaming && <span className="ml-0.5 animate-pulse text-purple-300">▍</span>}
          </>
        )}
        {ts && (
          <div className={`mt-1 text-[10px] ${isUser ? 'text-blue-200/70' : 'text-zinc-500'}`}>
            {new Date(ts).toLocaleTimeString()}
          </div>
        )}
      </div>
    </div>
  )
}
