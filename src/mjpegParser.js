// @ts-check
import { EventEmitter } from 'node:events';

const SOI = Buffer.from([0xff, 0xd8]); // Start Of Image
const EOI = Buffer.from([0xff, 0xd9]); // End Of Image
const MAX_BUFFER = 20 * 1024 * 1024; // 20 MB safety cap
const EMPTY = Buffer.alloc(0);

/**
 * Streaming MJPEG parser. Feed it raw bytes from an FFmpeg `-f mjpeg pipe:1`
 * stdout and it emits one `'frame'` event (a standalone Buffer) per complete
 * JPEG, delimited by the SOI (FF D8) and EOI (FF D9) markers.
 *
 * Handles: markers split across chunks, garbage before the first SOI, and
 * multiple frames arriving in a single chunk. Resets if the buffer grows past
 * {@link MAX_BUFFER} without a terminating EOI (runaway / desync protection).
 *
 * @fires MjpegParser#frame
 */
export class MjpegParser extends EventEmitter {
  constructor() {
    super();
    /** @type {Buffer} */
    this.buf = EMPTY;
    /** True once `buf` is known to start at an SOI marker. */
    this.inFrame = false;
  }

  /**
   * @param {Buffer} chunk
   */
  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    this._parse();
    if (this.buf.length > MAX_BUFFER) {
      // No EOI in 20 MB: the stream is desynced or not JPEG. Drop and recover.
      this.reset();
    }
  }

  _parse() {
    for (;;) {
      if (!this.inFrame) {
        const soi = this.buf.indexOf(SOI);
        if (soi === -1) {
          // Discard garbage, but keep a trailing 0xFF in case it's a split SOI.
          const last = this.buf.length - 1;
          this.buf = last >= 0 && this.buf[last] === 0xff ? this.buf.subarray(last) : EMPTY;
          return;
        }
        if (soi > 0) this.buf = this.buf.subarray(soi);
        this.inFrame = true;
      }

      // buf now starts with SOI; look for EOI after it.
      const eoi = this.buf.indexOf(EOI, 2);
      if (eoi === -1) return; // need more bytes

      const end = eoi + 2;
      // Copy so downstream holders aren't tied to the shared backing store.
      const frame = Buffer.from(this.buf.subarray(0, end));
      this.buf = this.buf.subarray(end);
      this.inFrame = false;
      /**
       * @event MjpegParser#frame
       * @type {Buffer}
       */
      this.emit('frame', frame);
    }
  }

  reset() {
    this.buf = EMPTY;
    this.inFrame = false;
  }
}

export default MjpegParser;
