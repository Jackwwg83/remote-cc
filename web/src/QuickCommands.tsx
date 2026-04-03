// T-36: Quick command panel — horizontal scrollable row of command pills (mobile only)

const COMMANDS = ['/clear', '/compact', '/cost', '/model', '/help', '/exit'] as const

interface QuickCommandsProps {
  onCommand: (cmd: string) => void
}

export default function QuickCommands({ onCommand }: QuickCommandsProps) {
  return (
    <div className="md:hidden flex gap-2 overflow-x-auto pb-2 mb-2 scrollbar-none">
      {COMMANDS.map((cmd) => (
        <button
          key={cmd}
          onClick={() => onCommand(cmd)}
          className="shrink-0 px-3 py-1.5 min-h-[36px] rounded-full
            bg-gray-700 text-gray-300 text-xs font-mono
            hover:bg-gray-600 active:bg-gray-500 transition-colors"
        >
          {cmd}
        </button>
      ))}
    </div>
  )
}
