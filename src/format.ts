import {
  type AdapterPostableMessage,
  BaseFormatConverter,
  type Content,
  isTableNode,
  parseMarkdown,
  type Root,
  tableToAscii,
} from "chat";

/**
 * Live Chat shows plain text: in the website widget, in LINE and in email
 * replies. Incoming text is read as Markdown (visitors type plain text, so
 * it parses to plain paragraphs); outgoing Markdown is flattened to
 * readable plain text: emphasis is dropped, links become "text (url)",
 * lists keep their bullets and tables become fixed-width text.
 */
export class HibiraFormatConverter extends BaseFormatConverter {
  toAst(platformText: string): Root {
    return parseMarkdown(platformText);
  }

  fromAst(ast: Root): string {
    return this.fromAstWithNodeConverter(ast, (node) => this.nodeToText(node))
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /** Cards have no widget equivalent, so they are sent as their fallback text. */
  override renderPostable(message: AdapterPostableMessage): string {
    const text = super.renderPostable(message);
    const isCard =
      typeof message === "object" &&
      message !== null &&
      ("card" in message || ("type" in message && message.type === "card"));
    return isCard ? this.fromMarkdown(text) : text;
  }

  private nodeToText(node: Content): string {
    const children = (n: { children: Content[] }) =>
      n.children.map((c) => this.nodeToText(c)).join("");
    switch (node.type) {
      case "link": {
        const label = children(node).trim();
        if (!label || label === node.url || `mailto:${label}` === node.url) {
          return node.url.replace(/^mailto:/, "");
        }
        return `${label} (${node.url})`;
      }
      case "image":
        return node.alt ? `${node.alt} (${node.url})` : node.url;
      case "inlineCode":
        return node.value;
      case "code":
        return node.value;
      case "break":
        return "\n";
      case "thematicBreak":
        return "———";
      case "heading":
      case "paragraph":
        return children(node);
      case "blockquote":
        return node.children
          .map((c) => this.nodeToText(c))
          .join("\n\n")
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
      case "list":
        return this.renderList(node, 0, (n) => this.nodeToText(n), "•");
      case "listItem":
        return node.children.map((c) => this.nodeToText(c)).join("\n");
      case "html":
        return node.value;
      default:
        if (isTableNode(node)) {
          return tableToAscii(node);
        }
        return this.defaultNodeToText(node, (n) => this.nodeToText(n));
    }
  }
}
