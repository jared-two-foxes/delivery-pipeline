export type ScaffoldOperation =
  | "init" | "add" | "list" | "start" | "complete" | "block"
  | "fail" | "retry" | "decompose" | "design-record"
  | "design-finish" | "design-reopen" | "checkpoint-record" | "issue-resume"
  | "summary" | "issue" | "select" | "design-select" | "delivery-record"
  | "direction-approve" | "design-revise" | "attempt-record" | "history-foreign"
  | "history-rewrite" | "failure-record" | "artifact-put" | "artifact-get"
  | "requirements" | "evidence-record" | "evidence-equivalence";

export interface IssueBinding {
  featureId: string;
  taskId: string;
  designRef: string;
}

export interface IssueDesign {
  reference: string;
  summary: string;
  verification: string;
  approval: string;
  disposition: "leaf" | "decomposed";
  children: string[];
}

export type RequirementRole = "contribute" | "verify";

/** Canonical feature requirement: stable author-chosen id, text and optional provenance. */
export interface Requirement {
  id: string;
  text: string;
  source?: string;
}

export interface RequirementLink {
  id: string;
  roles: RequirementRole[];
}

export interface IssueContract {
  id: string;
  objective: string;
  acceptance_criteria: string[];
  constraints: string[];
  dependencies: string[];
  status: "pending" | "in_progress" | "completed" | "blocked" | "failed" | "decomposed";
  /** Requirements this issue contributes to and/or verifies; absent for supporting issues and the root. */
  requirements?: RequirementLink[];
  requirements_rationale?: string;
  design?: IssueDesign;
}

export interface Issue extends IssueContract {
  feature_id: string;
  parent_id: string | null;
  designs: IssueDesign[];
  history: Array<Record<string, unknown>>;
}

export interface Feature {
  id: string;
  design_ref: string;
  context: string;
  objective: string;
  requirements: Requirement[];
  constraints?: string[];
  branch: string;
  baseline: string;
  original_baseline: string;
  workflow: { kind: "recursive-issues/v2"; phase: "design" | "implement"; root_id: string };
  tasks: Record<string, Issue>;
}

export interface ScaffoldRequest {
  operation: ScaffoldOperation;
  feature_id: string;
  task_id?: string;
  payload?: unknown;
  reason?: string;
}

export interface FeatureSummary {
  id: string;
  design_ref: string;
  phase: "design" | "implement";
  task_revision: number;
  state_digest: string;
  baseline: string;
  branch: string;
  counts: Record<string, number>;
  coverage: CoverageStatus;
  requirements: { total: number; mapped: number; unmapped: number; unmapped_ids: string[] };
}

export interface CoverageStatus {
  complete: boolean;
  problems: string[];
  plan_status: "unrecorded" | "current" | "stale";
  plan_digest: string;
  recorded_plan_digest: string | null;
}

export interface ScopedRequirement extends Requirement {
  roles: RequirementRole[];
  contributors: string[];
  verifiers: string[];
}

export interface RequirementsView {
  schema: "scaffold.requirements/v1";
  feature: { id: string; phase: "design" | "implement" };
  coverage: CoverageStatus;
  counts: FeatureSummary["requirements"];
  requirements: Array<Requirement & { mapped: boolean; missing: RequirementRole[]; problems: string[];
    contributors: Array<{ id: string; status: string }>; verifiers: Array<{ id: string; status: string }> }>;
}

export interface IssueCapsule {
  schema: "scaffold.issue-context/v1";
  feature: FeatureSummary;
  issue: IssueContract;
  ancestors: IssueContract[];
  prerequisites: IssueContract[];
  children: IssueContract[];
  requirements: ScopedRequirement[];
}

export interface ScaffoldResponse {
  schema_version: 3;
  feature?: Feature;
  task?: Issue | null;
  summary?: FeatureSummary;
  context?: IssueCapsule | null;
  /** `requirements` operation (scaffold.requirements/v1). */
  schema?: RequirementsView["schema"];
  coverage?: CoverageStatus;
  counts?: RequirementsView["counts"];
  requirements?: RequirementsView["requirements"];
}

export function scaffoldArguments(params: unknown): { args: string[]; input: string };

export type ScaffoldResult =
  | { ok: true; operation: ScaffoldOperation; feature_id: string; task_id?: string;
      exit_code: 0; data: ScaffoldResponse }
  | { ok: false; operation?: ScaffoldOperation; feature_id?: string; task_id?: string;
      reason: string; message: string; exit_code?: number; stderr?: string };

export const OPERATIONS: ScaffoldOperation[];
export function isReference(value: unknown): value is string;
export const REQUIREMENT_ROLES: RequirementRole[];
export function validateRequirements(items: unknown): asserts items is Requirement[];
export function validateRequirementLinks(links: unknown, where?: string): asserts links is RequirementLink[];
export function designReference(context: string): string;
export function validateRequest(params: unknown): ScaffoldRequest;
export function validateResponse(data: unknown, params: ScaffoldRequest): asserts data is ScaffoldResponse;
export function approvedIssue(feature: Feature, binding: IssueBinding): Issue;
export function issueDesignRequirements(task: Issue): string;
export function issueRequirements(task: Issue, additional: string): string;
