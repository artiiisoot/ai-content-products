import { CONFIG } from '../config.js';
import { getToken } from './auth.js';

/**
 * Sheets API 로 원장을 읽어 화면이 쓰는 모양으로 바꿉니다.
 * 예전에 Apps Script(Api.gs)가 하던 일을 그대로 브라우저에서 합니다.
 *  - 값 / 배경색 / 병합 / 숨김 행을 한 번의 호출로 받습니다
 *  - 목록형(헤더 한 줄, '행사명' 포함)과 매트릭스형('구분' 시작)을 구분해 읽습니다
 */

const FIELDS = [
  'sheets(properties(title,sheetId)',
  'merges',
  'data(rowData(values(formattedValue,effectiveFormat/backgroundColor))',
  'rowMetadata(hiddenByUser,hiddenByFilter)))'
].join(',');

export async function fetchLedger() {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.spreadsheetId}` +
    `?includeGridData=true&fields=${encodeURIComponent(FIELDS)}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (res.status === 401 || res.status === 403) {
    const err = new Error('로그인이 만료되었습니다. 다시 로그인해 주세요.');
    err.needLogin = true;
    throw err;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `시트를 읽지 못했습니다 (${res.status})`);
  }

  return toLedger(await res.json());
}

/** API 응답 → { legend, tabs } */
export function toLedger(payload) {
  const sheets = (payload.sheets || []).map(readSheet).filter(Boolean);
  return {
    updatedAt: new Date().toISOString(),
    legend: sheets.map((s) => s.legend).find((l) => l && l.length) || [],
    tabs: sheets.filter((s) => CONFIG.visibleKinds.includes(s.kind)).map(({ legend, ...tab }) => tab)
  };
}

function readSheet(sheet) {
  const title = sheet.properties?.title || '';
  const parsed = title.match(/^(\d{4})_(.+)$/);
  if (!parsed) return null;

  const grid = sheet.data?.[0] || {};
  const rows = grid.rowData || [];
  const values = rows.map((row) => (row.values || []).map((c) => text(c?.formattedValue)));
  const fills = rows.map((row) => (row.values || []).map((c) => hex(c?.effectiveFormat?.backgroundColor)));
  const hidden = (grid.rowMetadata || []).map((m) => Boolean(m?.hiddenByUser || m?.hiddenByFilter));
  applyMerges(values, sheet.merges);

  const base = { tab: title, year: parsed[1], kind: parsed[2], gid: sheet.properties?.sheetId };
  const headerRow = values.findIndex((row) => row.includes('행사명'));
  if (headerRow >= 0) {
    return { ...base, ...readList(values, fills, hidden, headerRow), legend: readLegend(values, fills) };
  }
  const divider = values.findIndex((row) => /^구분/.test(row[0] || ''));
  if (divider >= 0) return { ...base, ...readMatrix(values, hidden, divider) };
  return null;
}

/** 목록형: 한 줄 헤더 + 행마다 한 건 */
function readList(values, fills, hidden, headerRow) {
  const headers = values[headerRow].map(text);
  const nameCol = headers.indexOf('행사명');
  const rows = [];

  for (let r = headerRow + 1; r < values.length; r++) {
    const name = text(values[r][nameCol]);
    if (!name) continue;
    if (onlyCellFilled(values[r], nameCol)) continue;   // 하단 범례 행

    const item = { _row: r + 1, _fill: fills[r]?.[nameCol] || '#ffffff', _hidden: Boolean(hidden[r]) };
    headers.forEach((h, c) => { if (h) item[h] = text(values[r][c]); });
    rows.push(item);
  }
  return { type: 'list', headers: headers.filter(Boolean), rows };
}

/** 매트릭스형: 3줄 헤더(형태 / 행사명 / 주최) + 경쟁사 행 */
function readMatrix(values, hidden, headerRow) {
  const [formRow = [], nameRow = [], hostRow = []] =
    [values[headerRow], values[headerRow + 1], values[headerRow + 2]];

  const columns = [];
  let form = '';
  for (let c = 1; c < nameRow.length; c++) {
    if (text(formRow[c])) form = text(formRow[c]);
    const name = text(nameRow[c]);
    if (!name || /합계/.test(name)) continue;
    columns.push({ col: c, 행사명: name, 주최: text(hostRow[c]), 형태: form });
  }

  const rows = [];
  for (let r = headerRow + 3; r < values.length; r++) {
    const company = text(values[r][0]);
    if (!company) continue;
    const cells = columns.map((col) => text(values[r][col.col]));
    rows.push({ _row: r + 1, _hidden: Boolean(hidden[r]), 경쟁사: company, cells, 참가건수: cells.filter(Boolean).length });
  }
  return { type: 'matrix', columns, rows };
}

/** 시트 하단 범례(색 + 문구). 값이 한 칸에만 있는 행만 범례로 봅니다. */
function readLegend(values, fills) {
  const out = [];
  values.forEach((row, r) => {
    const filled = row.map((v, i) => (text(v) ? i : -1)).filter((i) => i >= 0);
    if (filled.length !== 1) return;
    const c = filled[0];
    const label = text(row[c]);
    const color = fills[r]?.[c];
    if (!color || color === '#ffffff' || color === '#000000' || label.length > 24) return;
    if (!out.some((x) => x.color === color)) out.push({ color, label });
  });
  return out;
}

/** 병합된 칸은 좌상단 값으로 채웁니다 */
function applyMerges(values, merges) {
  (merges || []).forEach((m) => {
    const v = values[m.startRowIndex]?.[m.startColumnIndex];
    if (!v) return;
    for (let r = m.startRowIndex; r < m.endRowIndex; r++) {
      for (let c = m.startColumnIndex; c < m.endColumnIndex; c++) {
        if (values[r]) values[r][c] = v;
      }
    }
  });
}

function onlyCellFilled(row, col) {
  return row.every((v, i) => i === col || !text(v));
}

function text(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

/** {red,green,blue} (0~1) → '#rrggbb' */
function hex(color) {
  if (!color) return '#ffffff';
  const to = (n) => Math.round((n || 0) * 255).toString(16).padStart(2, '0');
  return `#${to(color.red)}${to(color.green)}${to(color.blue)}`;
}
