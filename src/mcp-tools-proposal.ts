import type { McpToolSpec } from "./mcp-contracts";
import {
  validateNoArguments,
  validateProposalApplyArguments,
  validateProposalAuthorizeArguments,
  validateProposalCreateArguments,
  validateProposalCreateNoteArguments,
  validateProposalReadArguments,
  validateProposalRejectArguments,
} from "./mcp-tool-arguments";
import {
  commonProposalProperties,
  objectSchema,
  pathActionsProperty,
  stringArrayProperty,
  stringProperty,
  targetsProperty,
} from "./mcp-tool-schema";

export const PROPOSAL_MCP_TOOL_SPECS: McpToolSpec[] = [
  {
    name: "proposal_list",
    title: "Proposal List",
    description: "List queued proposal metadata without note bodies or diff bodies.",
    inputSchema: objectSchema(),
    writePolicy: "read-only",
    copilotAllowlisted: true,
    parseArguments: validateNoArguments,
  },
  {
    name: "proposal_read",
    title: "Proposal Read",
    description: "Read one proposal with current validation and bounded diff previews.",
    inputSchema: objectSchema(
      {
        proposalId: stringProperty("Proposal identifier returned by proposal_create_note, proposal_create, or proposal_list.", { minLength: 1 }),
      },
      ["proposalId"],
    ),
    writePolicy: "read-only",
    copilotAllowlisted: true,
    parseArguments: validateProposalReadArguments,
  },
  {
    name: "proposal_create_note",
    title: "Proposal Create Note",
    description:
      "Create one approval-ready note-content proposal without mutating vault files. Use this for normal add, capture, import, and extraction note drafts. Use proposal_create only for archive moves, vault moves, or explicit external delete-file proposals.",
    inputSchema: objectSchema(
      {
        ...commonProposalProperties,
        path: stringProperty("Vault-relative note path to create or replace.", { minLength: 1 }),
        mode: {
          type: "string",
          enum: ["create", "replace"],
          description: "`create` for new note files, `replace` for whole-file replacement.",
        },
        body: stringProperty("Complete file body for the created or replaced note.", { minLength: 1 }),
      },
      ["operation", "path", "mode", "body", "rationale"],
    ),
    writePolicy: "write-enabled",
    copilotAllowlisted: true,
    parseArguments: validateProposalCreateNoteArguments,
  },
  {
    name: "proposal_create",
    title: "Proposal Create",
    description:
      "Create a reviewable runtime proposal record without mutating vault files. Use `targets` for note content creates or replaces. Use `pathActions` only for vault-to-vault moves or separate external delete-file proposals.",
    inputSchema: objectSchema(
      {
        ...commonProposalProperties,
        unresolvedQuestions: stringArrayProperty("Open questions that must be answered before apply."),
        validationBlockers: stringArrayProperty("Validation blockers that intentionally prevent apply until resolved."),
        pathActions: pathActionsProperty,
        targets: targetsProperty,
      },
      ["operation", "rationale"],
    ),
    writePolicy: "write-enabled",
    copilotAllowlisted: true,
    parseArguments: validateProposalCreateArguments,
  },
  {
    name: "proposal_reject",
    title: "Proposal Reject",
    description: "Reject a proposal without touching the vault and redact note-derived content.",
    inputSchema: objectSchema(
      {
        proposalId: { type: "string", minLength: 1 },
        reason: { type: "string" },
      },
      ["proposalId"],
    ),
    writePolicy: "write-enabled",
    copilotAllowlisted: true,
    parseArguments: validateProposalRejectArguments,
  },
  {
    name: "proposal_authorize",
    title: "Proposal Authorize",
    description: "Issue a one-use apply authorization for a current pending proposal.",
    inputSchema: objectSchema(
      {
        proposalId: { type: "string", minLength: 1 },
      },
      ["proposalId"],
    ),
    writePolicy: "write-enabled",
    copilotAllowlisted: false,
    parseArguments: validateProposalAuthorizeArguments,
  },
  {
    name: "proposal_apply",
    title: "Proposal Apply",
    description: "Apply an authorized proposal with lock, rollback, and post-write refresh safety.",
    inputSchema: objectSchema(
      {
        proposalId: { type: "string", minLength: 1 },
        authorizationId: { type: "string", minLength: 1 },
      },
      ["proposalId"],
    ),
    writePolicy: "write-enabled",
    copilotAllowlisted: false,
    parseArguments: validateProposalApplyArguments,
  },
];
