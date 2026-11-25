import type { LinkParts } from "./parts.ts";
import type { ReactNode } from "react";

export function ButtonLink(parts: LinkParts): ReactNode {
  return (
    <a
      className="self-start rounded-md border bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
      href={parts.href}
    >
      {parts.children}
    </a>
  );
}
