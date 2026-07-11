import { useState, useRef, useEffect, useCallback } from 'react';
import StatusLine from '../components/StatusLine';
import Sources from '../components/Sources';
import Markdown from '../components/Markdown';

interface Status { text: string; done: boolean }
interface Source { title: string; url: string; description: string }
interface Message {
  role: 'user' | 'assistant';
  content: string;
  statuses?: Status[];
  sources?: Source[];
}

const SUGGESTIONS = [
  'How do I trace OpenAI calls?',
  'How to set up evaluators?',
  'LangChain integration setup',
  'How does the AI gateway work?',
  'How to trace a Claude Code agent?',
];

export default function DocsChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    const el = messagesEndRef.current;
    if (el) {
      el.parentElement?.scrollTo({ top: el.parentElement.scrollHeight, behavior: 'smooth' });
    }
  };

  useEffect(scrollToBottom, [messages]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Helper to update the last assistant message
  const updateLast = useCallback((fn: (msg: Message) => Message) => {
    setMessages((prev) => {
      const updated = [...prev];
      updated[updated.length - 1] = fn({ ...updated[updated.length - 1] });
      return updated;
    });
  }, []);

  const markAllDone = useCallback(() => {
    updateLast((msg) => ({
      ...msg,
      statuses: msg.statuses?.map((s) => ({ ...s, done: true })),
    }));
  }, [updateLast]);

  const ask = useCallback(async (query: string) => {
    if (streaming) return;
    setStreaming(true);

    const userMsg: Message = { role: 'user', content: query };
    const assistantMsg: Message = {
      role: 'assistant',
      content: '',
      statuses: [{ text: 'Thinking...', done: false }],
      sources: [],
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    const controller = new AbortController();
    abortRef.current = controller;

    const chatHistory = [...messages, userMsg]
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-6)
      .map((m) => ({ role: m.role, content: m.content }));

    // Use a ref to accumulate text without triggering re-renders per token
    let textBuffer = '';
    let renderScheduled = false;

    const flushText = () => {
      renderScheduled = false;
      const current = textBuffer;
      updateLast((msg) => ({ ...msg, content: current }));
    };

    const appendText = (chunk: string) => {
      textBuffer += chunk;
      if (!renderScheduled) {
        renderScheduled = true;
        requestAnimationFrame(flushText);
      }
    };

    try {
      const res = await fetch('/docs/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          messages: chatHistory,
          userApiKey: apiKey || undefined,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        updateLast((msg) => ({
          ...msg,
          content: `Error: ${err.error || res.statusText}`,
          statuses: msg.statuses?.map((s) => ({ ...s, done: true })),
        }));
        setStreaming(false);
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;

          try {
            const parsed = JSON.parse(line.slice(6));

            if (parsed.type === 'status') {
              if (parsed.status === 'thinking') {
                updateLast((msg) => ({
                  ...msg,
                  statuses: [{ text: 'Thinking...', done: false }],
                }));
              } else if (parsed.status === 'searching') {
                updateLast((msg) => ({
                  ...msg,
                  statuses: [
                    ...(msg.statuses || []).map((s) => ({ ...s, done: true })),
                    { text: `Searching docs: "${parsed.query || '...'}"`, done: false },
                  ],
                }));
              } else if (parsed.status === 'answering') {
                updateLast((msg) => ({
                  ...msg,
                  statuses: [
                    ...(msg.statuses || []).map((s) => ({ ...s, done: true })),
                    { text: 'Generating answer...', done: false },
                  ],
                }));
              }
            } else if (parsed.type === 'sources' && parsed.pages) {
              updateLast((msg) => ({ ...msg, sources: parsed.pages }));
            } else if (parsed.type === 'text') {
              appendText(parsed.content);
            } else if (parsed.type === 'done') {
              flushText();
              markAllDone();
            } else if (parsed.type === 'error') {
              updateLast((msg) => ({
                ...msg,
                content: `Error: ${parsed.message}`,
                statuses: msg.statuses?.map((s) => ({ ...s, done: true })),
              }));
            }
          } catch {}
        }
      }

      // Final flush + mark done
      flushText();
      markAllDone();

      // Save to chat history
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (!last.content && textBuffer) {
          const updated = [...prev];
          updated[updated.length - 1] = { ...last, content: textBuffer };
          return updated;
        }
        return prev;
      });
    } catch (err: any) {
      flushText();
      if (err.name !== 'AbortError') {
        updateLast((msg) => ({
          ...msg,
          content: `Error: ${err.message}`,
          statuses: msg.statuses?.map((s) => ({ ...s, done: true })),
        }));
      }
      markAllDone();
    }

    abortRef.current = null;
    setStreaming(false);
    inputRef.current?.focus();
  }, [streaming, messages, apiKey, updateLast, markAllDone]);

  const handleSubmit = () => {
    if (streaming) { stop(); return; }
    const q = input.trim();
    if (!q) return;
    setInput('');
    ask(q);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  };

  const showWelcome = messages.length === 0;

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-[#0a0a0a] text-[#e5e5e5]">
      {/* Header */}
      <header className="flex items-center gap-3 px-6 py-4 border-b border-[#1a1a1a]">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#1a1a1a] bg-[#0f0f0f]">
          <span className="text-sm text-[#6483F0] whitespace-nowrap">See traces</span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Respan API key"
            autoComplete="off"
            spellCheck={false}
            className="px-2 py-0.5 bg-transparent text-[#e5e5e5] text-sm font-mono w-64 outline-none placeholder:text-[#555]"
          />
        </div>
        <span className="text-xs text-[#555]">
          Your key is never stored, cached, or logged.
        </span>
      </header>

      {/* Main */}
      <main className="flex-1 flex flex-col max-w-3xl w-full mx-auto px-6 overflow-hidden">
        {showWelcome && (
          <div className="text-center pt-20 pb-10">
            <h1 className="text-2xl font-semibold text-white mb-2">Ask Respan docs</h1>
            <p className="text-[#666] text-base">
              Ask anything about Respan. Get answers with sources from the docs.
            </p>
            <div className="flex flex-wrap gap-2 justify-center mt-6">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => ask(s)}
                  className="px-4 py-2.5 rounded-lg border border-[#1a1a1a] bg-[#0f0f0f] text-[#aaa] text-base cursor-pointer transition-all hover:border-[#6483F0] hover:text-white hover:bg-[#111]"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto flex flex-col gap-5 py-4">
          {messages.map((msg, i) => (
            <div key={i} className={`flex flex-col gap-1.5 ${msg.role === 'user' ? 'items-end' : ''}`}>
              <span className="text-xs font-semibold tracking-wide text-[#555]">
                {msg.role === 'user' ? 'You' : 'Respan'}
              </span>
              <div
                className={`px-5 py-4 rounded-xl text-base leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-[#1a1a2e] border border-[#2a2a4e] w-fit max-w-[85%]'
                    : 'bg-[#111] border border-[#1a1a1a]'
                }`}
              >
                {msg.role === 'assistant' && (
                  <>
                    {msg.statuses?.map((s, j) => (
                      <StatusLine key={j} text={s.text} done={s.done} />
                    ))}
                    {msg.sources && msg.sources.length > 0 && (
                      <Sources pages={msg.sources} />
                    )}
                    {msg.content ? <Markdown text={msg.content} /> : null}
                  </>
                )}
                {msg.role === 'user' && msg.content}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="py-4 border-t border-[#1a1a1a]">
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about Respan..."
              autoComplete="off"
              autoFocus
              className="flex-1 px-4 py-3 rounded-xl border border-[#1a1a1a] bg-[#0f0f0f] text-[#e5e5e5] text-base outline-none focus:border-[#6483F0] placeholder:text-[#444]"
            />
            <button
              onClick={handleSubmit}
              className={`px-5 py-3 rounded-xl text-base font-medium text-white transition-colors cursor-pointer ${
                streaming
                  ? 'bg-red-500 hover:bg-red-600'
                  : 'bg-[#6483F0] hover:bg-[#5070e0]'
              }`}
            >
              {streaming ? 'Stop' : 'Send'}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
