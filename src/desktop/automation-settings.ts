export interface AutomationSettings {
  enabled: boolean;
  port: number;
  running: boolean;
  clients: number;
  busy: boolean;
  environmentManaged: boolean;
  error?: string;
}

export interface AutomationSettingsApi {
  get(): Promise<AutomationSettings>;
  update(patch: { enabled?: boolean; port?: number }): Promise<AutomationSettings>;
  copy(kind: "configuration"): Promise<void>;
}
