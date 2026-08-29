/** Ensures authorization failures cannot create staging files or start a hidden renderer. */
export async function prepareAuthorizedRenderHost<Authorization>(
  authorize: (() => Promise<Authorization>) | undefined,
  preparePublisher: () => Promise<void>,
  releaseAuthorization?: (authorization: Authorization) => void | Promise<void>,
): Promise<Authorization | undefined> {
  const authorization = await authorize?.();
  try {
    await preparePublisher();
    return authorization;
  } catch (error) {
    if (authorization !== undefined) await releaseAuthorization?.(authorization);
    throw error;
  }
}
