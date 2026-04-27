import { marked, type Token, type Tokens } from "marked";
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { newMentionRegex } from "./protocol.ts";

marked.use({ gfm: true, breaks: false });

const COLLAPSE_THRESHOLD = 30;

// Keep this in sync with parseMentions by reusing the same factory — the
// previous local copy lacked \w in its lookahead, which let `@scope/pkg`
// backtrack to color `@scop` etc.
const MENTION_RE = newMentionRegex();

type RenderDeps = {
  me: string;
  colorFor: (who: string) => string;
  // Returns true only for names that have actually been in the room this
  // session (plus the literal "all"). Filters out lookalikes such as the
  // `@latest` in an npm install command — they match the @-name pattern
  // but aren't pings.
  isParticipant: (who: string) => boolean;
};

function parse(text: string): Token[] {
  return marked.lexer(text);
}

function renderTextWithMentions(
  raw: string,
  { colorFor, isParticipant }: RenderDeps,
  keyPrefix: string,
): ReactNode[] {
  const out: ReactNode[] = [];
  MENTION_RE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = MENTION_RE.exec(raw)) !== null) {
    if (!isParticipant(m[1])) continue;
    if (m.index > last) {
      out.push(
        <Text key={`${keyPrefix}-t${idx++}`}>{raw.slice(last, m.index)}</Text>,
      );
    }
    out.push(
      <Text key={`${keyPrefix}-m${idx++}`} bold color={colorFor(m[1])}>
        @{m[1]}
      </Text>,
    );
    last = m.index + m[0].length;
  }
  if (last < raw.length) {
    out.push(<Text key={`${keyPrefix}-t${idx++}`}>{raw.slice(last)}</Text>);
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
          <Text key={key} bold color="white">
            {renderInline(t.tokens, deps, key)}
          </Text>,
        );
        break;
      }
      case "em": {
        const t = tok as Tokens.Em;
        out.push(
          <Text key={key} italic color="#d8c8ff">
            {renderInline(t.tokens, deps, key)}
          </Text>,
        );
        break;
      }
      case "codespan": {
        const t = tok as Tokens.Codespan;
        out.push(
          <Text key={key} color="#ffbb4d">
            `{t.text}`
          </Text>,
        );
        break;
      }
      case "del": {
        const t = tok as Tokens.Del;
        out.push(
          <Text key={key} strikethrough>
            {renderInline(t.tokens, deps, key)}
          </Text>,
        );
        break;
      }
      case "link": {
        const t = tok as Tokens.Link;
        out.push(
          <Text key={key} underline color="#8db8ff">
            {renderInline(t.tokens, deps, key)}
          </Text>,
        );
        if (t.href && t.href !== t.text) {
          out.push(
            <Text key={`${key}-href`} dimColor>
              {" ("}
              {t.href}
              {")"}
            </Text>,
          );
        }
        break;
      }
      case "br":
        out.push(<Text key={key}> </Text>);
        break;
      case "escape": {
        const t = tok as Tokens.Escape;
        out.push(<Text key={key}>{t.text}</Text>);
        break;
      }
      case "html": {
        const t = tok as Tokens.HTML;
        out.push(
          <Text key={key} dimColor>
            {t.text}
          </Text>,
        );
        break;
      }
      default: {
        const raw =
          (tok as { text?: string; raw?: string }).text ??
          (tok as { raw?: string }).raw ??
          "";
        if (raw) {
          out.push(...renderTextWithMentions(raw, deps, key));
        }
      }
    }
  });
  return out;
}

function CodeBlockView({ lang, lines }: { lang: string; lines: string[] }) {
  const visible = lines.slice(0, COLLAPSE_THRESHOLD);
  const hidden = lines.length - visible.length;
  const label = lang || "code";
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="#333"
      paddingX={1}
    >
      <Text dimColor>─ {label} ─</Text>
      {visible.length === 0 && <Text dimColor>(empty)</Text>}
      {visible.map((line, i) => (
        <Text key={i} color="#d0d0d0">
          {line.length === 0 ? " " : line}
        </Text>
      ))}
      {hidden > 0 && (
        <Text dimColor>
          … {hidden} more line{hidden === 1 ? "" : "s"} hidden
        </Text>
      )}
    </Box>
  );
}

function DiffBlockView({ lines }: { lines: string[] }) {
  const visible = lines.slice(0, COLLAPSE_THRESHOLD);
  const hidden = lines.length - visible.length;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="#333"
      paddingX={1}
    >
      <Text dimColor>─ diff ─</Text>
      {visible.map((line, i) => {
        let color: string | undefined = "#a0a0a0";
        if (
          line.startsWith("+++") ||
          line.startsWith("---") ||
          line.startsWith("diff --git") ||
          line.startsWith("index ")
        ) {
          color = "#6c6c6c";
        } else if (line.startsWith("@@")) {
          color = "#d8a0ff";
        } else if (line.startsWith("+")) {
          color = "#7ee3a0";
        } else if (line.startsWith("-")) {
          color = "#ff8a8a";
        }
        return (
          <Text key={i} color={color}>
            {line.length === 0 ? " " : line}
          </Text>
        );
      })}
      {hidden > 0 && (
        <Text dimColor>
          … {hidden} more line{hidden === 1 ? "" : "s"} hidden
        </Text>
      )}
    </Box>
  );
}

