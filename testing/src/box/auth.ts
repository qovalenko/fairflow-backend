import { BOX_CONN, boxUniqueName } from './env';
import { mintBoxAccessTokenForUser, serviceMetadata } from './gateway';
import { createAuthGrpcClient } from './grpc';

/** Known password for the box stand throwaway users created by integration specs. */
export const BOX_THROWAWAY_PASSWORD = 'BffIntClosure1!';

export interface BoxThrowawayUser {
  id: string;
  email: string;
  login: string;
  password: string;
}

/** Provision an isolated auth user on the box stand (unique email, prefixed name). */
export async function provisionBoxThrowawayUser(
  password: string = BOX_THROWAWAY_PASSWORD,
): Promise<BoxThrowawayUser> {
  const email = `${boxUniqueName('user')}@example.test`.toLowerCase();
  const client = createAuthGrpcClient(BOX_CONN.grpc.auth);
  const res = await client.provisionUser(
    { email, name: 'BFF intclosure throwaway', password },
    serviceMetadata(),
  );
  const user = res.user;
  const id = String(user.id ?? user.user_id ?? '');
  const login = String(user.login ?? email);
  if (!id) throw new Error('ProvisionUser returned no user id');
  return { id, email, login, password };
}

/** Mark only our throwaway user unverified (for verify-email resend path). */
export async function setBoxUserEmailUnverified(userId: string): Promise<void> {
  const { Client } = await import('pg');
  const c = new Client({ connectionString: BOX_CONN.postgres });
  await c.connect();
  try {
    await c.query(`UPDATE auth."User" SET email_verified = false WHERE id = $1`, [userId]);
  } finally {
    await c.end();
  }
}

/** Best-effort deactivate of a throwaway user created in this spec. */
export async function deactivateBoxUser(userId: string): Promise<void> {
  const { Client } = await import('pg');
  const c = new Client({ connectionString: BOX_CONN.postgres });
  await c.connect();
  try {
    await c.query(`UPDATE auth."User" SET is_active = false WHERE id = $1`, [userId]);
  } finally {
    await c.end();
  }
}

export function mintThrowawayGatewayToken(user: BoxThrowawayUser): string {
  return mintBoxAccessTokenForUser({
    id: user.id,
    login: user.login,
    email: user.email,
  });
}
