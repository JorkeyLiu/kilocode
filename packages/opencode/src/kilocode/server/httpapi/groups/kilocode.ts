import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"
import {
  CustomProviderSaveAuthSchema,
  CustomProviderSaveConfigSchema,
} from "@/kilocode/server/custom-provider-save"
import { AnacondaDesktopApi } from "./anaconda-desktop"
import { Result as AgentRequirementResult } from "@/kilocode/agent-requirements"
import {
  Failure as AgentManagerFailure,
  Request as AgentManagerRequest,
  RequestID as AgentManagerRequestID,
  Result as AgentManagerResult,
} from "@/kilocode/agent-manager/protocol"
import {
  Failure as NotebookFailure,
  Request as NotebookRequest,
  RequestID as NotebookRequestID,
  Result as NotebookResult,
} from "@/kilocode/notebook/protocol"
import { ModelUsage } from "@/kilocode/session/model-usage"
import { SessionID } from "@/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"

const root = "/kilocode"

export const RemoveSkillPayload = Schema.Struct({
  location: Schema.String,
})

export const RemoveAgentPayload = Schema.Struct({
  name: Schema.String,
})

export const AgentRequirementQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  agent: Schema.String,
})
export const NotebookReplyPayload = Schema.Struct({ result: NotebookResult })
export const NotebookRejectPayload = Schema.Struct({ error: NotebookFailure })
export const AgentManagerReplyPayload = Schema.Struct({ result: AgentManagerResult })
export const AgentManagerRejectPayload = Schema.Struct({ error: AgentManagerFailure })

// LOCK-001/003: canonical custom-provider deletion route. The endpoint lives in
// an instance-authorized group (Authorization + InstanceContextMiddleware +
// WorkspaceRoutingMiddleware) so the directory/worktree the handler passes to
// the deletion service is derived from the trusted InstanceRef, never from an
// arbitrary raw query value in the root control group.
const CustomProviderDeleteParams = Schema.Struct({
  providerID: ProviderV2.ID,
})

const CustomProviderDeleteResult = Schema.Struct({
  success: Schema.Boolean,
}).annotate({ identifier: "CustomProviderDeleteResult" })

