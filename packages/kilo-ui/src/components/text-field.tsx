export * from "@opencode-ai/ui/text-field"

// Re-export Kobalte TextField primitives for local compositions that need
// direct access to sub-components (e.g. placing trailing actions inside input-wrapper).
export { TextField as TextFieldRoot } from "@kobalte/core/text-field"
export type * from "@kobalte/core/text-field"
