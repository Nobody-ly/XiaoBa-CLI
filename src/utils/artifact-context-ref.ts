export const CATSCO_ARTIFACT_CONTEXT_REF_ENV = 'CATSCO_ARTIFACT_CONTEXT_REF';

const ARTIFACT_CONTEXT_REF_PATTERN = /^acr_[A-Za-z0-9_-]{43}$/;

export function normalizeArtifactContextRef(value: unknown): string | undefined {
  if (typeof value !== 'string' || value !== value.trim() || !ARTIFACT_CONTEXT_REF_PATTERN.test(value)) {
    return undefined;
  }
  return value;
}

export function withArtifactContextRefEnvironment(
  environment: NodeJS.ProcessEnv,
  contextRef: unknown,
): NodeJS.ProcessEnv {
  const next = { ...environment };
  for (const key of Object.keys(next)) {
    if (key.toUpperCase() === CATSCO_ARTIFACT_CONTEXT_REF_ENV) {
      delete next[key];
    }
  }
  const normalized = normalizeArtifactContextRef(contextRef);
  if (normalized) {
    next[CATSCO_ARTIFACT_CONTEXT_REF_ENV] = normalized;
  }
  return next;
}
