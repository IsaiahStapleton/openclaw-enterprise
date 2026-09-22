import { Transform } from "node:stream";
import type { TransformCallback } from "node:stream";
import type { Clock } from "../backend-contracts.ts";

export class ByteLimit extends Transform {
  #bytes = 0;
  private readonly maximum: number;
  private readonly progress: () => void;
  constructor(maximum: number, progress: () => void = () => {}) {
    super();
    this.maximum = maximum;
    this.progress = progress;
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#bytes += chunk.length;
    if (this.#bytes > this.maximum) {
      callback(new Error("limit-exceeded"));
      return;
    }
    this.progress();
    callback(null, chunk);
  }
}

export function watchdog(
  clock: Clock,
  delayMs: number,
  expired: () => void,
): Readonly<{ reset(): void; close(): void }> {
  let cancel: (() => void) | undefined;
  let closed = false;
  const reset = () => {
    if (!closed) {
      cancel?.();
      cancel = clock.schedule(delayMs, expired);
    }
  };
  reset();
  return {
    reset,
    close() {
      closed = true;
      cancel?.();
    },
  };
}
