// No second authority remains. The dormant legacy helper
// that used a second permission decision implementation has been removed.
// All active drains use Evaluator.evaluate via permission/index.ts.
export const _noLegacyAuthority = true as const
