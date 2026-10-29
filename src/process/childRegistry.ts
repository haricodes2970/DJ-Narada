export interface OwnedChild {
  pid?: number;
  kill(signal?: string | number): boolean;
}

/**
 * Tracks only child processes started by Narada.
 *
 * The registry never discovers processes by name or PID, so an unrelated VLC
 * session is untouchable even when it is running at the same time.
 */
export class ChildProcessRegistry {
  private readonly children = new Set<OwnedChild>();

  register(child: OwnedChild): void {
    this.children.add(child);
  }

  unregister(child: OwnedChild): void {
    this.children.delete(child);
  }

  size(): number {
    return this.children.size;
  }

  async terminateOwned(): Promise<void> {
    const owned = [...this.children];
    this.children.clear();
    for (const child of owned) {
      try {
        child.kill("SIGTERM");
      } catch {
        // The child may already have exited; cleanup is best-effort.
      }
    }
  }
}
