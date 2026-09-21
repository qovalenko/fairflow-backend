import { deflateRawSync } from 'node:zlib';
import {
  sanitizeDocxBuffer,
  DocxValidationError,
  extractDocxPlaceholders,
} from './docx-sanitize';

/**
 * Build a minimal ZIP from the given entries so the central-directory parser has
 * something real to read. Entries default to STORE (uncompressed); pass
 * `deflate: true` to DEFLATE the data (compression method 8), which also
 * exercises the extractor's inflate path. crc32 is not validated, so it is zero.
 */
function buildZip(entries: { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const method = e.deflate ? 8 : 0;
    const stored = e.deflate ? deflateRawSync(e.data) : e.data;
    const local = Buffer.alloc(30 + name.length + stored.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(method, 8); // compression
    local.writeUInt32LE(0, 14); // crc32
    local.writeUInt32LE(stored.length, 18); // compressed size
    local.writeUInt32LE(e.data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    name.copy(local, 30);
    stored.copy(local, 30 + name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(method, 10); // compression
    central.writeUInt32LE(0, 16); // crc32
    central.writeUInt32LE(stored.length, 20); // compressed size
    central.writeUInt32LE(e.data.length, 24); // uncompressed size
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42); // local header offset
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length;
  }

  const localBlob = Buffer.concat(locals);
  const centralBlob = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); // entries this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralBlob.length, 12); // cd size
  eocd.writeUInt32LE(localBlob.length, 16); // cd offset
  return Buffer.concat([localBlob, centralBlob, eocd]);
}

const OOXML = [
  { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types/>') },
  { name: 'word/document.xml', data: Buffer.from('<?xml version="1.0"?><w:document>{{contact.name}}</w:document>') },
];

function reason(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof DocxValidationError ? e.reason : `unexpected:${(e as Error).message}`;
  }
}

describe('sanitizeDocxBuffer', () => {
  it('accepts a well-formed OOXML package', () => {
    const buf = buildZip(OOXML);
    expect(() => sanitizeDocxBuffer(buf)).not.toThrow();
    expect(sanitizeDocxBuffer(buf).entries.length).toBe(2);
  });

  it('rejects an empty buffer as corrupt', () => {
    expect(reason(() => sanitizeDocxBuffer(Buffer.alloc(0)))).toBe('corrupt');
  });

  it('rejects non-zip bytes as corrupt (no central directory)', () => {
    expect(reason(() => sanitizeDocxBuffer(Buffer.from('not a zip at all')))).toBe('corrupt');
  });

  it('rejects a zip missing the OOXML manifest parts', () => {
    const buf = buildZip([{ name: 'random.txt', data: Buffer.from('hi') }]);
    expect(reason(() => sanitizeDocxBuffer(buf))).toBe('not_ooxml');
  });

  it('rejects a VBA macro carrier', () => {
    const buf = buildZip([...OOXML, { name: 'word/vbaProject.bin', data: Buffer.from('MZ') }]);
    expect(reason(() => sanitizeDocxBuffer(buf))).toBe('vba_macro');
  });

  it('rejects an XXE DOCTYPE/ENTITY declaration', () => {
    const buf = buildZip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      {
        name: 'word/document.xml',
        data: Buffer.from('<!DOCTYPE x [ <!ENTITY e SYSTEM "file:///etc/passwd"> ]><w:document/>'),
      },
    ]);
    expect(reason(() => sanitizeDocxBuffer(buf))).toBe('xxe');
  });

  it('rejects a DDEAUTO field-code injection', () => {
    const buf = buildZip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      { name: 'word/document.xml', data: Buffer.from('<w:document>DDEAUTO c:\\calc</w:document>') },
    ]);
    expect(reason(() => sanitizeDocxBuffer(buf))).toBe('dde');
  });

  it('rejects XXE hidden inside a DEFLATE-compressed part (deflate stream defeats the byte scan)', () => {
    const buf = buildZip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      {
        name: 'word/document.xml',
        data: Buffer.from('<!DOCTYPE x [ <!ENTITY e SYSTEM "file:///etc/passwd"> ]><w:document/>'),
        deflate: true,
      },
    ]);
    expect(reason(() => sanitizeDocxBuffer(buf))).toBe('xxe');
  });

  it('rejects DDEAUTO hidden inside a DEFLATE-compressed part', () => {
    const buf = buildZip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      { ...{ name: 'word/document.xml', data: Buffer.from('<w:document>DDEAUTO c:\\calc</w:document>') }, deflate: true },
    ]);
    expect(reason(() => sanitizeDocxBuffer(buf))).toBe('dde');
  });
});

/** Wrap DOCX body text as a word/document.xml part with the given inner XML. */
function docBody(inner: string) {
  return { name: 'word/document.xml', data: Buffer.from(`<?xml version="1.0"?><w:document>${inner}</w:document>`) };
}

describe('extractDocxPlaceholders', () => {
  it('extracts flat dotted keys, sorted and de-duplicated', () => {
    const buf = buildZip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      docBody('<w:t>{{company.name}} / {{contact.name}}</w:t><w:t>{{contact.name}}</w:t>'),
    ]);
    expect(extractDocxPlaceholders(buf)).toEqual(['company.name', 'contact.name']);
  });

  it('inflates DEFLATE-compressed parts', () => {
    const buf = buildZip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      { ...docBody('<w:t>{{deal.amount}}</w:t>'), deflate: true },
    ]);
    expect(extractDocxPlaceholders(buf)).toEqual(['deal.amount']);
  });

  it('rejoins a placeholder Word split across <w:t> runs', () => {
    const buf = buildZip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      docBody('<w:t>{{con</w:t><w:t>tact.na</w:t><w:t>me}}</w:t>'),
    ]);
    expect(extractDocxPlaceholders(buf)).toEqual(['contact.name']);
  });

  it('scans headers and footers as well as the body', () => {
    const buf = buildZip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      docBody('<w:t>{{deal.name}}</w:t>'),
      { name: 'word/header1.xml', data: Buffer.from('<w:hdr><w:t>{{company.inn}}</w:t></w:hdr>') },
      { name: 'word/footer2.xml', data: Buffer.from('<w:ftr><w:t>{{today.year}}</w:t></w:ftr>') },
    ]);
    expect(extractDocxPlaceholders(buf)).toEqual(['company.inn', 'deal.name', 'today.year']);
  });

  it('ignores section/partial/comment markers and non-key text', () => {
    const buf = buildZip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      docBody('<w:t>{{#loop}}{{/loop}}{{^inv}}{{>partial}}{{! note}}{{ two words }}{{order.number}}</w:t>'),
    ]);
    expect(extractDocxPlaceholders(buf)).toEqual(['order.number']);
  });

  it('tolerates whitespace inside the delimiters', () => {
    const buf = buildZip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      docBody('<w:t>{{  contact.email  }}</w:t>'),
    ]);
    expect(extractDocxPlaceholders(buf)).toEqual(['contact.email']);
  });

  it('returns [] for a template with no placeholders', () => {
    const buf = buildZip([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      docBody('<w:t>Договор без переменных</w:t>'),
    ]);
    expect(extractDocxPlaceholders(buf)).toEqual([]);
  });

  it('returns [] for unreadable / non-zip bytes instead of throwing', () => {
    expect(extractDocxPlaceholders(Buffer.from('not a zip'))).toEqual([]);
    expect(extractDocxPlaceholders(Buffer.alloc(0))).toEqual([]);
  });
});
