// forge shared error type: every failure carries a stable code and a path.
export class EmberError extends Error {
  constructor(code, message, path = null) {
    super(path ? `${message}（位置：${path}）` : message);
    this.name = 'EmberError';
    this.code = code;
    this.path = path;
  }
}

export const CODES = Object.freeze({
  SCHEMA: 'E_SCHEMA',
  ID: 'E_ID',
  DUP_ID: 'E_DUP_ID',
  PARENT: 'E_PARENT',
  CYCLE: 'E_CYCLE',
  FOREST: 'E_FOREST',
  DIFFICULTY: 'E_DIFFICULTY',
  RELATION: 'E_RELATION',
  PROMPT: 'E_PROMPT',
  SOURCE: 'E_SOURCE',
  STATE: 'E_STATE',
  IDENTITY: 'E_IDENTITY',
  USAGE: 'E_USAGE',
  IO: 'E_IO',
  SCENE: 'E_SCENE',
  SERVER: 'E_SERVER',
  CONFLICT: 'E_CONFLICT',
});

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function requireRecord(value, code, message, path) {
  if (!isRecord(value)) throw new EmberError(code, message, path);
  return value;
}

export function requireNonEmptyString(value, code, message, path) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new EmberError(code, message, path);
  }
  return value;
}
