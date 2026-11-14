// Calls to the local backend.

export class ApiError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

async function request(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new ApiError('offline');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(body.error || 'server_error', body.detail);
  return body;
}

export const api = {
  get: (url) => request(url),
  post: (url, body = {}) => request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
};

export function textureUrl(path, size) {
  return `/api/texture?size=${size}&path=${encodeURIComponent(path)}`;
}
