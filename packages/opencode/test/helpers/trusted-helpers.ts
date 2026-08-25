// test-only helpers for trusted capabilities; not exported via package.json
// This file is intentionally under test/ so it is not part of the public package surface.
// Production code imports directly via alias @/kilocode/... ; tests import via this helper.

import { createTrustedReadCapability } from "@/kilocode/permission/trusted-read"
import { __testCreateTrustedAgentContext } from "@/kilocode/session/trusted-gate"

export const createTestTrustedReadCapability = createTrustedReadCapability
export const createTestTrustedAgentContext = __testCreateTrustedAgentContext
