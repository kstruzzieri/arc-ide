export type ProfileType = 'single' | 'compound';
export type ProfileSource = 'user' | 'detected';
export type ProfileTag = 'build' | 'test' | 'dev' | 'deploy' | 'lint';

export interface EnvVariant {
  name: string;
  envFile: string;
}

export interface RunProfile {
  id: string;
  name: string;
  type: ProfileType;
  source: ProfileSource;
  command?: string;
  workingDir?: string;
  env?: Record<string, string>;
  envFile?: string;
  envVariants?: EnvVariant[];
  activeVariant?: string;
  tags?: ProfileTag[];
  steps?: string[];
  detectedFrom?: string;
  order?: number;
  workspaceId?: string;
  workspaceName?: string;
  workspaceRelDir?: string;
}

export interface RunProfileUIState {
  adopted?: boolean;
  lastRunAt?: number;
}

export interface RunProfilesSnapshot {
  profiles: RunProfile[];
  profileState: Record<string, RunProfileUIState>;
  workspaceEpoch: number;
}

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}
