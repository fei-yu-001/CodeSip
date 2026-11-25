import type { onSendAsyncHookHandler } from 'fastify';
import { promisify } from 'node:util';
import { gzip as gzipCallback, constants } from 'node:zlib';
const gzip = promisify(gzipCallback);

function acceptsGzip(header: string | undefined): boolean {
  if (!header) return false;
  const weights = new Map<string, number>();
  for (const part of header.toLowerCase().split(',')) {
    const [encoding, ...parameters] = part.trim().split(';');
    const parameter = parameters
      .map((value) => value.trim())
      .find((value) => value.startsWith('q='));
    const weight = parameter === undefined ? 1 : Number(parameter.slice(2));
    weights.set(
      encoding.trim(),
      Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0,
    );
  }
  return (weights.get('gzip') ?? weights.get('*') ?? 0) > 0;
}

// Only attach this to read-only document/manifest routes, never login or tokens.
// Compress off the event loop; retain no-store and hash validation on decoded bytes.
export const compressReadingResponse: onSendAsyncHookHandler = async (request, reply, payload) => {
  if (
    request.method !== 'GET' ||
    reply.statusCode !== 200 ||
    reply.hasHeader('Content-Encoding') ||
    !(typeof payload === 'string' || Buffer.isBuffer(payload)) ||
    !/^(text\/|application\/json\b)/i.test(String(reply.getHeader('Content-Type')))
  )
    return payload;
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (bytes.length < 1024) return payload;
  const vary = String(reply.getHeader('Vary') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!vary.some((value) => value === '*' || value.toLowerCase() === 'accept-encoding'))
    vary.push('Accept-Encoding');
  reply.header('Vary', vary.join(', '));
  if (!acceptsGzip(request.headers['accept-encoding'])) return payload;
  const compressed = await gzip(bytes, { level: constants.Z_BEST_SPEED });
  if (compressed.length >= bytes.length) return payload;
  reply.header('Content-Encoding', 'gzip').removeHeader('Content-Length');
  return compressed;
};
