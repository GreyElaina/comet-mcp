export class RWLock {
  private activeReaders = 0;
  private activeWriter = false;
  private waitingWriters = 0;
  private readonly readerQueue: Array<() => void> = [];
  private readonly writerQueue: Array<() => void> = [];

  async runRead<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireRead();
    try {
      return await fn();
    } finally {
      this.releaseRead();
    }
  }

  async runWrite<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireWrite();
    try {
      return await fn();
    } finally {
      this.releaseWrite();
    }
  }

  private acquireRead(): Promise<void> {
    if (!this.activeWriter && this.waitingWriters === 0) {
      this.activeReaders += 1;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.readerQueue.push(() => {
        this.activeReaders += 1;
        resolve();
      });
    });
  }

  private acquireWrite(): Promise<void> {
    if (!this.activeWriter && this.activeReaders === 0 && this.waitingWriters === 0) {
      this.activeWriter = true;
      return Promise.resolve();
    }

    this.waitingWriters += 1;
    return new Promise((resolve) => {
      this.writerQueue.push(() => {
        this.waitingWriters -= 1;
        this.activeWriter = true;
        resolve();
      });
    });
  }

  private releaseRead(): void {
    if (this.activeReaders === 0) {
      return;
    }

    this.activeReaders -= 1;
    if (this.activeReaders === 0 && this.waitingWriters > 0) {
      this.dequeueWriter();
    }
  }

  private releaseWrite(): void {
    this.activeWriter = false;
    if (this.waitingWriters > 0) {
      this.dequeueWriter();
      return;
    }

    this.drainReaders();
  }

  private dequeueWriter(): void {
    if (this.activeWriter || this.activeReaders > 0) {
      return;
    }

    const next = this.writerQueue.shift();
    if (!next) {
      this.waitingWriters = 0;
      this.drainReaders();
      return;
    }

    next();
  }

  private drainReaders(): void {
    if (this.activeWriter || this.waitingWriters > 0) {
      return;
    }

    while (this.readerQueue.length > 0) {
      const next = this.readerQueue.shift();
      if (next) {
        next();
      }
    }
  }
}
