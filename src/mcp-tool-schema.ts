import {
  DEFAULT_READ_CHARS,
  DEFAULT_READ_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  MAX_DIAGNOSTIC_LIMIT,
  MAX_READ_CHARS,
  MAX_READ_LIMIT,
  MAX_SEARCH_LIMIT,
  MIN_READ_CHARS,
} from "./mcp-tool-arguments";

export {
  DEFAULT_READ_CHARS,
  DEFAULT_READ_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  MAX_DIAGNOSTIC_LIMIT,
  MAX_READ_CHARS,
  MAX_READ_LIMIT,
  MAX_SEARCH_LIMIT,
  MIN_READ_CHARS,
};

export function objectSchema(properties: Record<string, unknown> = {}, required: string[] = []): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
    ...(required.length > 0 ? { required } : {}),
  };
}

export function stringProperty(description: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "string",
    description,
    ...extra,
  };
}

export function limitProperty(maximum: number, defaultValue: number, description: string): Record<string, unknown> {
  return {
    type: "integer",
    minimum: 1,
    maximum,
    default: defaultValue,
    description,
  };
}

export function integerProperty(minimum: number, maximum: number, defaultValue: number, description: string): Record<string, unknown> {
  return {
    type: "integer",
    minimum,
    maximum,
    default: defaultValue,
    description,
  };
}

export const stringArrayProperty = (description: string): Record<string, unknown> => ({
  type: "array",
  description,
  items: { type: "string" },
});

export const evidenceProperty = {
  type: "array",
  description:
    "Optional bounded evidence items. Use only cited vault retrieval chunks or explicit external import source files here. Repo docs, conventions, templates, and approved-tag files are rationale only and must not be passed as proposal evidence.",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      chunkId: { type: "string" },
      headingPath: { type: "string" },
      excerpt: { type: "string" },
    },
    required: ["path"],
  },
};

export const placementDebtProperty = {
  type: "object",
  description: "Optional placement-debt record when ambiguity forces a temporary daily-note fallback.",
  additionalProperties: false,
  properties: {
    originalText: { type: "string" },
    ambiguityReason: { type: "string" },
    reviewDueAt: { type: "string" },
    candidateDestinations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          title: { type: "string" },
          reason: { type: "string" },
          anchorHeading: { type: "string" },
        },
        required: ["path"],
      },
    },
  },
  required: ["originalText", "ambiguityReason", "candidateDestinations"],
};

export const placementScorecardProperty = {
  type: "object",
  description: "Optional structured placement rationale for add or capture workflows.",
  additionalProperties: true,
};

export const pathActionsProperty = {
  type: "array",
  description:
    "Optional non-content file actions. `move` requires vault scope plus destinationPath. `delete-file` requires external scope. Do not use pathActions for normal note content creation or replacement.",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      type: {
        type: "string",
        enum: ["move", "delete-file"],
        description: "`move` for vault-to-vault renames only, `delete-file` for explicit external source cleanup only.",
      },
      scope: {
        type: "string",
        enum: ["vault", "external"],
        description: "`move` only supports `vault`; `delete-file` only supports `external`.",
      },
      path: {
        type: "string",
        description: "Vault-relative source path for move, or validated external absolute path for delete-file.",
      },
      destinationPath: {
        type: "string",
        description: "Required for move actions. Vault-relative destination path.",
      },
    },
    required: ["type", "path"],
  },
};

export const targetsProperty = {
  type: "array",
  description:
    "Optional note content writes. Use this for normal note creation or replacement. Paths must be vault-relative; external source files do not belong here.",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string", description: "Vault-relative note path to create or replace." },
      mode: { type: "string", enum: ["create", "replace"], description: "`create` for new note files, `replace` for whole-file replacement." },
      body: { type: "string", description: "Complete file body for the created or replaced note." },
    },
    required: ["path", "body"],
  },
};

export const commonProposalProperties = {
  operation: stringProperty("Short operation label such as add-note, capture-fallback, import-note, or triage-extract.", { minLength: 1 }),
  bundleId: stringProperty("Optional bundle id for related proposals that should stay grouped."),
  contextPackId: stringProperty("Optional context_pack id that supplied retrieval evidence for this proposal."),
  sourceChunkIds: stringArrayProperty("Optional vault chunk ids from retrieval results that support the proposal. Use only chunk ids returned by vault retrieval tools; external files never belong here."),
  candidatePaths: stringArrayProperty("Optional vault-relative candidate destinations considered during placement."),
  approvedTags: stringArrayProperty("Approved topical tags that belong on the proposed note content."),
  proposedTagGaps: stringArrayProperty("Useful new tags to surface separately without applying."),
  dependencies: stringArrayProperty("Proposal ids that must be approved or applied before this proposal."),
  evidence: evidenceProperty,
  placementScorecard: placementScorecardProperty,
  placementDebt: placementDebtProperty,
  rationale: stringProperty("Why this destination and edit shape are correct.", { minLength: 1 }),
};