function ListItemBody({
  item,
  deps,
  keyPrefix,
}: {
  item: Tokens.ListItem;
  deps: RenderDeps;
  keyPrefix: string;
}) {
  const children: ReactNode[] = [];
  item.tokens.forEach((tok, i) => {
    const k = `${keyPrefix}-${i}`;
    if (tok.type === "text") {
      const t = tok as Tokens.Text;
      const inline = t.tokens
        ? renderInline(t.tokens, deps, k)
        : renderTextWithMentions(t.text, deps, k);
      children.push(<Text key={k}>{inline}</Text>);
    } else {
      children.push(<BlockRenderer key={k} block={tok} deps={deps} />);
    }
  });
  return <>{children}</>;
}

function HeadingView({
  block,
  deps,
}: {
  block: Tokens.Heading;
  deps: RenderDeps;
}) {
  const prefix = "#".repeat(block.depth);
  return (
    <Text>
      <Text color="#6a9fff">{prefix} </Text>
      <Text bold color="#cbe3ff">
        {renderInline(block.tokens, deps, "h")}
      </Text>
    </Text>
  );
}

function ParagraphView({
  block,
  deps,
}: {
  block: Tokens.Paragraph;
  deps: RenderDeps;
}) {
  return <Text>{renderInline(block.tokens, deps, "p")}</Text>;
}

function ListView({ block, deps }: { block: Tokens.List; deps: RenderDeps }) {
  const startNum =
    block.start === "" || block.start === undefined ? 1 : Number(block.start);
  return (
    <Box flexDirection="column">
      {block.items.map((item, i) => {
        const marker = block.ordered ? `${startNum + i}.` : "•";
        return (
          <Box key={i} flexDirection="row">
            <Text color="#ffd66b">{marker} </Text>
            <Box flexGrow={1} flexDirection="column">
              <ListItemBody item={item} deps={deps} keyPrefix={`li${i}`} />
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function TableView({ block, deps }: { block: Tokens.Table; deps: RenderDeps }) {
  const nCols = block.header.length;
  return (
    <Box borderStyle="round" borderColor="#444" flexDirection="row" paddingX={1}>
      {Array.from({ length: nCols }, (_, c) => (
        <Box
          key={c}
          flexDirection="column"
          marginLeft={c === 0 ? 0 : 2}
        >
          <Text bold color="#cbe3ff">
            {renderInline(block.header[c].tokens, deps, `th${c}`)}
          </Text>
          <Text dimColor>───</Text>
          {block.rows.map((row, r) => {
            const cell = row[c];
            return (
              <Text key={r}>
                {cell ? renderInline(cell.tokens, deps, `td${r}${c}`) : " "}
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

function BlockquoteView({
  block,
  deps,
}: {
  block: Tokens.Blockquote;
  deps: RenderDeps;
}) {
  return (
    <Box flexDirection="row">
      <Text dimColor>▍ </Text>
      <Box flexGrow={1} flexDirection="column">
        {block.tokens.map((t, i) => (
          <BlockRenderer key={i} block={t} deps={deps} />
        ))}
      </Box>
    </Box>
  );
}

function BlockRenderer({ block, deps }: { block: Token; deps: RenderDeps }) {
  switch (block.type) {
    case "heading":
      return <HeadingView block={block as Tokens.Heading} deps={deps} />;
    case "paragraph":
      return <ParagraphView block={block as Tokens.Paragraph} deps={deps} />;
    case "code": {
      const b = block as Tokens.Code;
      const lang = (b.lang ?? "").toLowerCase();
      if (lang === "diff" || lang === "patch")
        return <DiffBlockView lines={b.text.split("\n")} />;
      return <CodeBlockView lang={b.lang ?? ""} lines={b.text.split("\n")} />;
    }
    case "list":
      return <ListView block={block as Tokens.List} deps={deps} />;
    case "table":
      return <TableView block={block as Tokens.Table} deps={deps} />;
    case "blockquote":
      return <BlockquoteView block={block as Tokens.Blockquote} deps={deps} />;
    case "hr":
      return <Text dimColor>──────────────────────────────────────────</Text>;
    case "space":
      return null;
    case "html": {
      const b = block as Tokens.HTML;
      return <Text dimColor>{b.text}</Text>;
    }
    default: {
      const raw =
        (block as { text?: string }).text ??
        (block as { raw?: string }).raw ??
        "";
      return <Text>{raw}</Text>;
    }
  }
}

export function ContentView({
  text,
  me,
  colorFor,
  isParticipant,
}: { text: string } & RenderDeps) {
  const tokens = parse(text);
  return (
    <Box flexDirection="column">
      {tokens.map((b, i) => (
        <BlockRenderer
          key={i}
          block={b}
          deps={{ me, colorFor, isParticipant }}
        />
      ))}
    </Box>
  );
}
