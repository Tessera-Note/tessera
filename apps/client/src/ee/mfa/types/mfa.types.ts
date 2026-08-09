export interface MfaMethod {
  type: "totp" | "email";
  isEnabled: boolean;
}

export interface MfaSettings {
  isEnabled: boolean;
  methods: MfaMethod[];
  backupCodesCount: number;
  lastUpdated?: string;
}

export interface MfaSetupState {
  method: "totp" | "email";
  secret?: string;
  qrCode?: string;
  manualEntry?: string;
  backupCodes?: string[];
}

export interface MfaStatusResponse {
  isEnabled?: boolean;
  method?: string | null;
  backupCodesCount?: number;
  /**
   * Резервных кодов осталось мало. Порог считает сервер, чтобы он был
   * один на все места, где о нем спрашивают.
   */
  backupCodesLow?: boolean;
}

export interface MfaSetupRequest {
  method: "totp";
}

export interface MfaSetupResponse {
  method: string;
  qrCode: string;
  manualKey: string;
}

export interface MfaEnableRequest {
  verificationCode: string;
}

export interface MfaEnableResponse {
  success: boolean;
  backupCodes: string[];
}

export interface MfaDisableRequest {
  confirmPassword?: string;
}

export interface MfaBackupCodesResponse {
  backupCodes: string[];
}

export interface MfaAccessValidationResponse {
  valid: boolean;
  isTransferToken?: boolean;
  requiresMfaSetup?: boolean;
  userHasMfa?: boolean;
  isMfaEnforced?: boolean;
}
