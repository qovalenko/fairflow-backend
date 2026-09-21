/**
 * Contract for service-to-service auth: obtain short-lived JWT via API-key (client_credentials).
 * Implementation lives in auth service and in each service's HTTP client that calls others.
 */
export interface ServiceTokenRequest {
  client_id: string;
  client_secret: string;
  grant_type: 'client_credentials';
  scope?: string;
  aud?: string;
}

export interface ServiceTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope?: string;
}

export const SERVICE_AUDIENCE = 'internal';
