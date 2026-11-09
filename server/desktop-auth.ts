import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';

function equalSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function localAgentRequest(request: IncomingMessage): boolean {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) return false;
  if (request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined || request.headers['sec-fetch-dest'] !== undefined) return false;
  return true;
}

function localAgentCredential(dataDirectory: string): string | undefined {
  if (!process.getuid) return;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(join(dirname(dataDirectory), 'local-agent-token'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || info.size < 64 || info.size > 129) return;
    const secret = readFileSync(descriptor, 'utf8');
    if (/^[a-f0-9]{64,128}\n?$/i.test(secret)) return secret.trim();
  } catch { return; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function localAgentAuthorized(request: IncomingMessage, dataDirectory: string, pathname: string): boolean {
  if (!pathname.startsWith('/api/') || pathname.startsWith('/api/desktop/') || !localAgentRequest(request)) return false;
  const candidate = /^Bearer ([a-f0-9]{64,128})$/i.exec(request.headers.authorization ?? '')?.[1];
  if (!candidate) return false;
  const secret = localAgentCredential(dataDirectory);
  return secret !== undefined && equalSecret(candidate, secret);
}

export function createDesktopAuth(dataDirectory: string, token = process.env.MAZAL_DESKTOP_TOKEN) {
  if (token === undefined && existsSync(join(dataDirectory, '.desktop-only'))) throw new Error('These records are protected by the Mazal Mac app. Open Mazal.app, or run npm run agent -- status for trusted local access without unlocking its window.');
  if (token !== undefined && !/^[a-f0-9]{64,128}$/i.test(token)) throw new Error('The desktop authentication token must contain at least 32 random bytes encoded as hex.');
  const cookieName = 'mazal_desktop_session';
  let session: string | undefined;

  async function handle(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
    if (!token) return false;
    const send = (status: number, body: unknown) => {
      response.statusCode = status;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify(body));
    };
    if (pathname === '/api/desktop/agent-health') {
      response.setHeader('Cache-Control', 'no-store');
      if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); send(405, { error: 'Use GET to check local automation access.' }); return true; }
      const secret = localAgentRequest(request) ? localAgentCredential(dataDirectory) : undefined;
      if (!secret) { send(401, { error: 'Trusted local automation access is unavailable.' }); return true; }
      const challenges = new URL(request.url ?? '/', 'http://localhost').searchParams.getAll('challenge');
      if (challenges.length !== 1 || !/^[a-f0-9]{64}$/.test(challenges[0])) { send(400, { error: 'Provide one random 32-byte hexadecimal challenge.' }); return true; }
      send(200, { ready: true, proof: createHmac('sha256', secret).update(`mazal-local-agent:${challenges[0]}`).digest('hex') });
      return true;
    }
    if (pathname === '/api/desktop/health' && request.method === 'GET') {
      send(200, { ready: true, instance: createHash('sha256').update(token).digest('hex') });
      return true;
    }
    if (pathname === '/api/desktop/session' || pathname === '/api/desktop/lock') {
      if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); send(405, { error: 'Use the Mazal Mac app to unlock your records.' }); return true; }
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') { send(415, { error: 'Unlock requests must use application/json.' }); return true; }
      let length = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 1024) { send(413, { error: 'The unlock request is too large.' }); return true; }
        chunks.push(chunk);
      }
      let candidate: unknown;
      try { candidate = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      if (!candidate || typeof candidate !== 'object' || !('token' in candidate) || typeof candidate.token !== 'string' || !equalSecret(candidate.token, token) || pathname === '/api/desktop/session' && session) {
        send(401, { error: 'Open Mazal.app and unlock it with Touch ID or your Mac password.' });
        return true;
      }
      if (pathname === '/api/desktop/lock') {
        session = undefined;
        response.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        send(200, { locked: true });
        return true;
      }
      session = randomBytes(32).toString('hex');
      response.setHeader('Set-Cookie', `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/`);
      send(200, { unlocked: true });
      return true;
    }
    if (localAgentAuthorized(request, dataDirectory, pathname)) return false;
    const cookies = (request.headers.cookie ?? '').split(';').map(value => value.trim());
    const matching = cookies.filter(value => value.startsWith(`${cookieName}=`));
    if (session && matching.length === 1 && equalSecret(matching[0].slice(cookieName.length + 1), session)) return false;
    send(401, { error: 'Mazal is locked. Open Mazal.app and use Touch ID or your Mac password.' });
    return true;
  }

  return { enabled: Boolean(token), handle };
}
