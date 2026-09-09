import { describe, expect, test } from "bun:test"
import {
  canonicalQuestionOpId,
  parseQuestionOpId,
  validateQuestionRejectRequest,
  validateQuestionReplyRequest,
} from "../../../src/kilocode/question/question-private"
import { QuestionID } from "../../../src/question/schema"

const RID = String(QuestionID.ascending())

function replyReq(opId: string) {
  return {
    v: 1 as const,
    requestId: "req-null",
    opId,
    op: "question/reply" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp", requestID: RID },
    payload: { answers: [["Yes"]] },
  }
}

describe("question opId null byte", () => {
  test("canonical builder and parser consistently reject null byte", () => {
    expect(() => canonicalQuestionOpId(RID, "tok\0bad")).toThrow()
    expect(() => canonicalQuestionOpId(`${RID}\0`, "tok")).toThrow()
    expect(() => parseQuestionOpId(`question:${RID}:tok\0`)).toThrow()
    expect(() => parseQuestionOpId(`question:${RID}\0:tok`)).toThrow()
    expect(() => parseQuestionOpId(`question:${RID}:tok\0bad`)).toThrow()
  })

  test("request validators reject null byte opId and requestID", () => {
    const good = canonicalQuestionOpId(RID, "tok-good")
    expect(() => validateQuestionReplyRequest(replyReq(`question:${RID}:tok\0`))).toThrow()
    expect(() =>
      validateQuestionReplyRequest({ ...replyReq(good), requestId: "req\0bad" }),
    ).toThrow()
    expect(() =>
      validateQuestionReplyRequest({ ...replyReq(good), context: { directory: "/tmp", requestID: `${RID}\0` } }),
    ).toThrow()
    expect(() =>
      validateQuestionRejectRequest({
        v: 1 as const,
        requestId: "req-null",
        opId: `question:${RID}:tok\0`,
        op: "question/reject" as const,
        idempotencyKey: `question:${RID}:tok\0`,
        context: { directory: "/tmp", requestID: RID },
        payload: {},
      }),
    ).toThrow()
  })
})
