interface Page {
  title: string;
  url: string;
  description: string;
}

interface Props {
  pages: Page[];
}

export default function Sources({ pages }: Props) {
  return (
    <div className="flex flex-wrap gap-2 mb-3">
      {pages.map((p, i) => (
        <a
          key={i}
          href={p.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm px-3 py-1.5 rounded-md bg-[var(--surface)] border border-[var(--border-accent)] text-[var(--accent)] no-underline transition-all hover:bg-[var(--user-bubble)] hover:border-[var(--accent)]"
        >
          {p.title}
        </a>
      ))}
    </div>
  );
}
