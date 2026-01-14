const sessionLocks = new Map<string, Promise<void>>();

export async function withSessionLock<T>(
  sessionName: string,
  fn: () => Promise<T>
): Promise<T> {
  const previous = sessionLocks.get(sessionName) ?? Promise.resolve();

  const current = (async () => {
    await previous;
    return fn();
  })();

  const tail = current.then(
    () => undefined,
    () => undefined
  );
  sessionLocks.set(sessionName, tail);

  try {
    return await current;
  } finally {
    if (sessionLocks.get(sessionName) === tail) {
      sessionLocks.delete(sessionName);
    }
  }
}
