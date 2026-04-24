import { marked, type Token, type Tokens } from "marked";
import type { ReactNode } from "react";

marked.use({ gfm: true, breaks: false });

const COLLAPSE_THRESHOLD = 30;

const MENTION_RE = /@([A-Za-z][A-Za-z0-9_-]*)(?![/~]|\.[\w/])/g;

type RenderDeps = { me: string; colorFor: (who: string) => string };

function parse(text: string): Token[] {
  return marked.lexer(text);
}

export function isSimpleParagraph(text: string): Token[] | null {
  const tokens = parse(text).filter((t) => t.type !== "space");
  if (tokens.length === 1 && tokens[0].type === "paragraph") {
    return (tokens[0] as Tokens.Paragraph).tokens;
  }
  return null;
}

function renderTextWithMentions(
  raw: string,
  { me, colorFor }: RenderDeps,
  keyPrefix: string,
): ReactNode[] {
  const out: ReactNode[] = [];
  MENTION_RE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = MENTION_RE.exec(raw)) !== null) {
    if (m.index > last) {
      out.push(
        <span key={`${keyPrefix}-t${idx++}`}>{raw.slice(last, m.index)}</span>,
      );
    }
    out.push(
      <strong key={`${keyPrefix}-m${idx++}`} fg={colorFor(m[1])}>
        @{m[1]}
      </strong>,
    );
    last = m.index + m[0].length;
  }
  if (last < raw.length) {
    out.push(<span key={`${keyPrefix}-t${idx++}`}>{raw.slice(last)}</span>);
  }
  return out;
}

function renderInline(
  tokens: Token[],
  deps: RenderDeps,
  keyPrefix: string,
): ReactNode[] {
  const out: ReactNode[] = [];
  tokens.forEach((tok, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (tok.type) {
      case "text": {
        const t = tok as Tokens.Text;
        if (t.tokens && t.tokens.length > 0) {
          out.push(...renderInline(t.tokens, deps, key));
        } else {
          out.push(...renderTextWithMentions(t.text, deps, key));
        }
        break;
      }
      case "strong": {
        const t = tok as Tokens.Strong;
        out.push(
          <strong key={key} fg="#ffffff">
            {renderInline(t.tokens, deps, key)}
          </strong>,
        );
        break;
      }
      case "em": {
        const t = tok as Tokens.Em;
        out.push(
          <em key={key} fg="#d8c8ff">
            {renderInline(t.tokens, deps, key)}
          </em>,
        );
        break;
      }
      case "codespan": {
        const t = tok as Tokens.Codespan;
        out.push(
          <span key={key} fg="#ffbb4d">
            `{t.text}`
          </span>,
        );
        break;
      }
      case "del": {
        const t = tok as Tokens.Del;
        out.push(
          <span key={key} fg="#6c6c6c">
            {renderInline(t.tokens, deps, key)}
          </span>,
        );
        break;
      }
      case "link": {
        const t = tok as Tokens.Link;
        out.push(
          <u key={key} fg="#8db8ff">
            {renderInline(t.tokens, deps, key)}
          </u>,
        );
        if (t.href && t.href !== t.text) {
          out.push(
            <span key={`${key}-href`} fg="#555">
              {" ("}
              {t.href}
              {")"}
            </span>,
          );
        }
        break;
      }
      case "br": {
        out.push(<span key={key}> </span>);
        break;
      }
      case "escape": {
        const t = tok as Tokens.Escape;
        out.push(<span key={key}>{t.text}</span>);
        break;
      }
      case "html": {
        const t = tok as Tokens.HTML;
        out.push(
          <span key={key} fg="#666">
            {t.text}
          </span>,
        );
        break;
      }
      default: {
        const raw = (tok as { text?: string; raw?: string }).text
          ?? (tok as { raw?: string }).raw
          ?? "";
        if (raw) {
          out.push(...renderTextWithMentions(raw, deps, key));
        }
      }
    }
  });
  return out;
}

export function InlineTokenRun({
  tokens,
  me,
  colorFor,
}: { tokens: Token[] } & RenderDeps) {
  return <>{renderInline(tokens, { me, colorFor }, "inl")}</>;
}

function CodeBlockView({ lang, lines }: { lang: string; lines: string[] }) {
  const visible = lines.slice(0, COLLAPSE_THRESHOLD);
  const hidden = lines.length - visible.length;
  const title = lang ? ` ${lang} ` : " code ";
  return (
    <box
      border
      borderColor="#333"
      backgroundColor="#0e0e0e"
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      title={title}
      titleAlignment="left"
    >
      {visible.length === 0 && <text fg="#6c6c6c">(empty)</text>}
      {visible.map((line, i) => (
        <text key={i} fg="#d0d0d0">
          {line.length === 0 ? " " : line}
        </text>
      ))}
      {hidden > 0 && (
        <text fg="#6c6c6c">
          <span>
            … {hidden} more line{hidden === 1 ? "" : "s"} hidden
          </span>
        </text>
      )}
    </box>
  );
}

function DiffBlockView({ lines }: { lines: string[] }) {
  const visible = lines.slice(0, COLLAPSE_THRESHOLD);
  const hidden = lines.length - visible.length;
  return (
    <box
      border
      borderColor="#333"
      backgroundColor="#0e0e0e"
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      title=" diff "
      titleAlignment="left"
    >
      {visible.map((line, i) => {
        let fg = "#a0a0a0";
        if (
          line.startsWith("+++") ||
          line.startsWith("---") ||
          line.startsWith("diff --git") ||
          line.startsWith("index ")
        ) {
          fg = "#6c6c6c";
        } else if (line.startsWith("@@")) {
          fg = "#d8a0ff";
        } else if (line.startsWith("+")) {
          fg = "#7ee3a0";
        } else if (line.startsWith("-")) {
          fg = "#ff8a8a";
        }
        return (
          <text key={i} fg={fg}>
            {line.length === 0 ? " " : line}
          </text>
        );
      })}
      {hidden > 0 && (
        <text fg="#6c6c6c">
          <span>
            … {hidden} more line{hidden === 1 ? "" : "s"} hidden
          </span>
        </text>
      )}
    </box>
  );
}

