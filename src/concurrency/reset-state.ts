export class ResetState {
  private resetting = false;
  private startTimeMs: number | null = null;

  beginReset(): void {
    this.resetting = true;
    this.startTimeMs = Date.now();
  }

  endReset(): void {
    this.resetting = false;
    this.startTimeMs = null;
  }

  isResetting(): boolean {
    return this.resetting;
  }

  elapsedMs(): number {
    if (!this.resetting || this.startTimeMs === null) {
      return 0;
    }

    return Date.now() - this.startTimeMs;
  }
}

export const resetState = new ResetState();
