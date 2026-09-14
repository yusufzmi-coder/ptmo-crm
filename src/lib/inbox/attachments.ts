/**
 * Which files the composer accepts, and how a dropped or pasted one is
 * classified.
 *
 * The file picker already had this list inline, but a picker only ever
 * needs to *offer* types — the user picks under a menu that already said
 * "Photo" or "Document", so the kind is known before the file is. Drag
 * and paste invert that: the file arrives first and the kind has to be
 * derived from it. Both paths read the same table here so a type the
 * picker offers can never be one a drop rejects.
 *
 * Mirrors the chat-media bucket's allowed_mime_types (migration 023).
 */

/** Kinds a file can be classified as. Audio is excluded deliberately —
 *  it is captured by the recorder, never picked or dropped. */
export type AttachableKind = "image" | "video" | "document";

export const ACCEPTED_MIME: Record<AttachableKind, readonly string[]> = {
  image: ["image/png", "image/jpeg", "image/webp"],
  video: ["video/mp4", "video/3gpp"],
  document: [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain",
  ],
};

/** `accept=` strings for the hidden file inputs, derived from the table
 *  above so the picker and the drop target cannot drift apart. */
export const PICKER_ACCEPT: Record<AttachableKind, string> = {
  image: ACCEPTED_MIME.image.join(","),
  video: ACCEPTED_MIME.video.join(","),
  document: ACCEPTED_MIME.document.join(","),
};

/**
 * Classify a dropped/pasted file, or return null when the bucket would
 * refuse it. Matching on `file.type` alone (not the extension) because
 * that is what Storage validates against — agreeing with it here is what
 * lets us reject before upload instead of after.
 *
 * A clipboard screenshot arrives as image/png on every OS we support, so
 * the common evidence-paste case lands in `image` without special-casing.
 */
export function kindForFile(file: File): AttachableKind | null {
  // Some browsers append parameters, e.g. "text/plain;charset=utf-8".
  const mime = file.type.split(";")[0]!.trim().toLowerCase();
  if (!mime) return null;
  for (const kind of ["image", "video", "document"] as const) {
    if (ACCEPTED_MIME[kind].includes(mime)) return kind;
  }
  return null;
}

/**
 * Pick the one file to stage out of a drop or paste that may carry
 * several. The composer stages a single attachment at a time, so this
 * returns the first acceptable file rather than silently taking the last
 * or refusing the whole drop because one item was unsupported.
 *
 * Returns null when nothing in the batch is acceptable — the caller
 * distinguishes "nothing usable" (tell the user) from "no files at all"
 * (a plain text paste; leave it to the textarea).
 */
export function firstAttachable(
  files: readonly File[],
): { file: File; kind: AttachableKind } | null {
  for (const file of files) {
    const kind = kindForFile(file);
    if (kind) return { file, kind };
  }
  return null;
}
