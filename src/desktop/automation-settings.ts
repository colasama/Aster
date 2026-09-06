export interface AutomationSettings {
  enabled: boolean;
  port: number;
  running: boolean;
  clients: number;
  busy: boolean;
  hasToken: boolean;
  environmentManaged: boolean;
  error?: string;
}

export interface AutomationSettingsApi {
  get(): Promise<AutomationSettings>;
  update(patch: {
    enabled?: boolean;
    port?: number;
    rotateToken?: boolean;
  }): Promise<AutomationSettings>;
  copy(kind: "token" | "configuration"): Promise<void>;
}
