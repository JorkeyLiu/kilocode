import type { Part } from "../types/messages"
import type { ReviewComment } from "../types/messages"
import type { ImageAttachment } from "../hooks/useImageAttachments"
import { partReview } from "../../../src/shared/review-comments"

export interface PullBackContent {
  /** User draft text with any review-comment prefix stripped. */
  text: string
  /** Data-URL image parts converted to composer image attachments. */
  images: ImageAttachment[]
  /** Source paths of file parts that are not restored as image attachments. */
  paths: string[]
  /** Review comments carried by the message's text part metadata. */
  review: ReviewComment[]
}

/**
 * Extract everything needed to restore a queued user message into the
 * composer: the draft text (review prefix split out), image attachments
 * (data-URL FileParts converted to ImageAttachment, mirroring restoreFailed),
 * file mention paths (non-image file parts), and review comments
 * (TextPart metadata.kilo.review). Pure — no store or window access.
 */
export function capturePullBack(parts: Part[]): PullBackContent {
  let text = ""
  const images: ImageAttachment[] = []
  const paths: string[] = []
  const review: ReviewComment[] = []
  for (const part of parts) {
    if (part.type === "text" && !part.synthetic) {
      const view = partReview(part.metadata, part.text)
      if (view) {
        // Append comments from every text part that carries review metadata —
        // a queued message may span multiple review blocks, and dropping the
        // later ones would silently lose user context on pull-back.
        review.push(...view.data.comments)
        text += view.body
      } else {
        text += part.text
      }
    } else if (part.type === "file") {
      if (part.mime.startsWith("image/") && part.url.startsWith("data:")) {
        images.push({
          id: crypto.randomUUID(),
          filename: part.filename ?? "image",
          mime: part.mime,
          dataUrl: part.url,
        })
      } else if (part.source?.path) {
        paths.push(part.source.path)
      }
    }
  }
  return { text, images, paths, review }
}
