import type { InteractiveMessagePayload } from "@/types";

/**
 * How a one-line preview of an interactive payload should be rendered.
 *
 * Why this exists as a separate step
 * ----------------------------------
 * `interactivePayloadPreviewText()` in lib/whatsapp/interactive.ts
 * returns `'[buttons]'` / `'[list]'` when a payload has no body, and
 * three panels rendered that literal straight to the user — English, in
 * an otherwise translated UI.
 *
 * The fix is NOT to translate that function. It is also called by
 * `send-message.ts`, which writes its result into
 * `conversations.last_message_text` — a STORED column. Translating the
 * function would put locale-dependent strings in the database, read back
 * by every other user, not just the one who wrote it. That value must
 * stay locale-free.
 *
 * So the function keeps returning a sentinel, and this decides at RENDER
 * time whether the caller has real text to show or a placeholder to
 * translate. Callers pair it with `interactivePreviewLabelKey`.
 *
 * Drift guard: this deliberately mirrors the same "body, trimmed, else
 * fall back" rule rather than string-matching the sentinel — matching
 * `'[buttons]'` would misfire on a payload whose body is literally that.
 * `interactive-preview.test.ts` pins the two functions to each other so
 * a change to one without the other fails the suite.
 */
export type InteractivePreview =
  | { kind: "text"; text: string }
  | { kind: "empty"; label: InteractivePreviewLabel };

/** Which placeholder an empty payload needs. */
export type InteractivePreviewLabel = "buttons" | "list";

export function interactivePreview(
  payload: InteractiveMessagePayload,
): InteractivePreview {
  const body = payload.body?.trim();
  if (body) return { kind: "text", text: body };
  return {
    kind: "empty",
    label: payload.kind === "buttons" ? "buttons" : "list",
  };
}

/**
 * Translation key for a placeholder, under the top-level `Interactive`
 * namespace. That namespace is deliberately not nested under Inbox /
 * Settings / Automations: all three render this same preview, and a key
 * living in one of their trees would read as that panel's property.
 */
export function interactivePreviewLabelKey(
  label: InteractivePreviewLabel,
): string {
  return label === "buttons" ? "emptyButtons" : "emptyList";
}

/**
 * One-line preview ready to render: the payload's own text, or the
 * translated placeholder. `t` must be bound to the `Interactive`
 * namespace.
 *
 * This is what the three panels call, so the decision lives in one
 * place and they cannot drift into three different placeholder
 * wordings.
 */
export function interactivePreviewText(
  payload: InteractiveMessagePayload,
  t: (key: string) => string,
): string {
  const preview = interactivePreview(payload);
  return preview.kind === "text"
    ? preview.text
    : t(interactivePreviewLabelKey(preview.label));
}
