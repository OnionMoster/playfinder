// Minimal dependency-free Parquet reader for the A handoff files.
// Supports the encodings/codecs emitted by PyArrow for these files and fails
// closed on anything else. It is intentionally not a general Parquet library.
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';

const COMPACT = {
  STOP: 0, TRUE: 1, FALSE: 2, BYTE: 3, I16: 4, I32: 5, I64: 6,
  DOUBLE: 7, BINARY: 8, LIST: 9, SET: 10, MAP: 11, STRUCT: 12,
};

class CompactReader {
  constructor(buffer, offset = 0) { this.buffer = buffer; this.offset = offset; }
  byte() { return this.buffer[this.offset++]; }
  varintBig() {
    let value = 0n, shift = 0n;
    for (;;) {
      const byte = this.byte();
      value |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return value;
      shift += 7n;
      if (shift > 70n) throw new Error('invalid compact-protocol varint');
    }
  }
  zigzag() {
    const value = this.varintBig();
    const decoded = (value >> 1n) ^ -(value & 1n);
    const number = Number(decoded);
    if (!Number.isSafeInteger(number)) throw new Error('compact integer exceeds JavaScript safe range');
    return number;
  }
  value(type, boolValue) {
    if (type === COMPACT.TRUE || type === COMPACT.FALSE) return boolValue ?? type === COMPACT.TRUE;
    if (type === COMPACT.BYTE) return this.buffer.readInt8(this.offset++);
    if (type === COMPACT.I16 || type === COMPACT.I32 || type === COMPACT.I64) return this.zigzag();
    if (type === COMPACT.DOUBLE) { const value = this.buffer.readDoubleLE(this.offset); this.offset += 8; return value; }
    if (type === COMPACT.BINARY) {
      const length = Number(this.varintBig());
      const value = this.buffer.subarray(this.offset, this.offset + length);
      this.offset += length;
      return value;
    }
    if (type === COMPACT.LIST || type === COMPACT.SET) {
      const header = this.byte();
      let length = header >> 4;
      const elementType = header & 0x0f;
      if (length === 15) length = Number(this.varintBig());
      return Array.from({ length }, () => this.value(elementType));
    }
    if (type === COMPACT.MAP) {
      const length = Number(this.varintBig());
      if (!length) return [];
      const types = this.byte();
      return Array.from({ length }, () => [this.value(types >> 4), this.value(types & 0x0f)]);
    }
    if (type === COMPACT.STRUCT) return this.struct();
    throw new Error(`unsupported compact-protocol type ${type}`);
  }
  struct() {
    const result = {};
    let lastField = 0;
    for (;;) {
      const header = this.byte();
      if (header === COMPACT.STOP) break;
      const type = header & 0x0f;
      const delta = header >> 4;
      const field = delta ? lastField + delta : this.zigzag();
      lastField = field;
      result[field] = this.value(type, type === COMPACT.TRUE ? true : type === COMPACT.FALSE ? false : undefined);
    }
    return result;
  }
}

const text = (buffer) => buffer == null ? null : Buffer.from(buffer).toString('utf8');
const bitWidth = (maxLevel) => maxLevel <= 0 ? 0 : Math.ceil(Math.log2(maxLevel + 1));

