// Profile types from kilo-gateway
export interface KilocodeBalance {
  balance: number
}

export interface KiloPassState {
  currentPeriodBaseCreditsUsd: number
  currentPeriodUsageUsd: number
  currentPeriodBonusCreditsUsd: number
  nextBillingAt?: string | null
}

export interface ProfileData {
  profile: {
    email: string
    name?: string
    organizations?: Array<{ id: string; name: string; role: string }>
    selectedOrganizationId?: string
    hasPersonalAccount?: boolean
  }
  balance: KilocodeBalance | null
  kiloPass: KiloPassState | null
  currentOrgId: string | null
}
