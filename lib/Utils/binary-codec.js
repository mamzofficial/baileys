/**
 * lib/Utils/binary-codec.js — general-purpose Protocol Buffers wire-format
 * primitives: varint, ZigZag (sint32/sint64), fixed32/fixed64, and
 * length-delimited framing, plus a growable BufferWriter for building up a
 * message without repeated small allocations.
 *
 * This is a from-scratch, standalone module — it does not replace or touch
 * the small `encodeVarint`/`decodeVarint` pair already private to
 * lib/Utils/reporting-utils.js (used only for one WAM-reporting feature).
 * That pair is intentionally 32-bit-only for its narrow use case; the
 * functions here are exported for general use and are correct up to the
 * full 64-bit range protobuf's own spec allows (using BigInt where a
 * regular Number would lose precision).
 *
 * None of this is wired into WhatsApp's own protocol handling — Baileys
 * already encodes/decodes the real WAProto messages via `protobufjs`
 * (see WAProto/index.js), which is the correct, spec-complete way to do
 * that and shouldn't be replaced by hand-rolled encoding. This module is
 * for your OWN custom binary/protobuf-shaped payloads (e.g. a custom field
 * inside messageContextInfo, or a side-channel binary format) where you
 * want direct control over the wire bytes.
 *
 * Wire format reference: https://protobuf.dev/programming-guides/encoding/
 */

/** Protobuf wire types (the low 3 bits of every field tag). */
export const WireType = {
    VARINT: 0, // int32, int64, uint32, uint64, sint32, sint64, bool, enum
    FIXED64: 1, // fixed64, sfixed64, double
    LENGTH_DELIMITED: 2, // string, bytes, embedded messages, packed repeated fields
    START_GROUP: 3, // deprecated in proto3 — included for completeness only
    END_GROUP: 4, // deprecated in proto3 — included for completeness only
    FIXED32: 5 // fixed32, sfixed32, float
};

// --- Varint (used directly for VARINT wire type, and for the length prefix
// of every LENGTH_DELIMITED field) ---

/**
 * Encodes a non-negative integer as a protobuf varint.
 * Accepts a Number (must be a safe, non-negative integer) or a BigInt
 * (use BigInt for values that don't fit in a 32-bit int, e.g. uint64/int64
 * field values > 2^32 — a plain Number loses precision above 2^53).
 */
export const encodeVarint = (value) => {
    let n = typeof value === 'bigint' ? value : BigInt(value);
    if (n < 0n) {
        throw new RangeError('encodeVarint: value must be non-negative — use zigzagEncode32/64 first for signed (sint32/sint64) fields');
    }
    const bytes = [];
    while (n >= 0x80n) {
        bytes.push(Number(n & 0x7fn) | 0x80);
        n >>= 7n;
    }
    bytes.push(Number(n));
    return Buffer.from(bytes);
};

/**
 * Decodes a varint starting at `offset`.
 * Returns `{ value, bytesRead }`. `value` is a Number if it fits safely
 * (<= Number.MAX_SAFE_INTEGER), otherwise a BigInt — check
 * `typeof result.value` if you need to know which you got.
 */
export const decodeVarint = (buffer, offset = 0) => {
    let result = 0n;
    let shift = 0n;
    let bytesRead = 0;
    while (true) {
        if (offset + bytesRead >= buffer.length) {
            throw new RangeError('decodeVarint: unexpected end of buffer');
        }
        const byte = buffer[offset + bytesRead];
        result |= BigInt(byte & 0x7f) << shift;
        bytesRead++;
        if ((byte & 0x80) === 0) {
            break;
        }
        shift += 7n;
        if (shift > 70n) {
            throw new RangeError('decodeVarint: varint is too long (more than 10 bytes)');
        }
    }
    const value = result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : result;
    return { value, bytesRead };
};

// --- ZigZag encoding (for sint32/sint64 — maps signed values to unsigned
// ones so small-magnitude negative numbers still encode as short varints) ---

/** ZigZag-encodes a 32-bit signed integer. `n` must be in the int32 range. */
export const zigzagEncode32 = (n) => ((n << 1) ^ (n >> 31)) >>> 0;

/** Decodes a ZigZag-encoded 32-bit unsigned integer back to a signed int32. */
export const zigzagDecode32 = (n) => (n >>> 1) ^ -(n & 1);

/** ZigZag-encodes a 64-bit signed integer (BigInt in, BigInt out). */
export const zigzagEncode64 = (n) => {
    const v = typeof n === 'bigint' ? n : BigInt(n);
    return BigInt.asUintN(64, (v << 1n) ^ (v >> 63n));
};

/** Decodes a ZigZag-encoded 64-bit unsigned BigInt back to a signed BigInt. */
export const zigzagDecode64 = (n) => {
    const v = typeof n === 'bigint' ? n : BigInt(n);
    return (v >> 1n) ^ -(v & 1n);
};

// --- Fixed-width encodings (always little-endian, per the protobuf spec) ---

/** Encodes a 32-bit value as 4 fixed little-endian bytes (fixed32/sfixed32/float use this width). */
export const encodeFixed32 = (n) => {
    const buf = Buffer.allocUnsafe(4);
    buf.writeUInt32LE(n >>> 0, 0);
    return buf;
};

