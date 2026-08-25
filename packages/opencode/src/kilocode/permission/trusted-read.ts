const TrustedReadBrand = Symbol("TrustedReadBrand")
export type TrustedReadCapability = { readonly __trustedReadBrand: true } & { readonly [TrustedReadBrand]?: true }
export function createTrustedReadCapability(): TrustedReadCapability {
  return { [TrustedReadBrand]: true, __trustedReadBrand: true } as unknown as TrustedReadCapability
}
export function isTrustedReadCapability(v: unknown): v is TrustedReadCapability {
  return typeof v === "object" && v !== null && TrustedReadBrand in (v as object) && (v as any)[TrustedReadBrand] === true && (v as any).__trustedReadBrand === true
}
