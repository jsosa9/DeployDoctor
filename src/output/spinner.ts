import pc from "picocolors";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Minimal spinner. Goes quiet on non-TTY stdout so wrapped CI logs stay clean.
 */
export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private readonly enabled = process.stdout.isTTY === true;

  start(text: string): void {
    if (!this.enabled) return;
    this.stop();
    this.timer = setInterval(() => {
      const mark = pc.cyan(FRAMES[this.frame % FRAMES.length]!);
      process.stdout.write(`\r${mark} ${text}`);
      this.frame++;
    }, 80);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      process.stdout.write(`\r\x1B[2K`);
    }
  }
}
