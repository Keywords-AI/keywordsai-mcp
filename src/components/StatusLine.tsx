interface Props {
  text: string;
  done: boolean;
}

export default function StatusLine({ text, done }: Props) {
  return (
    <div className={`flex items-center gap-2 text-sm py-1 ${done ? 'text-[var(--text-faint)]' : 'text-[var(--accent)]'}`}>
      {done ? (
        <span>✓</span>
      ) : (
        <div className="w-3 h-3 border-2 border-[var(--border-accent)] border-t-[var(--accent)] rounded-full animate-spin" />
      )}
      <span>{text}</span>
    </div>
  );
}