function snappyUncompress(input) {
  let at = 0, expected = 0, shift = 0;
  for (;;) {
    const byte = input[at++];
    expected |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  const output = Buffer.allocUnsafe(expected);
  let out = 0;
  while (at < input.length) {
    const tag = input[at++];
    const type = tag & 3;
    if (type === 0) {
      let length = tag >> 2;
      if (length < 60) length += 1;
      else {
        const bytes = length - 59;
        length = 1;
        for (let i = 0; i < bytes; i++) length += input[at++] << (8 * i);
      }
      input.copy(output, out, at, at + length);
      at += length; out += length;
    } else {
      let length, offset;
      if (type === 1) {
        length = 4 + ((tag >> 2) & 7);
        offset = ((tag & 0xe0) << 3) | input[at++];
      } else if (type === 2) {
        length = 1 + (tag >> 2);
        offset = input.readUInt16LE(at); at += 2;
      } else {
        length = 1 + (tag >> 2);
        offset = input.readUInt32LE(at); at += 4;
      }
      if (offset <= 0 || offset > out) throw new Error('invalid Snappy copy offset');
      for (let i = 0; i < length; i++) output[out + i] = output[out - offset + i];
      out += length;
    }
  }
  if (out !== expected) throw new Error(`Snappy length mismatch: expected ${expected}, decoded ${out}`);
  return output;
}

function decompress(codec, payload, expectedSize) {
  let output;
  if (codec === 0) output = payload;
  else if (codec === 1) output = snappyUncompress(payload);
  else throw new Error(`unsupported Parquet compression codec ${codec}`);
  if (expectedSize != null && output.length !== expectedSize) {
    throw new Error(`Parquet page size mismatch: expected ${expectedSize}, decoded ${output.length}`);
  }
  return output;
}

function readUnsignedVarint(buffer, state) {
  let value = 0, shift = 0;
  for (;;) {
    const byte = buffer[state.offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return value;
    shift += 7;
  }
}

function decodeRleBitPacked(buffer, width, count, offset = 0) {
  if (width === 0) return { values: Array(count).fill(0), offset };
  const state = { offset };
  const values = [];
  const byteWidth = Math.ceil(width / 8);
  while (values.length < count && state.offset < buffer.length) {
    const header = readUnsignedVarint(buffer, state);
    if ((header & 1) === 0) {
      const run = header >> 1;
      let value = 0;
      for (let i = 0; i < byteWidth; i++) value += buffer[state.offset++] * 2 ** (8 * i);
      for (let i = 0; i < run && values.length < count; i++) values.push(value);
    } else {
      const total = (header >> 1) * 8;
      let bitOffset = state.offset * 8;
      for (let i = 0; i < total && values.length < count; i++) {
        let value = 0;
        for (let bit = 0; bit < width; bit++) {
          const absolute = bitOffset++;
          value |= ((buffer[absolute >> 3] >> (absolute & 7)) & 1) << bit;
        }
        values.push(value);
      }
      state.offset = Math.ceil(bitOffset / 8);
    }
  }
  if (values.length !== count) throw new Error(`RLE/bit-pack decoded ${values.length} of ${count} values`);
  return { values, offset: state.offset };
}

function decodePlain(buffer, physicalType, count, typeLength = null) {
  const values = [];
  let offset = 0;
  if (physicalType === 0) {
    for (let i = 0; i < count; i++) values.push(Boolean((buffer[i >> 3] >> (i & 7)) & 1));
    offset = Math.ceil(count / 8);
  } else if (physicalType === 1) {
    for (let i = 0; i < count; i++, offset += 4) values.push(buffer.readInt32LE(offset));
  } else if (physicalType === 2) {
    for (let i = 0; i < count; i++, offset += 8) {
      const value = buffer.readBigInt64LE(offset);
      const number = Number(value);
      if (!Number.isSafeInteger(number)) throw new Error('INT64 exceeds JavaScript safe range');
      values.push(number);
    }
  } else if (physicalType === 4) {
    for (let i = 0; i < count; i++, offset += 4) values.push(buffer.readFloatLE(offset));
  } else if (physicalType === 5) {
    for (let i = 0; i < count; i++, offset += 8) values.push(buffer.readDoubleLE(offset));
  } else if (physicalType === 6) {
    for (let i = 0; i < count; i++) {
      const length = buffer.readUInt32LE(offset); offset += 4;
      values.push(buffer.subarray(offset, offset + length).toString('utf8'));
      offset += length;
    }
  } else if (physicalType === 7 && typeLength != null) {
    for (let i = 0; i < count; i++, offset += typeLength) values.push(buffer.subarray(offset, offset + typeLength));
  } else throw new Error(`unsupported Parquet physical type ${physicalType}`);
  return { values, offset };
}

function schemaLeaves(schema) {
  const leaves = [];
  let index = 0;
  function visit(path, maxDefinition, maxRepetition, isRoot = false) {
    const element = schema[index++];
    const name = text(element[4]);
    const repetition = element[3] ?? 0;
    const definition = maxDefinition + (repetition === 1 || repetition === 2 ? 1 : 0);
    const repeated = maxRepetition + (repetition === 2 ? 1 : 0);
    const children = element[5] ?? 0;
    const currentPath = isRoot ? [] : [...path, name];
    if (!children) {
      leaves.push({
        path: currentPath, name: currentPath[0], physicalType: element[1],
        typeLength: element[2] ?? null, maxDefinition: definition,
        maxRepetition: repeated,
      });
    } else for (let child = 0; child < children; child++) visit(currentPath, definition, repeated, false);
  }
  visit([], 0, 0, true);
  return leaves;
}

function parseFooter(path) {
  const file = readFileSync(path);
  if (file.subarray(0, 4).toString() !== 'PAR1' || file.subarray(-4).toString() !== 'PAR1') {
    throw new Error(`${path}: invalid Parquet magic`);
  }
  const metadataLength = file.readUInt32LE(file.length - 8);
  const start = file.length - 8 - metadataLength;
  const reader = new CompactReader(file.subarray(start, file.length - 8));
  const metadata = reader.struct();
  const schema = metadata[2];
  const leaves = schemaLeaves(schema);
  return {
    path, numRows: metadata[3], createdBy: text(metadata[6]),
    schema, leaves, rowGroups: metadata[4],
  };
}

function chunkMetadata(rowGroup, leaf) {
  const chunks = rowGroup[1];
  for (const chunk of chunks) {
    const meta = chunk[3];
    const path = (meta[3] || []).map(text);
    if (path.join('.') === leaf.path.join('.')) return { chunk, meta };
  }
  throw new Error(`missing Parquet column chunk ${leaf.path.join('.')}`);
}

function decodeColumnChunk(fd, rowGroup, leaf) {
  const { meta } = chunkMetadata(rowGroup, leaf);
  const codec = meta[4];
  const dataOffset = meta[9];
  const dictionaryOffset = meta[11];
  const start = dictionaryOffset != null ? Math.min(dictionaryOffset, dataOffset) : dataOffset;
  const length = meta[7];
  const chunk = Buffer.allocUnsafe(length);
  const read = readSync(fd, chunk, 0, length, start);
  if (read !== length) throw new Error(`short read for ${leaf.path.join('.')}: ${read}/${length}`);
  let offset = 0;
  let dictionary = null;
  const records = [];
  while (offset < chunk.length && records.length < meta[5]) {
    const headerReader = new CompactReader(chunk, offset);
    const header = headerReader.struct();
    offset = headerReader.offset;
    const compressedSize = header[3];
    const uncompressedSize = header[2];
    const pagePayload = chunk.subarray(offset, offset + compressedSize);
    offset += compressedSize;
    const pageType = header[1];
    if (pageType === 2) {
      const page = decompress(codec, pagePayload, uncompressedSize);
      dictionary = decodePlain(page, leaf.physicalType, header[7][1], leaf.typeLength).values;
      continue;
    }
    if (pageType !== 0 && pageType !== 3) continue;

    let numValues, encoding, repetitionLevels, definitionLevels, valueBuffer;
    if (pageType === 0) {
      const dataHeader = header[5];
      numValues = dataHeader[1];
      encoding = dataHeader[2];
      const page = decompress(codec, pagePayload, uncompressedSize);
      let pageOffset = 0;
      if (leaf.maxRepetition > 0) {
        const bytes = page.readUInt32LE(pageOffset); pageOffset += 4;
        repetitionLevels = decodeRleBitPacked(page.subarray(pageOffset, pageOffset + bytes), bitWidth(leaf.maxRepetition), numValues).values;
        pageOffset += bytes;
      } else repetitionLevels = Array(numValues).fill(0);
      if (leaf.maxDefinition > 0) {
        const bytes = page.readUInt32LE(pageOffset); pageOffset += 4;
        definitionLevels = decodeRleBitPacked(page.subarray(pageOffset, pageOffset + bytes), bitWidth(leaf.maxDefinition), numValues).values;
        pageOffset += bytes;
      } else definitionLevels = Array(numValues).fill(0);
      valueBuffer = page.subarray(pageOffset);
    } else {
      const dataHeader = header[8];
      numValues = dataHeader[1];
      encoding = dataHeader[4];
      const repetitionBytes = dataHeader[6] || 0;
      const definitionBytes = dataHeader[5] || 0;
      repetitionLevels = leaf.maxRepetition > 0
        ? decodeRleBitPacked(pagePayload.subarray(0, repetitionBytes), bitWidth(leaf.maxRepetition), numValues).values
        : Array(numValues).fill(0);
      definitionLevels = leaf.maxDefinition > 0
        ? decodeRleBitPacked(pagePayload.subarray(repetitionBytes, repetitionBytes + definitionBytes), bitWidth(leaf.maxDefinition), numValues).values
        : Array(numValues).fill(0);
      const rawValues = pagePayload.subarray(repetitionBytes + definitionBytes);
      valueBuffer = dataHeader[7] === false ? rawValues : decompress(
        codec, rawValues, uncompressedSize - repetitionBytes - definitionBytes,
      );
    }
    const present = definitionLevels.reduce((total, level) => total + (level === leaf.maxDefinition ? 1 : 0), 0);
    let values;
    if (encoding === 0) values = decodePlain(valueBuffer, leaf.physicalType, present, leaf.typeLength).values;
    else if (encoding === 2 || encoding === 8) {
      if (!dictionary) throw new Error(`dictionary data page without dictionary for ${leaf.path.join('.')}`);
      const width = valueBuffer[0];
      const indices = decodeRleBitPacked(valueBuffer, width, present, 1).values;
      values = indices.map((index) => dictionary[index]);
    } else throw new Error(`unsupported Parquet encoding ${encoding} for ${leaf.path.join('.')}`);
    let valueIndex = 0;
    for (let i = 0; i < numValues; i++) {
      records.push({
        repetition: repetitionLevels[i],
        definition: definitionLevels[i],
        value: definitionLevels[i] === leaf.maxDefinition ? values[valueIndex++] : null,
      });
    }
  }
  return records;
}

function materialize(records, leaf, rowCount) {
  if (leaf.maxRepetition === 0) {
    if (records.length !== rowCount) throw new Error(`${leaf.name}: expected ${rowCount} rows, decoded ${records.length}`);
    return records.map((record) => record.value);
  }
  const rows = [];
  let current = null;
  for (const record of records) {
    if (record.repetition === 0) {
      if (current !== null) rows.push(current);
      current = [];
    }
    if (record.definition === leaf.maxDefinition) current.push(record.value);
  }
  if (current !== null) rows.push(current);
  while (rows.length < rowCount) rows.push([]);
  if (rows.length !== rowCount) throw new Error(`${leaf.name}: expected ${rowCount} list rows, decoded ${rows.length}`);
  return rows;
}

export function inspectParquet(path) {
  const footer = parseFooter(path);
  return {
    path, numRows: footer.numRows, rowGroupCount: footer.rowGroups.length,
    createdBy: footer.createdBy,
    columns: footer.leaves.map((leaf) => ({
      name: leaf.name, path: leaf.path.join('.'), physicalType: leaf.physicalType,
      maxDefinition: leaf.maxDefinition, maxRepetition: leaf.maxRepetition,
    })),
  };
}

export function scanParquet(path, columnNames, onRowGroup) {
  const footer = parseFooter(path);
  const selected = columnNames.map((name) => {
    const leaf = footer.leaves.find((value) => value.name === name);
    if (!leaf) throw new Error(`${path}: missing column ${name}`);
    return leaf;
  });
  const fd = openSync(path, 'r');
  try {
    let rowBase = 0;
    for (let groupIndex = 0; groupIndex < footer.rowGroups.length; groupIndex++) {
      const group = footer.rowGroups[groupIndex];
      const rowCount = group[3];
      const columns = {};
      for (const leaf of selected) columns[leaf.name] = materialize(decodeColumnChunk(fd, group, leaf), leaf, rowCount);
      onRowGroup(columns, { groupIndex, rowBase, rowCount });
      rowBase += rowCount;
    }
    if (rowBase !== footer.numRows) throw new Error(`${path}: footer has ${footer.numRows} rows, scanned ${rowBase}`);
  } finally { closeSync(fd); }
  return footer.numRows;
}
