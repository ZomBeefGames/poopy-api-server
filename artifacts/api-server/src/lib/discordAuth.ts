const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

export interface CachedIdentity {
  userId: string;
  username: string;
  avatar: string | null;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedIdentity>();

export async function resolveIdentity(token: string): Promise<CachedIdentity | null> {
  const now = Date.now();
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > now) return cached;

  try {
    const res = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const me = await res.json() as { id: string; username: string; avatar: string | null };
    const identity: CachedIdentity = {
      userId: me.id,
      username: me.username,
      avatar: me.avatar ?? null,
      expiresAt: now + TOKEN_TTL_MS,
    };
    tokenCache.set(token, identity);
    return identity;
  } catch {
    return null;
  }
}