/** Structured non-2xx deletion failure preserving safe code/message/detail (LOCK-003). */
export class CustomProviderDeleteFailure extends Schema.ErrorClass<CustomProviderDeleteFailure>(
  "CustomProviderDeleteError",
)(
  {
    code: Schema.String,
    message: Schema.String,
    detail: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

// LOCK-001: canonical custom-provider save route — same trusted instance group
// as deletion. The request contains the validated custom provider config plus
// the auth mode union preserve | set(key) | clear; the response is
// `{ success: true }` with a structured safe 400.
const CustomProviderSaveParams = Schema.Struct({
  providerID: ProviderV2.ID,
})

export const CustomProviderSaveBody = Schema.Struct({
  config: CustomProviderSaveConfigSchema,
  auth: CustomProviderSaveAuthSchema,
})

const CustomProviderSaveResult = Schema.Struct({
  success: Schema.Boolean,
}).annotate({ identifier: "CustomProviderSaveResult" })

/** Structured non-2xx save failure preserving safe code/message/detail (LOCK-003). */
export class CustomProviderSaveFailure extends Schema.ErrorClass<CustomProviderSaveFailure>(
  "CustomProviderSaveError",
)(
  {
    code: Schema.String,
    message: Schema.String,
    detail: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export const KilocodePaths = {
  heapSnapshot: `${root}/heap/snapshot`,
  agentRequirements: `${root}/agent/requirements`,
  removeSkill: `${root}/skill/remove`,
  removeAgent: `${root}/agent/remove`,
  notebookList: `${root}/notebook`,
  notebookReply: `${root}/notebook/:requestID/reply`,
  notebookReject: `${root}/notebook/:requestID/reject`,
  agentManagerList: `${root}/agent-manager`,
  agentManagerReply: `${root}/agent-manager/:requestID/reply`,
  agentManagerReject: `${root}/agent-manager/:requestID/reject`,
  sessionModelUsage: `/session/:sessionID/model-usage`,
  customProviderDelete: "/custom-provider/:providerID/delete",
  customProviderSave: "/custom-provider/:providerID/save",
} as const

export const KilocodeApi = HttpApi.make("kilocode")
  .add(
    HttpApiGroup.make("kilocode")
      .add(
        HttpApiEndpoint.post("heapSnapshot", KilocodePaths.heapSnapshot, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.String, "Heap snapshot file path"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.heap.snapshot",
            summary: "Write heap snapshot",
            description: "Write a heap snapshot for the CLI process to the log directory.",
          }),
        ),
        HttpApiEndpoint.get("agentRequirements", KilocodePaths.agentRequirements, {
          query: AgentRequirementQuery,
          success: described(AgentRequirementResult, "Agent requirement status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.agentRequirements",
            summary: "Check agent requirements",
            description: "Check whether the selected agent's requirements are available in the request directory.",
          }),
        ),
        HttpApiEndpoint.post("removeSkill", KilocodePaths.removeSkill, {
          query: WorkspaceRoutingQuery,
          payload: RemoveSkillPayload,
          success: described(Schema.Boolean, "Skill removed"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.removeSkill",
            summary: "Remove a skill",
            description: "Remove a skill by deleting its manifest from disk and clearing it from cache.",
          }),
        ),
        HttpApiEndpoint.post("removeAgent", KilocodePaths.removeAgent, {
          query: WorkspaceRoutingQuery,
          payload: RemoveAgentPayload,
          success: described(Schema.Boolean, "Agent removed"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.removeAgent",
            summary: "Remove a custom agent",
            description:
              "Remove a custom (non-native) agent by deleting its markdown file from disk and refreshing state.",
          }),
        ),
        HttpApiEndpoint.get("notebookList", KilocodePaths.notebookList, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(NotebookRequest), "Pending notebook host requests"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.notebook.list",
            summary: "List pending notebook requests",
            description: "List pending native notebook requests for the routed workspace.",
          }),
        ),
        HttpApiEndpoint.post("notebookReply", KilocodePaths.notebookReply, {
          params: { requestID: NotebookRequestID },
          query: WorkspaceRoutingQuery,
          payload: NotebookReplyPayload,
          success: described(Schema.Boolean, "Notebook reply accepted"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.notebook.reply",
            summary: "Reply to a notebook request",
            description: "Complete a pending native notebook request with a structured result.",
          }),
        ),
        HttpApiEndpoint.post("notebookReject", KilocodePaths.notebookReject, {
          params: { requestID: NotebookRequestID },
          query: WorkspaceRoutingQuery,
          payload: NotebookRejectPayload,
          success: described(Schema.Boolean, "Notebook rejection accepted"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.notebook.reject",
            summary: "Reject a notebook request",
            description: "Complete a pending native notebook request with a structured host error.",
          }),
        ),
        HttpApiEndpoint.get("agentManagerList", KilocodePaths.agentManagerList, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(AgentManagerRequest), "Pending Agent Manager host requests"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.agentManager.list",
            summary: "List pending Agent Manager requests",
            description: "List pending native Agent Manager orchestration requests for the routed workspace.",
          }),
        ),
        HttpApiEndpoint.post("agentManagerReply", KilocodePaths.agentManagerReply, {
          params: { requestID: AgentManagerRequestID },
          query: WorkspaceRoutingQuery,
          payload: AgentManagerReplyPayload,
          success: described(Schema.Boolean, "Agent Manager reply accepted"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.agentManager.reply",
            summary: "Reply to an Agent Manager request",
            description: "Complete a pending Agent Manager orchestration request with a structured result.",
          }),
        ),
        HttpApiEndpoint.post("agentManagerReject", KilocodePaths.agentManagerReject, {
          params: { requestID: AgentManagerRequestID },
          query: WorkspaceRoutingQuery,
          payload: AgentManagerRejectPayload,
          success: described(Schema.Boolean, "Agent Manager rejection accepted"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.agentManager.reject",
            summary: "Reject an Agent Manager request",
            description: "Complete a pending Agent Manager orchestration request with a structured host error.",
          }),
        ),
        HttpApiEndpoint.get("sessionModelUsage", KilocodePaths.sessionModelUsage, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(ModelUsage.Info, "Model usage for a session tree"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "kilocode.sessionModelUsage",
            summary: "Get session model usage",
            description: "Get token usage and direct cost by model for the complete top-level session tree.",
          }),
        ),
        HttpApiEndpoint.post("customProviderDelete", KilocodePaths.customProviderDelete, {
          params: CustomProviderDeleteParams,
          query: WorkspaceRoutingQuery,
          success: described(CustomProviderDeleteResult, "Custom provider deleted"),
          error: CustomProviderDeleteFailure,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "customProvider.delete",
            summary: "Delete custom provider",
            description:
              "Atomically remove a custom provider's auth credentials, config, and model cache, then rebuild instances after active generations drain. The request directory is resolved from the canonical instance routing context.",
          }),
        ),
        HttpApiEndpoint.post("customProviderSave", KilocodePaths.customProviderSave, {
          params: CustomProviderSaveParams,
          query: WorkspaceRoutingQuery,
          payload: CustomProviderSaveBody,
          success: described(CustomProviderSaveResult, "Custom provider saved"),
          error: CustomProviderSaveFailure,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "customProvider.save",
            summary: "Save custom provider",
            description:
              "Atomically persist a custom provider's config and auth credentials in one mutation that cannot leave partial state, clear the model cache, then rebuild instances after active generations drain. The request directory is resolved from the canonical instance routing context.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "kilocode",
          description: "Kilo-specific routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .addHttpApi(AnacondaDesktopApi)
  .annotateMerge(
    OpenApi.annotations({
      title: "kilo HttpApi",
      version: "0.0.1",
      description: "Kilo HttpApi surface.",
    }),
  )