function ListItemBody({
  item,
  deps,
  keyPrefix,
}: { item: Tokens.ListItem; deps: RenderDeps; keyPrefix: string }) {
  const children: ReactNode[] = [];
  item.tokens.forEach((tok, i) => {
    const k = `${keyPrefix}-${i}`;
    if (tok.type === "text") {
      const t = tok as Tokens.Text;
      const inline = t.tokens
        ? renderInline(t.tokens, deps, k)
        : renderTextWithMentions(t.text, deps, k);
      children.push(<text key={k}>{inline}</text>);
    } else {
      children.push(<BlockRenderer key={k} block={tok} deps={deps} />);
    }
  });
  return <>{children}</>;
}

function HeadingView({
  block,
  deps,
}: { block: Tokens.Heading; deps: RenderDeps }) {
  const prefix = "#".repeat(block.depth);
  return (
    <text>
      <span fg="#6a9fff">{prefix} </span>
      <strong fg="#cbe3ff">
        {renderInline(block.tokens, deps, "h")}
      </strong>
    </text>
  );
}

function ParagraphView({
  block,
  deps,
}: { block: Tokens.Paragraph; deps: RenderDeps }) {
  return <text>{renderInline(block.tokens, deps, "p")}</text>;
}

function ListView({
  block,
  deps,
}: { block: Tokens.List; deps: RenderDeps }) {
  const startNum =
    block.start === "" || block.start === undefined ? 1 : Number(block.start);
  return (
    <box flexDirection="column">
      {block.items.map((item, i) => {
        const marker = block.ordered ? `${startNum + i}.` : "•";
        return (
          <box key={i} flexDirection="row">
            <text>
              <span fg="#ffd66b">{marker} </span>
            </text>
            <box flexGrow={1} flexDirection="column">
              <ListItemBody
                item={item}
                deps={deps}
                keyPrefix={`li${i}`}
              />
            </box>
          </box>
        );
      })}
    </box>
  );
}

function TableView({
  block,
  deps,
}: { block: Tokens.Table; deps: RenderDeps }) {
  const nCols = block.header.length;
  return (
    <box
      border
      borderColor="#444"
      paddingLeft={1}
      paddingRight={1}
      flexDirection="row"
    >
      {Array.from({ length: nCols }, (_, c) => (
        <box
          key={c}
          flexDirection="column"
          marginLeft={c === 0 ? 0 : 2}
        >
          <text>
            <strong fg="#cbe3ff">
              {renderInline(block.header[c].tokens, deps, `th${c}`)}
            </strong>
          </text>
          <box height={1} backgroundColor="#333" marginTop={0} marginBottom={0} />
          {block.rows.map((row, r) => {
            const cell = row[c];
            if (!cell) return <text key={r}> </text>;
            return (
              <text key={r}>
                {renderInline(cell.tokens, deps, `td${r}${c}`)}
              </text>
            );
          })}
        </box>
      ))}
    </box>
  );
}

function BlockquoteView({
  block,
  deps,
}: { block: Tokens.Blockquote; deps: RenderDeps }) {
  return (
    <box flexDirection="row">
      <text>
        <span fg="#555">▍ </span>
      </text>
      <box flexGrow={1} flexDirection="column">
        {block.tokens.map((t, i) => (
          <BlockRenderer key={i} block={t} deps={deps} />
        ))}
      </box>
    </box>
  );
}

function BlockRenderer({
  block,
  deps,
}: { block: Token; deps: RenderDeps }) {
  switch (block.type) {
    case "heading":
      return <HeadingView block={block as Tokens.Heading} deps={deps} />;
    case "paragraph":
      return <ParagraphView block={block as Tokens.Paragraph} deps={deps} />;
    case "code": {
      const b = block as Tokens.Code;
      const lang = (b.lang ?? "").toLowerCase();
      if (lang === "diff" || lang === "patch") {
        return <DiffBlockView lines={b.text.split("\n")} />;
      }
      return <CodeBlockView lang={b.lang ?? ""} lines={b.text.split("\n")} />;
    }
    case "list":
      return <ListView block={block as Tokens.List} deps={deps} />;
    case "table":
      return <TableView block={block as Tokens.Table} deps={deps} />;
    case "blockquote":
      return <BlockquoteView block={block as Tokens.Blockquote} deps={deps} />;
    case "hr":
      return (
        <text fg="#333">
          ──────────────────────────────────────────
        </text>
      );
    case "space":
      return null;
    case "html": {
      const b = block as Tokens.HTML;
      return <text fg="#666">{b.text}</text>;
    }
    default: {
      const raw =
        (block as { text?: string }).text ??
        (block as { raw?: string }).raw ??
        "";
      return <text>{raw}</text>;
    }
  }
}

export function ContentView({
  text,
  me,
  colorFor,
}: { text: string } & RenderDeps) {
  const tokens = parse(text);
  return (
    <box flexDirection="column">
      {tokens.map((b, i) => (
        <BlockRenderer key={i} block={b} deps={{ me, colorFor }} />
      ))}
    </box>
  );
}
