export { detectProject } from './detect/project';
export { createIntegrationPlan } from './plan/integration';
export { applyIntegrationPlan } from './plan/apply';
export { createRemovalPlan } from './plan/removal';
export { applyRemovalPlan } from './plan/remove-apply';
export { doctorProject } from './doctor/project';
export type {
  AdapterKind,
  BundlerKind,
  ConfigModuleKind,
  DetectProjectOptions,
  DetectedPackage,
  DevCommandCandidate,
  PackageManager,
  ProjectDiagnostic,
  ProjectDiagnosticSeverity,
  ProjectProfile,
  RequiredInput,
} from './types';
export type {
  AstOperation,
  ApplyIntegrationPlanOptions,
  ApplyRemovalPlanOptions,
  CreateIntegrationPlanOptions,
  CreateRemovalPlanOptions,
  DoctorProjectOptions,
  DoctorResult,
  FileIdentity,
  IntegrationPlan,
  IntegrationMutationResult,
  NodeOwnership,
  PlannedFileEdit,
  PlannedTargetIdentity,
  RemovalPlan,
} from './plan/types';
