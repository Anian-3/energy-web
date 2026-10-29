/*!
 * xlsx-lite.js —— 零依赖的 .xlsx 读写
 * 只用浏览器内建能力：TextEncoder / DecompressionStream / Blob。
 * 兼容本项目用到的 SheetJS 子集：
 *   XLSX.utils.book_new() / json_to_sheet() / aoa_to_sheet() / book_append_sheet()
 *   XLSX.utils.sheet_to_json()
 *   XLSX.read(arrayBuffer, { type: 'array' })
 *   XLSX.writeFile(workbook, filename)
 * 说明：写入采用「存储」压缩（不压缩），文件略大但格式完全标准，Excel / WPS / openpyxl 都能打开。
 */
(function (global) {
  'use strict';

  const XMLNS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const NSREL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  const enc = new TextEncoder();
  const dec = new TextDecoder('utf-8');

  // ───────────────────────── CRC32 ─────────────────────────
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ─────────────────────── ZIP 写入（stored） ───────────────────────
  function zipStore(files) {
    const chunks = [];
    const central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const data = f.data;
      const crc = crc32(data);

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // UTF-8 文件名
      lv.setUint16(8, 0, true); // stored
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      chunks.push(local, data);

      const cd = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      central.push(cd);

      offset += local.length + data.length;
    }

    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    const total = offset + cdSize + end.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    for (const c of central) {
      out.set(c, pos);
      pos += c.length;
    }
    out.set(end, pos);
    return out;
  }

  // ─────────────────────── ZIP 读取 ───────────────────────
  function findEocd(bytes) {
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) return i;
    }
    return -1;
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('当前浏览器不支持解压，无法读取 .xlsx（请升级浏览器）');
    }
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  async function unzip(bytes) {
    const eocd = findEocd(bytes);
    if (eocd < 0) throw new Error('不是有效的 xlsx 文件');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = dv.getUint16(eocd + 10, true);
    let ptr = dv.getUint32(eocd + 16, true);
    const entries = new Map();

    for (let i = 0; i < count; i++) {
      if (dv.getUint32(ptr, true) !== 0x02014b50) break;
      const method = dv.getUint16(ptr + 10, true);
      const compSize = dv.getUint32(ptr + 20, true);
      const nameLen = dv.getUint16(ptr + 28, true);
      const extraLen = dv.getUint16(ptr + 30, true);
      const commentLen = dv.getUint16(ptr + 32, true);
      const localOff = dv.getUint32(ptr + 42, true);
      const name = dec.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
      entries.set(name, { method, compSize, localOff });
      ptr += 46 + nameLen + extraLen + commentLen;
    }

    async function read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const lo = e.localOff;
      if (dv.getUint32(lo, true) !== 0x04034b50) throw new Error('zip 结构损坏');
      const nameLen = dv.getUint16(lo + 26, true);
      const extraLen = dv.getUint16(lo + 28, true);
      const start = lo + 30 + nameLen + extraLen;
      const raw = bytes.subarray(start, start + e.compSize);
      return e.method === 0 ? raw : await inflateRaw(raw);
    }

    return { names: [...entries.keys()], read };
  }

  // ───────────────────── XML 工具（不依赖 DOMParser） ─────────────────────
  function escapeXml(s) {
    return String(s)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function unescapeXml(s) {
    if (!s || s.indexOf('&') < 0) return s;
    return s
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  function colToIndex(ref) {
    const m = /^([A-Z]+)/.exec(ref || '');
    if (!m) return -1;
    let n = 0;
    for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  function indexToCol(i) {
    let s = '';
    let n = i + 1;
    while (n > 0) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  // ─────────────────────── 表结构 ───────────────────────
  function book_new() {
    return { SheetNames: [], Sheets: {} };
  }

  function aoa_to_sheet(aoa, opts) {
    return { __lite: true, aoa: aoa || [], cols: (opts && opts.cols) || null };
  }

  function json_to_sheet(rows, opts) {
    const list = rows || [];
    const headers = [];
    const seen = new Set();
    for (const r of list) {
      for (const k of Object.keys(r)) {
        if (!seen.has(k)) {
          seen.add(k);
          headers.push(k);
        }
      }
    }
    const aoa = [headers, ...list.map((r) => headers.map((h) => (r[h] === undefined || r[h] === null ? '' : r[h])))];
    return { __lite: true, aoa, cols: (opts && opts.cols) || null };
  }

  function book_append_sheet(wb, ws, name) {
    const sheetName = String(name || `Sheet${wb.SheetNames.length + 1}`).replace(/[[\]:*?/\\]/g, '_').slice(0, 31);
    wb.SheetNames.push(sheetName);
    wb.Sheets[sheetName] = ws;
  }

  function sheet_to_json(ws, opts) {
    if (!ws) return [];
    const aoa = ws.aoa || [];
    if (!aoa.length) return [];
    const headerRow = (opts && opts.header) ? 0 : 0;
    const headers = (aoa[headerRow] || []).map((h, i) => (h === '' || h == null ? `__EMPTY${i ? '_' + i : ''}` : String(h)));
    const out = [];
    for (let r = headerRow + 1; r < aoa.length; r++) {
      const row = aoa[r] || [];
      if (row.every((c) => c === '' || c === null || c === undefined)) continue;
      const obj = {};
      let any = false;
      for (let c = 0; c < headers.length; c++) {
        const v = row[c];
        if (v !== '' && v !== null && v !== undefined) {
          obj[headers[c]] = v;
          any = true;
        }
      }
      if (any) out.push(obj);
    }
    return out;
  }

  // ─────────────────────── 写入 xlsx ───────────────────────
  function numToStr(n) {
    if (Number.isInteger(n)) return String(n);
    const s = String(n);
    if (s.includes('e') || s.includes('E')) return n.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
    return s;
  }

  function buildSheetXml(ws) {
    const aoa = ws.aoa || [];
    const rowsXml = aoa.map((row, r) => {
      const cells = (row || []).map((val, c) => {
        const ref = `${indexToCol(c)}${r + 1}`;
        const style = r === 0 ? ' s="1"' : '';
        if (val === '' || val === null || val === undefined) return '';
        if (typeof val === 'number' && isFinite(val)) {
          return `<c r="${ref}"${style}><v>${numToStr(val)}</v></c>`;
        }
        if (typeof val === 'boolean') {
          return `<c r="${ref}" t="b"${style}><v>${val ? 1 : 0}</v></c>`;
        }
        return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${escapeXml(val)}</t></is></c>`;
      }).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    }).join('');

    let colsXml = '';
    const cols = ws['!cols'] || ws.cols;
    if (Array.isArray(cols) && cols.length) {
      colsXml = '<cols>' + cols.map((c, i) => {
        const w = (c && (c.wch || c.width)) || 12;
        return `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`;
      }).join('') + '</cols>';
    }

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${XMLNS}">${colsXml}<sheetData>${rowsXml}</sheetData></worksheet>`;
  }

  const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${XMLNS}">
<fonts count="2"><font><sz val="11"/><name val="等线"/></font><font><b/><sz val="11"/><name val="等线"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  function buildWorkbookBytes(wb) {
    const names = wb.SheetNames.slice();
    if (!names.length) throw new Error('工作簿里没有工作表');

    const sheetFiles = names.map((name, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: enc.encode(buildSheetXml(wb.Sheets[name] || { aoa: [] })),
    }));

    const sheetEntries = names
      .map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('');
    const relEntries = names
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NSREL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join('');
    const styleRelId = names.length + 1;

    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`;

    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${NSREL}/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

    const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${XMLNS}" xmlns:r="${NSREL}"><sheets>${sheetEntries}</sheets></workbook>`;

    const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${relEntries}
<Relationship Id="rId${styleRelId}" Type="${NSREL}/styles" Target="styles.xml"/>
</Relationships>`;

    return zipStore([
      { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
      { name: '_rels/.rels', data: enc.encode(rootRels) },
      { name: 'xl/workbook.xml', data: enc.encode(workbookXml) },
      { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(workbookRels) },
      { name: 'xl/styles.xml', data: enc.encode(STYLES_XML) },
      ...sheetFiles,
    ]);
  }

  function writeFile(wb, filename) {
    const bytes = buildWorkbookBytes(wb);
    if (typeof document === 'undefined') {
      if (typeof module !== 'undefined' && module.exports) {
        require('node:fs').writeFileSync(filename, bytes);
        return;
      }
      throw new Error('当前环境无法保存文件');
    }
    const blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ─────────────────────── 读取 xlsx ───────────────────────
  function parseRows(sheetXml, sharedStrings) {
    const aoa = [];
    const rowRe = /<row\b[^>]*?(?:r="(\d+)")?[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    let fallbackRow = 0;
    while ((rm = rowRe.exec(sheetXml))) {
      const rowNum = rm[1] ? parseInt(rm[1], 10) : ++fallbackRow;
      fallbackRow = rowNum;
      const rowIdx = rowNum - 1;
      const cells = [];
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm;
      let fallbackCol = 0;
      while ((cm = cellRe.exec(rm[2]))) {
        const attrs = cm[1] || '';
        const inner = cm[2] || '';
        const refM = /\br="([A-Z]+\d+)"/.exec(attrs);
        const colIdx = refM ? colToIndex(refM[1]) : fallbackCol;
        fallbackCol = colIdx + 1;
        if (colIdx < 0) continue;

        const typeM = /\bt="([^"]+)"/.exec(attrs);
        const type = typeM ? typeM[1] : 'n';

        let value = '';
        if (type === 'inlineStr') {
          const tm = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(inner);
          value = tm ? unescapeXml(tm[1]) : '';
        } else if (type === 's') {
          const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
          const idx = vm ? parseInt(vm[1], 10) : -1;
          value = idx >= 0 && sharedStrings[idx] !== undefined ? sharedStrings[idx] : '';
        } else if (type === 'str') {
          const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
          value = vm ? unescapeXml(vm[1]) : '';
        } else if (type === 'b') {
          const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
          value = vm && vm[1] === '1';
        } else {
          const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
          if (vm) {
            const num = Number(vm[1]);
            value = isFinite(num) && vm[1].trim() !== '' ? num : unescapeXml(vm[1]);
          }
        }
        cells[colIdx] = value;
      }
      if (cells.length) {
        // 补齐稀疏位置
        const dense = [];
        for (let i = 0; i < cells.length; i++) dense[i] = cells[i] === undefined ? '' : cells[i];
        aoa[rowIdx] = dense;
      }
    }
    for (let i = 0; i < aoa.length; i++) if (!aoa[i]) aoa[i] = [];
    return aoa;
  }

  async function read(data, opts) {
    let bytes;
    if (data instanceof Uint8Array) bytes = data;
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (data && data.buffer instanceof ArrayBuffer) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else throw new Error('无法识别的文件数据');

    const zip = await unzip(bytes);

    let sharedStrings = [];
    const ssRaw = await zip.read('xl/sharedStrings.xml');
    if (ssRaw) {
      const ssXml = dec.decode(ssRaw);
      const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
      let m;
      while ((m = siRe.exec(ssXml))) {
        const parts = [];
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let tm;
        while ((tm = tRe.exec(m[1]))) parts.push(unescapeXml(tm[1]));
        sharedStrings.push(parts.join(''));
      }
    }

    // 工作表名称与文件对应关系
    const wbXml = zip.read('xl/workbook.xml');
    const wbRels = zip.read('xl/_rels/workbook.xml.rels');
    const sheetDefs = [];
    if (wbXml) {
      const xml = dec.decode(await wbXml);
      const relTargets = new Map();
      if (wbRels) {
        const relXml = dec.decode(await wbRels);
        const relRe = /<Relationship\b([^>]*)\/?>/g;
        let rm;
        while ((rm = relRe.exec(relXml))) {
          const id = /\bId="([^"]+)"/.exec(rm[1]);
          const target = /\bTarget="([^"]+)"/.exec(rm[1]);
          if (id && target) {
            let t = target[1].replace(/^\/?xl\//, '').replace(/^\//, '');
            if (!t.startsWith('worksheets/') && !t.startsWith('xl/')) t = 'worksheets/' + t.replace(/^.*\//, '');
            relTargets.set(id[1], 'xl/' + t);
          }
        }
      }
      const sheetRe = /<sheet\b([^>]*)\/?>/g;
      let sm;
      while ((sm = sheetRe.exec(xml))) {
        const nameM = /\bname="([^"]*)"/.exec(sm[1]);
        const ridM = /\br:id="([^"]+)"/.exec(sm[1]) || /\bid="([^"]+)"/.exec(sm[1]);
        const target = ridM ? relTargets.get(ridM[1]) : null;
        sheetDefs.push({ name: nameM ? unescapeXml(nameM[1]) : `Sheet${sheetDefs.length + 1}`, target });
      }
    }

    const sheetFiles = zip.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    if (!sheetDefs.length) {
      for (const f of sheetFiles) sheetDefs.push({ name: f.replace(/^.*\//, '').replace(/\.xml$/, ''), target: f });
    }
    if (!sheetDefs.length) throw new Error('文件里没有找到工作表');

    const workbook = { SheetNames: [], Sheets: {} };
    for (const def of sheetDefs) {
      const file = def.target && zip.names.includes(def.target) ? def.target : sheetFiles[0];
      const raw = file ? await zip.read(file) : null;
      if (!raw) continue;
      const xml = dec.decode(raw);
      const aoa = parseRows(xml, sharedStrings);
      workbook.SheetNames.push(def.name);
      workbook.Sheets[def.name] = { __lite: true, aoa };
    }
    if (!workbook.SheetNames.length) throw new Error('无法解析工作表内容');
    return workbook;
  }

  const XLSX = {
    version: '1.0-lite',
    utils: { book_new, aoa_to_sheet, json_to_sheet, book_append_sheet, sheet_to_json },
    read,
    writeFile,
    _build: buildWorkbookBytes,
  };

  global.XLSX = XLSX;
  if (typeof module !== 'undefined' && module.exports) module.exports = XLSX;
})(typeof window !== 'undefined' ? window : globalThis);
