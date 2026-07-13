import type { ProjectDiagnostic, ProjectProfile, RequiredInput } from '../types';

export type NodeOwnership = 'created' | 'reused';

export interface AstOperation {
  kind: 'import' | 'plugin' | 'loader' | 'transport-hook' | 'state-file';
  ownership: NodeOwnership;
  fingerprint: string;
  description: string;
  details?: Readonly<Record<string, string>>;
}

export interface FileIdentity {
  device: string;
  inode: string;
  birthtimeNs: string;
  mode: number;
}

export interface PlannedTargetIdentity {
  rootIdentity: string;
  path: string;
  exists: boolean;
  kind: 'file' | 'absent';
  parentIdentity: FileIdentity;
  fileIdentity?: FileIdentity;
  realPathIdentity?: string;
}

export interface PlannedFileEdit {
  path: string;
  target: PlannedTargetIdentity;
  beforeDigest: string | 'ABSENT';
  afterDigest: string | 'ABSENT';
  afterExists: boolean;
  beforeContent: string;
  afterContent: string | null;
  operations: AstOperation[];
}

export interface IntegrationPlan {
  schemaVersion: 1;
  operation: 'init-plan';
  profile: ProjectProfile;
  normalizedAnswers: Record<string, string>;
  requiredInputs: RequiredInput[];
  diagnostics: ProjectDiagnostic[];
  edits: PlannedFileEdit[];
  planDigest: string;
  blocked: boolean;
  noOp: boolean;
}

export interface CreateIntegrationPlanOptions {
  workspaceRoot: string;
  answers?: Readonly<Record<string, string>>;
}

export interface ApplyIntegrationPlanOptions extends CreateIntegrationPlanOptions {
  planDigest: string;
}

export interface IntegrationMutationResult {
  ok: boolean;
  operation: 'init-apply' | 'remove-apply';
  changedFiles: string[];
  diagnostics: ProjectDiagnostic[];
  errorCode?:
    | 'PLAN_CONTEXT_REQUIRED'
    | 'PLAN_STALE'
    | 'RECOVERY_REQUIRED'
    | 'TRANSACTION_CONFLICT'
    | 'PROJECT_LOCKED'
    | 'INTERNAL_ERROR';
}

export interface RemovalPlan {
  schemaVersion: 1;
  operation: 'remove-plan';
  profile: ProjectProfile | null;
  normalizedAnswers: Record<string, string>;
  diagnostics: ProjectDiagnostic[];
  edits: PlannedFileEdit[];
  planDigest: string;
  blocked: boolean;
  noOp: boolean;
}

export interface CreateRemovalPlanOptions {
  workspaceRoot: string;
}

export interface ApplyRemovalPlanOptions extends CreateRemovalPlanOptions {
  planDigest: string;
}

export interface DoctorProjectOptions {
  workspaceRoot: string;
}

export interface DoctorResult {
  ok: boolean;
  recovered: boolean;
  configured: boolean;
  diagnostics: ProjectDiagnostic[];
  errorCode?: 'TRANSACTION_CONFLICT' | 'PROJECT_LOCKED' | 'INTERNAL_ERROR';
}