/** Decodes 4 little-endian bytes at `offset` back to an unsigned 32-bit integer. */
export const decodeFixed32 = (buffer, offset = 0) => buffer.readUInt32LE(offset);

/** Encodes a 64-bit value (BigInt) as 8 fixed little-endian bytes (fixed64/sfixed64/double use this width). */
export const encodeFixed64 = (n) => {
    const buf = Buffer.allocUnsafe(8);
    buf.writeBigUInt64LE(BigInt.asUintN(64, typeof n === 'bigint' ? n : BigInt(n)), 0);
    return buf;
};

/** Decodes 8 little-endian bytes at `offset` back to an unsigned 64-bit BigInt. */
export const decodeFixed64 = (buffer, offset = 0) => buffer.readBigUInt64LE(offset);

// --- Field tags and length-delimited framing ---

/** Builds a protobuf field tag: `(fieldNumber << 3) | wireType`, varint-encoded. */
export const encodeTag = (fieldNumber, wireType) => encodeVarint((fieldNumber << 3) | wireType);

/** Splits a decoded tag varint back into `{ fieldNumber, wireType }`. */
export const decodeTag = (tagValue) => {
    const n = typeof tagValue === 'bigint' ? Number(tagValue) : tagValue;
    return { fieldNumber: n >>> 3, wireType: n & 0x7 };
};

/**
 * Frames `data` as a protobuf LENGTH_DELIMITED field: tag + varint length + data.
 * This is the generalized, spec-correct version of the `wrapPayload(tag, data)`
 * helper — pass a real field number instead of a raw tag Buffer and this
 * builds a proper varint tag for you:
 *
 *   wrapPayload(tagBuffer, data)                      // your original
 *   encodeLengthDelimited(fieldNumber, data)           // spec-correct equivalent
 */
export const encodeLengthDelimited = (fieldNumber, data) => (
    Buffer.concat([encodeTag(fieldNumber, WireType.LENGTH_DELIMITED), encodeVarint(data.length), data])
);

/**
 * Reads one length-delimited field's payload starting at `offset` (which
 * must point at the length varint, i.e. right after the tag). Returns
 * `{ data, bytesRead }` where `bytesRead` covers the length prefix AND the
 * payload, so `offset + bytesRead` is the start of the next field.
 */
export const decodeLengthDelimited = (buffer, offset = 0) => {
    const { value: length, bytesRead: lengthBytes } = decodeVarint(buffer, offset);
    const len = typeof length === 'bigint' ? Number(length) : length;
    const dataStart = offset + lengthBytes;
    if (dataStart + len > buffer.length) {
        throw new RangeError('decodeLengthDelimited: declared length exceeds buffer bounds');
    }
    return { data: buffer.subarray(dataStart, dataStart + len), bytesRead: lengthBytes + len };
};

// --- Efficient buffer building ---

/**
 * A growable buffer writer for building up a message field-by-field without
 * a `Buffer.concat()` (and therefore a full copy) on every single write.
 *
 * Why this matters: `Buffer.concat([a, b])` allocates a brand-new buffer and
 * copies both `a` and `b` into it every time. Chaining many small
 * `Buffer.concat()` calls in a loop (once per field) is O(n²) in the total
 * bytes written — fine for a handful of fields, wasteful for a message with
 * hundreds. `BufferWriter` instead pre-allocates a working buffer with
 * `Buffer.allocUnsafe` (skips the zero-fill `Buffer.alloc` normally does,
 * safe here because every byte gets overwritten before being read) and
 * doubles its capacity only when it actually runs out — so the amortized
 * cost of N writes is O(N), not O(N²), and there's no wasted zero-filling.
 */
export class BufferWriter {
    constructor(initialCapacity = 256) {
        this._buf = Buffer.allocUnsafe(Math.max(initialCapacity, 16));
        this._len = 0;
    }
    _ensure(extra) {
        const needed = this._len + extra;
        if (needed <= this._buf.length) return;
        let newCapacity = this._buf.length * 2;
        while (newCapacity < needed) newCapacity *= 2;
        const grown = Buffer.allocUnsafe(newCapacity);
        this._buf.copy(grown, 0, 0, this._len);
        this._buf = grown;
    }
    writeBytes(data) {
        this._ensure(data.length);
        data.copy(this._buf, this._len);
        this._len += data.length;
        return this;
    }
    writeVarint(value) {
        return this.writeBytes(encodeVarint(value));
    }
    writeTag(fieldNumber, wireType) {
        return this.writeBytes(encodeTag(fieldNumber, wireType));
    }
    writeFixed32(n) {
        return this.writeBytes(encodeFixed32(n));
    }
    writeFixed64(n) {
        return this.writeBytes(encodeFixed64(n));
    }
    /** Writes a full LENGTH_DELIMITED field (tag + length + bytes) in one call. */
    writeLengthDelimited(fieldNumber, data) {
        return this.writeBytes(encodeLengthDelimited(fieldNumber, data));
    }
    get length() {
        return this._len;
    }
    /** Returns the written bytes as a Buffer. Copies — safe to keep using the writer afterward. */
    finish() {
        return Buffer.from(this._buf.subarray(0, this._len));
    }
}
