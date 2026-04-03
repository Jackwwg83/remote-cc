import { useState } from 'react'

export default function App() {
  const [connected, setConnected] = useState(false)

  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col">
      <header className="p-4 border-b border-gray-700 flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'}`} />
        <span className="font-mono text-sm">{connected ? 'Connected' : 'Disconnected'}</span>
        <span className="ml-auto text-xs text-gray-500">remote-cc v0.1.0</span>
      </header>
      
      <main className="flex-1 p-4 overflow-auto">
        {/* T-10: messages list */}
        <p className="text-gray-500 text-center mt-20">Send a message to get started</p>
      </main>
      
      <footer className="p-4 border-t border-gray-700">
        {/* T-10: input box */}
        <input 
          type="text" 
          placeholder="Type a message..." 
          className="w-full bg-gray-800 text-white p-3 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
        />
      </footer>
    </div>
  )
}
