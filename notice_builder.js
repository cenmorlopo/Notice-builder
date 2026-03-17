const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');

const ROOT = __dirname;

const FILES = {
  calc: path.join(ROOT, 'penalty_calc_output.txt'),
  audit: path.join(ROOT, 'penalty_audit.txt'),
  html: path.join(ROOT, 'all_notices.html'),
  pdf: path.join(ROOT, 'all_notices.pdf'),
  failed: path.join(ROOT, 'notice_failed.txt'),
  log: path.join(ROOT, 'notice_log.txt')
};

const DEFAULT_NEW = {
  year: '2025',
  semester: 'II',
  examHeld: 'November/2025',
  examName: 'B.Tech. 2nd Semester Examination, 2025 (Old)'
};

function ensureFile(filePath, defaultContent = '') {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, defaultContent, 'utf8');
  }
}

function resetOutputs() {
  fs.writeFileSync(FILES.failed, '', 'utf8');
  fs.writeFileSync(FILES.log, '', 'utf8');
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(FILES.log, `${line}\n`, 'utf8');
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function splitPipe(line) {
  return line.split('|').map((x) => x.trim());
}

function splitCsvField(value) {
  return String(value || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function readTextLines(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function loadCalcRows() {
  const lines = readTextLines(FILES.calc).filter((line) => !/^reg_no\s*\|/i.test(line));
  return lines.map((line) => {
    const p = splitPipe(line);
    return {
      reg_no: p[0] || '',
      branch_code: p[1] || '',
      penalized_subject_codes: splitCsvField(p[2] || ''),
      subject_names: splitCsvField(p[3] || ''),
      old_shown_grades: splitCsvField(p[4] || ''),
      new_shown_grades: splitCsvField(p[5] || ''),
      should_be_grades: splitCsvField(p[6] || ''),
      shown_sgpa: p[7] || '',
      corrected_sgpa: p[8] || '',
      shown_cgpa: p[9] || '',
      corrected_cgpa: p[10] || '',
      status: p[11] || '',
      old_result_url: p[12] || '',
      new_result_url: p[13] || ''
    };
  });
}

function loadAuditMap() {
  const lines = readTextLines(FILES.audit).filter((line) => !/^reg_no\s*\|/i.test(line));
  const byReg = new Map();

  for (const line of lines) {
    const p = splitPipe(line);
    const row = {
      reg_no: p[0] || '',
      sem: p[1] || '',
      branch_code: p[2] || '',
      subject_code: p[3] || '',
      subject_name: p[4] || '',
      subject_type: p[5] || '',
      credit: p[6] || '',
      old_shown_grade: p[7] || '',
      new_shown_grade: p[8] || '',
      should_be_grade: p[9] || '',
      shown_gp: p[10] || '',
      corrected_gp: p[11] || '',
      delta_points: p[12] || '',
      new_ese: p[13] || '',
      new_ia: p[14] || '',
      new_total: p[15] || '',
      old_result_url: p[16] || '',
      new_result_url: p[17] || ''
    };

    if (!byReg.has(row.reg_no)) byReg.set(row.reg_no, []);
    byReg.get(row.reg_no).push(row);
  }

  return byReg;
}

function sortPenaltyRows(rows) {
  return [...rows].sort((a, b) => {
    const aGroup = String(a.reg_no).startsWith('23') ? 0 : String(a.reg_no).startsWith('22') ? 1 : 2;
    const bGroup = String(b.reg_no).startsWith('23') ? 0 : String(b.reg_no).startsWith('22') ? 1 : 2;
    if (aGroup !== bGroup) return aGroup - bGroup;
    return String(a.reg_no).localeCompare(String(b.reg_no));
  });
}

function fetchConfig() {
  return {
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    validateStatus: (status) => status >= 200 && status < 500
  };
}

async function fetchWithRetry(url, mode = 'html') {
  const tries = 3;
  let delay = 1200;

  for (let i = 1; i <= tries; i += 1) {
    try {
      const response = await axios.get(url, fetchConfig());

      if (response.status !== 200) {
        if (i === tries) return { ok: false, reason: `HTTP_${response.status}` };
      } else if (mode === 'html') {
        const html = typeof response.data === 'string' ? response.data : '';
        if (html && !/No Record Found/i.test(html)) {
          return { ok: true, data: html };
        }
        return { ok: false, reason: 'NO_RECORD' };
      } else {
        return { ok: true, data: response.data };
      }
    } catch (error) {
      if (i === tries) return { ok: false, reason: error.message };
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
    delay *= 2;
  }

  return { ok: false, reason: 'UNKNOWN_FETCH_ERROR' };
}

function pickFirst(obj, keys, fallback = '') {
  for (const key of keys) {
    if (
      obj &&
      obj[key] !== undefined &&
      obj[key] !== null &&
      String(obj[key]).trim() !== ''
    ) {
      return obj[key];
    }
  }
  return fallback;
}

function resolveUrls(row, auditRows) {
  const firstAudit = auditRows[0] || {};
  return {
    old_result_url: row.old_result_url || firstAudit.old_result_url || '',
    new_result_url: row.new_result_url || firstAudit.new_result_url || ''
  };
}

function deriveNewApiInfo(resolvedRow) {
  try {
    const url = new URL(resolvedRow.new_result_url);
    return {
      year: url.searchParams.get('session') || DEFAULT_NEW.year,
      semester: url.searchParams.get('semester') || DEFAULT_NEW.semester,
      examHeld: url.searchParams.get('exam_held') || DEFAULT_NEW.examHeld,
      frontendUrl: resolvedRow.new_result_url || '',
      examName: url.searchParams.get('name')
        ? decodeURIComponent(url.searchParams.get('name')).replace(/\+/g, ' ')
        : DEFAULT_NEW.examName
    };
  } catch (_error) {
    return {
      year: DEFAULT_NEW.year,
      semester: DEFAULT_NEW.semester,
      examHeld: DEFAULT_NEW.examHeld,
      frontendUrl: resolvedRow.new_result_url || '',
      examName: DEFAULT_NEW.examName
    };
  }
}

function deriveNewApiUrl(resolvedRow) {
  const info = deriveNewApiInfo(resolvedRow);
  const url = new URL('https://beu-bih.ac.in/backend/v1/result/get-result');
  url.searchParams.set('year', info.year);
  url.searchParams.set('redg_no', resolvedRow.reg_no);
  url.searchParams.set('semester', info.semester);
  url.searchParams.set('exam_held', info.examHeld);
  return url.toString();
}

function parseOldHtml(html, fallbackOldUrl = '') {
  const $ = cheerio.load(html);
  const textById = (id) => normalizeText($(`#${id}`).text());

  const theory = [];
  $('#ContentPlaceHolder1_GridView1 tr').slice(1).each((_, el) => {
    const tds = $(el).find('td');
    if (tds.length >= 7) {
      theory.push({
        code: normalizeText($(tds[0]).text()),
        name: normalizeText($(tds[1]).text()),
        ese: normalizeText($(tds[2]).text()),
        ia: normalizeText($(tds[3]).text()),
        total: normalizeText($(tds[4]).text()),
        grade: normalizeText($(tds[5]).text()),
        credit: normalizeText($(tds[6]).text())
      });
    }
  });

  const practical = [];
  $('#ContentPlaceHolder1_GridView2 tr').slice(1).each((_, el) => {
    const tds = $(el).find('td');
    if (tds.length >= 7) {
      practical.push({
        code: normalizeText($(tds[0]).text()),
        name: normalizeText($(tds[1]).text()),
        ese: normalizeText($(tds[2]).text()),
        ia: normalizeText($(tds[3]).text()),
        total: normalizeText($(tds[4]).text()),
        grade: normalizeText($(tds[5]).text()),
        credit: normalizeText($(tds[6]).text())
      });
    }
  });

  const cgpaCell = normalizeText($('#ContentPlaceHolder1_GridView3 tr').eq(1).find('td').last().text());
  const examTitle = normalizeText($('#ContentPlaceHolder1_DataList4_Exam_Name_0').text());
  const semester = textById('ContentPlaceHolder1_DataList2_Exam_Name_0') || 'II';
  const remarks = textById('ContentPlaceHolder1_DataList3_remarkLabel_0') ||
    normalizeText(($('body').text().match(/Remarks\s*:?\s*([^\n]+)/i) || [])[1]);
  const examHeldText = normalizeText($('#ContentPlaceHolder1_DataList2 table tr td').eq(1).text());
  const examHeld = normalizeText((examHeldText.split(':')[1] || examHeldText).replace(/\s+/g, ' '));

  return {
    old_url: fallbackOldUrl,
    exam_name: examTitle || 'B.Tech. 2nd Semester Examination, 2024',
    semester,
    exam_held: examHeld || 'DEC/2024',
    reg_no: textById('ContentPlaceHolder1_DataList1_RegistrationNoLabel_0'),
    student_name: textById('ContentPlaceHolder1_DataList1_StudentNameLabel_0'),
    course_name: `${textById('ContentPlaceHolder1_DataList1_CourseCodeLabel_0')}${textById('ContentPlaceHolder1_DataList1_CourseCodeLabel_0') ? ' - ' : ''}${textById('ContentPlaceHolder1_DataList1_CourseLabel_0')}`.trim(),
    college_name: `${textById('ContentPlaceHolder1_DataList1_CollegeCodeLabel_0')}${textById('ContentPlaceHolder1_DataList1_CollegeCodeLabel_0') ? ' - ' : ''}${textById('ContentPlaceHolder1_DataList1_CollegeNameLabel_0')}`.trim(),
    sgpa: textById('ContentPlaceHolder1_DataList5_GROSSTHEORYTOTALLabel_0'),
    cgpa: cgpaCell,
    remarks,
    theory,
    practical
  };
}

function getNewRoot(apiPayload) {
  if (!apiPayload) return {};
  if (apiPayload.data && typeof apiPayload.data === 'object') return apiPayload.data;
  return apiPayload;
}

function pickArray(obj, keys) {
  for (const key of keys) {
    if (Array.isArray(obj?.[key])) return obj[key];
  }
  return [];
}

function parseNewJson(apiPayload, resolvedRow) {
  const root = getNewRoot(apiPayload);
  const info = deriveNewApiInfo(resolvedRow);

  const theorySource = pickArray(root, ['theorySubjects', 'theory_subjects', 'theory', 'theory_subject']);
  const practicalSource = pickArray(root, ['practicalSubjects', 'practical_subjects', 'practical', 'practical_subject']);

  const theory = theorySource.map((s) => ({
    code: normalizeText(pickFirst(s, ['code', 'subject_code'])),
    name: normalizeText(pickFirst(s, ['name', 'subject_name'])),
    ese: normalizeText(pickFirst(s, ['ese', 'ESE'])),
    ia: normalizeText(pickFirst(s, ['ia', 'IA'])),
    total: normalizeText(pickFirst(s, ['total', 'TOTAL'])),
    grade: normalizeText(pickFirst(s, ['grade', 'GRADE'])),
    credit: normalizeText(pickFirst(s, ['credit', 'CREDIT']))
  }));

  const practical = practicalSource.map((s) => ({
    code: normalizeText(pickFirst(s, ['code', 'subject_code'])),
    name: normalizeText(pickFirst(s, ['name', 'subject_name'])),
    ese: normalizeText(pickFirst(s, ['ese', 'ESE'])),
    ia: normalizeText(pickFirst(s, ['ia', 'IA'])),
    total: normalizeText(pickFirst(s, ['total', 'TOTAL'])),
    grade: normalizeText(pickFirst(s, ['grade', 'GRADE'])),
    credit: normalizeText(pickFirst(s, ['credit', 'CREDIT']))
  }));

  let sgpa = pickFirst(root, ['sgpa', 'SGPA']);
  if (Array.isArray(sgpa)) sgpa = sgpa[1] || sgpa[0] || '';

  return {
    new_frontend_url: info.frontendUrl,
    exam_name: info.examName,
    semester: String(info.semester || DEFAULT_NEW.semester),
    exam_held: String(info.examHeld || DEFAULT_NEW.examHeld),
    reg_no: normalizeText(pickFirst(root, ['redg_no', 'reg_no', 'registration_no'], resolvedRow.reg_no)),
    student_name: normalizeText(pickFirst(root, ['name', 'student_name'])),
    course_name: normalizeText(pickFirst(root, ['course', 'course_name'])),
    college_name: normalizeText(pickFirst(root, ['college_name', 'college'])),
    sgpa: normalizeText(sgpa),
    cgpa: normalizeText(pickFirst(root, ['cgpa', 'current_cgpa', 'cur_cgpa'])),
    remarks: normalizeText(pickFirst(root, ['fail_any', 'remarks'])),
    theory,
    practical
  };
}

function buildBadge(type, value) {
  const safe = esc(value || '—');
  if (type === 'published') return `<span class="penalty-grade">${safe}</span>`;
  if (type === 'expected') return `<span class="real-grade">${safe}</span>`;
  return `<span class="oval">${safe}</span>`;
}

function renderSubjectRows(subjects, penalizedSet, shouldMap, mode) {
  return subjects.map((subject) => {
    const isPenalized = penalizedSet.has(subject.code);
    let gradeCell = esc(subject.grade || '');
    let correctCell = '—';

    if (isPenalized && mode === 'old') {
      gradeCell = buildBadge('old', subject.grade);
    }

    if (isPenalized && mode === 'new') {
      gradeCell = buildBadge('published', subject.grade);
      correctCell = buildBadge('expected', shouldMap.get(subject.code) || '');
    }

    return `
      <tr class="${isPenalized ? (mode === 'old' ? 'fault-old' : 'fault-new') : ''}">
        <td class="code">${esc(subject.code)}</td>
        <td class="name">${esc(subject.name)}</td>
        <td class="num">${esc(subject.ese)}</td>
        <td class="num">${esc(subject.ia)}</td>
        <td class="num">${esc(subject.total)}</td>
        <td class="grade">${gradeCell}</td>
        <td class="credit">${esc(subject.credit)}</td>
        ${mode === 'new' ? `<td class="grade">${correctCell}</td>` : ''}
      </tr>`;
  }).join('');
}

function renderCase(row, resolvedRow, auditRows, oldData, newData) {
  const penalizedSet = new Set(auditRows.map((x) => x.subject_code));
  const shouldMap = new Map(auditRows.map((x) => [x.subject_code, x.should_be_grade]));

  const oldTheoryRows = renderSubjectRows(oldData.theory, penalizedSet, shouldMap, 'old');
  const oldPracticalRows = renderSubjectRows(oldData.practical, penalizedSet, shouldMap, 'old');
  const newTheoryRows = renderSubjectRows(newData.theory, penalizedSet, shouldMap, 'new');
  const newPracticalRows = renderSubjectRows(newData.practical, penalizedSet, shouldMap, 'new');

  const summaryRows = auditRows.map((item) => `
    <tr>
      <td class="code">${esc(item.subject_code)}</td>
      <td class="name">${esc(item.subject_name)}</td>
      <td class="credit">${esc(item.credit)}</td>
      <td class="grade" style="background:#fff1e6;">${buildBadge('old', item.old_shown_grade)}</td>
      <td class="grade" style="background:#fff8cc;">${buildBadge('published', item.new_shown_grade)}</td>
      <td class="grade" style="background:#e8f7e8;">${buildBadge('expected', item.should_be_grade)}</td>
    </tr>`).join('');

  const displayedOldCgpa = oldData.cgpa || row.shown_cgpa || '';
  const displayedOldRemarks = oldData.remarks || '';
  const displayedNewRemarks = newData.remarks || '';

  const sgpaIncrease = (Number(row.corrected_sgpa) - Number(row.shown_sgpa)).toFixed(2);
  const cgpaIncrease = (Number(row.corrected_cgpa) - Number(row.shown_cgpa)).toFixed(2);

  return `
    <div class="student-sheet" style="page-break-after:always;">
      <div class="main-box top-merged">
        <h1>Bihar Engineering University, Patna</h1>
        <h2>Discrepancy Report</h2>

        <div class="top-meta">
          <div class="meta-line">
            <div><span class="label">Registration No:</span> ${esc(row.reg_no)}</div>
            <div><span class="label">Student Name:</span> ${esc(newData.student_name || oldData.student_name)}</div>
          </div>
          <div class="meta-line">
            <div><span class="label">Course Name:</span> ${esc(newData.course_name || oldData.course_name)}</div>
            <div><span class="label">College Name:</span> ${esc(newData.college_name || oldData.college_name)}</div>
          </div>
        </div>
      </div>

      <div class="main-box">
        <div class="sub-head">
          <span>${esc(oldData.exam_name)} | Semester: ${esc(oldData.semester)} | Examination: ${esc(oldData.exam_held)}</span>
          <a href="${esc(resolvedRow.old_result_url)}">Click here to download</a>
        </div>

        <table>
          <thead>
            <tr>
              <th class="code">Subject Code</th>
              <th class="name">Subject Name</th>
              <th class="num">ESE</th>
              <th class="num">IA</th>
              <th class="num">Total</th>
              <th class="grade">Grade</th>
              <th class="credit">Credit</th>
            </tr>
          </thead>
          <tbody>${oldTheoryRows}</tbody>
        </table>

        <div class="sub-head"><span>Practical</span><span></span></div>

        <table>
          <thead>
            <tr>
              <th class="code">Subject Code</th>
              <th class="name">Subject Name</th>
              <th class="num">ESE</th>
              <th class="num">IA</th>
              <th class="num">Total</th>
              <th class="grade">Grade</th>
              <th class="credit">Credit</th>
            </tr>
          </thead>
          <tbody>${oldPracticalRows}</tbody>
        </table>

        <div class="result-line">
          SGPA: ${esc(oldData.sgpa || row.shown_sgpa)}
          <span class="sep">|</span>
          Current CGPA: ${esc(displayedOldCgpa)}
          <span class="sep">|</span>
          Remarks: <span style="color:#b00000;">${esc(displayedOldRemarks)}</span>
        </div>
      </div>

      <div class="main-box">
        <div class="sub-head">
          <span>${esc(newData.exam_name)} | Semester: ${esc(newData.semester)} | Examination: ${esc(newData.exam_held)}</span>
          <a href="${esc(resolvedRow.new_result_url)}">Click here to download</a>
        </div>

        <table>
          <thead>
            <tr>
              <th class="code">Subject Code</th>
              <th class="name">Subject Name</th>
              <th class="num">ESE</th>
              <th class="num">IA</th>
              <th class="num">Total</th>
              <th class="grade">Result Grade</th>
              <th class="credit">Credit</th>
              <th class="grade">Correct Grade</th>
            </tr>
          </thead>
          <tbody>${newTheoryRows}</tbody>
        </table>

        <div class="sub-head"><span>Practical</span><span></span></div>

        <table>
          <thead>
            <tr>
              <th class="code">Subject Code</th>
              <th class="name">Subject Name</th>
              <th class="num">ESE</th>
              <th class="num">IA</th>
              <th class="num">Total</th>
              <th class="grade">Result Grade</th>
              <th class="credit">Credit</th>
              <th class="grade">Correct Grade</th>
            </tr>
          </thead>
          <tbody>${newPracticalRows}</tbody>
        </table>

        <div class="result-line">
          SGPA: ${esc(row.shown_sgpa)}
          <span class="sep">|</span>
          Current CGPA: ${esc(row.shown_cgpa)}
          <span class="sep">|</span>
          Remarks: <span style="color:#b00000;">${esc(displayedNewRemarks)}</span>
        </div>
      </div>

      <div class="focus-box">
        <div class="focus-head">Discrepancy Summary</div>
        <div class="impact-pad">
          <table class="summary-table">
            <thead>
              <tr>
                <th style="width:12%;">Subject Code</th>
                <th style="width:30%;">Subject Name</th>
                <th style="width:10%;">Credit</th>
                <th style="width:14%;">Previous Grade</th>
                <th style="width:14%;">Published Grade</th>
                <th style="width:20%;">Expected Grade</th>
              </tr>
            </thead>
            <tbody>${summaryRows}</tbody>
          </table>

          <div class="impact-grid" style="margin-top:8px;border-top:1px solid #111;padding-top:8px;">
            <div><b>Published SGPA:</b> <span class="metric-old">${esc(row.shown_sgpa)}</span></div>
            <div><b>Corrected SGPA:</b> <span class="metric-corrected">${esc(row.corrected_sgpa)}</span></div>
            <div><b>Increase:</b> <span class="metric-increase">${esc(sgpaIncrease)}</span></div>

            <div><b>Published Current CGPA:</b> <span class="metric-old">${esc(row.shown_cgpa)}</span></div>
            <div><b>Corrected Current CGPA:</b> <span class="metric-corrected">${esc(row.corrected_cgpa)}</span></div>
            <div><b>Increase:</b> <span class="metric-increase">${esc(cgpaIncrease)}</span></div>
          </div>
        </div>
      </div>
    </div>`;
}

function buildHtmlDocument(content) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>BEU Discrepancy Report</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 8mm;
    }

    * { box-sizing: border-box; }

    html, body{
      background:#e9e9e9;
    }

    body{
      margin:0;
      font-family:Arial, Helvetica, sans-serif;
      font-size:10.5px;
      color:#111;
    }

    .page{
      width:210mm;
      min-height:297mm;
      margin:0 auto;
      background:#fff;
      padding:8mm;
      box-sizing:border-box;
    }

    .main-box{
      border:2px solid #111;
      margin-bottom:8px;
      background:#fff;
    }

    .top-merged{
      text-align:center;
      padding:8px 8px 6px 8px;
    }

    .top-merged h1{
      margin:0;
      font-size:18px;
      font-weight:700;
    }

    .top-merged h2{
      margin:3px 0 2px 0;
      font-size:13px;
      font-weight:700;
    }

    .top-meta{
      margin-top:6px;
      text-align:left;
      border-top:1px solid #111;
      padding-top:6px;
      line-height:1.35;
    }

    .meta-line{
      display:grid;
      grid-template-columns: 1fr 1fr;
      gap:8px 18px;
      margin:2px 0;
    }

    .label{ font-weight:700; }

    .sub-head{
      background:#efefef;
      border-bottom:1px solid #111;
      padding:4px 8px;
      font-weight:700;
      font-size:10.5px;
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:10px;
      line-height:1.15;
    }

    .sub-head a{
      color:#0a58ca;
      text-decoration:underline;
      white-space:nowrap;
      font-weight:700;
      font-size:10px;
    }

    table{
      width:100%;
      border-collapse:collapse;
      table-layout:fixed;
      margin:0;
    }

    th, td{
      border:1px solid #111;
      padding:4px 5px;
      vertical-align:top;
      word-wrap:break-word;
    }

    th{
      background:#f4f4f4;
      font-size:10px;
      font-weight:700;
    }

    .summary-table th,
    .summary-table td{
      padding:2px 5px;
      vertical-align:middle;
      line-height:1.1;
    }

    .code   { width:12%; text-align:center; }
    .name   { width:38%; }
    .num    { width:8%; text-align:center; }
    .grade  { width:11%; text-align:center; }
    .credit { width:10%; text-align:center; }

    .fault-old{ background:#fff1e6; }
    .fault-new{ background:#fff8cc; }

    .oval{
      display:inline-block;
      min-width:34px;
      padding:2px 10px;
      border:3px solid #d79b00;
      border-radius:999px;
      background:#fff0b8;
      font-weight:700;
      text-align:center;
      line-height:1.15;
    }

    .real-grade{
      display:inline-block;
      min-width:34px;
      padding:2px 10px;
      border:3px solid #1b8f3f;
      border-radius:6px;
      background:#dcf7e7;
      font-weight:700;
      text-align:center;
      line-height:1.15;
    }

    .penalty-grade{
      display:inline-block;
      min-width:34px;
      padding:2px 10px;
      border:3px solid #b00000;
      border-radius:6px;
      background:#ffe7e7;
      font-weight:700;
      text-align:center;
      line-height:1.15;
    }

    .result-line{
      border-top:1px solid #111;
      padding:4px 8px;
      font-size:10.2px;
      font-weight:700;
      text-align:center;
      line-height:1.1;
      word-spacing:1px;
    }

    .sep{
      display:inline-block;
      margin:0 18px;
    }

    .focus-box{
      border:2px solid #b00000;
      background:#fffaf9;
      margin-bottom:8px;
    }

    .focus-head{
      background:#b00000;
      color:#fff;
      font-weight:700;
      padding:4px 8px;
      font-size:11.5px;
    }

    .impact-pad{
      padding:5px 6px;
    }

    .impact-grid{
      display:grid;
      grid-template-columns:1fr 1fr 1fr;
      gap:4px 10px;
      padding:5px 0 0 0;
      font-size:10.5px;
      line-height:1.1;
    }

    .metric-old{
      display:inline-block;
      padding:1px 6px;
      border:2px solid #d97706;
      background:#ffedd5;
      border-radius:4px;
      font-weight:700;
      line-height:1;
    }

    .metric-corrected{
      display:inline-block;
      padding:1px 6px;
      border:2px solid #15803d;
      background:#dcfce7;
      border-radius:4px;
      font-weight:700;
      line-height:1;
    }

    .metric-increase{
      display:inline-block;
      padding:1px 6px;
      border:2px solid #2563eb;
      background:#dbeafe;
      border-radius:4px;
      font-weight:700;
      line-height:1;
    }

    .student-sheet:last-child{
      page-break-after:auto !important;
    }

    @media print{
      html, body{
        background:#fff !important;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }

      .page{
        width:auto !important;
        min-height:auto !important;
        margin:0 !important;
        padding:0 !important;
        background:#fff !important;
      }

      .main-box,
      .focus-box{
        break-inside: avoid;
        page-break-inside: avoid;
      }
    }
  </style>
</head>
<body>
  <div class="page">${content}</div>
</body>
</html>`;
}

async function renderPdf(htmlPath, pdfPath) {
  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 0,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--font-render-hinting=none'
    ]
  });

  try {
    const page = await browser.newPage();

    page.setDefaultTimeout(0);
    page.setDefaultNavigationTimeout(0);

    await page.goto(`file://${htmlPath}`, {
      waitUntil: 'domcontentloaded',
      timeout: 0
    });

    await page.emulateMediaType('screen');

    await new Promise((resolve) => setTimeout(resolve, 3000));

    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      timeout: 0,
      margin: {
        top: '0',
        right: '0',
        bottom: '0',
        left: '0'
      }
    });
  } finally {
    await browser.close();
  }
}

async function main() {
  ensureFile(FILES.calc);
  ensureFile(FILES.audit);
  resetOutputs();

  const calcRows = sortPenaltyRows(
    loadCalcRows().filter((row) => String(row.status).toUpperCase().includes('PENALTY_CONFIRMED'))
  );
  const auditMap = loadAuditMap();

  log(`Penalty rows loaded: ${calcRows.length}`);

  const rendered = [];

  for (let index = 0; index < calcRows.length; index += 1) {
    const row = calcRows[index];
    const auditRows = auditMap.get(row.reg_no) || [];
    const resolvedRow = { ...row, ...resolveUrls(row, auditRows) };

    if (!auditRows.length) {
      fs.appendFileSync(FILES.failed, `${row.reg_no} | NO_AUDIT_ROWS\n`, 'utf8');
      log(`[${index + 1}/${calcRows.length}] ${row.reg_no} -> NO_AUDIT_ROWS`);
      continue;
    }

    if (!resolvedRow.old_result_url) {
      fs.appendFileSync(FILES.failed, `${row.reg_no} | MISSING_OLD_URL\n`, 'utf8');
      log(`[${index + 1}/${calcRows.length}] ${row.reg_no} -> MISSING_OLD_URL`);
      continue;
    }

    const oldFetch = await fetchWithRetry(resolvedRow.old_result_url, 'html');
    if (!oldFetch.ok) {
      fs.appendFileSync(
        FILES.failed,
        `${row.reg_no} | OLD_FETCH_FAILED | ${resolvedRow.old_result_url} | ${oldFetch.reason}\n`,
        'utf8'
      );
      log(`[${index + 1}/${calcRows.length}] ${row.reg_no} -> OLD_FETCH_FAILED (${oldFetch.reason})`);
      continue;
    }

    const newApiUrl = deriveNewApiUrl(resolvedRow);
    const newFetch = await fetchWithRetry(newApiUrl, 'json');
    if (!newFetch.ok) {
      fs.appendFileSync(
        FILES.failed,
        `${row.reg_no} | NEW_FETCH_FAILED | ${newApiUrl} | ${newFetch.reason}\n`,
        'utf8'
      );
      log(`[${index + 1}/${calcRows.length}] ${row.reg_no} -> NEW_FETCH_FAILED (${newFetch.reason})`);
      continue;
    }

    try {
      const oldData = parseOldHtml(oldFetch.data, resolvedRow.old_result_url);
      const newData = parseNewJson(newFetch.data, resolvedRow);
      rendered.push(renderCase(row, resolvedRow, auditRows, oldData, newData));
      log(`[${index + 1}/${calcRows.length}] ${row.reg_no} -> OK`);
    } catch (error) {
      fs.appendFileSync(FILES.failed, `${row.reg_no} | RENDER_FAILED | ${error.message}\n`, 'utf8');
      log(`[${index + 1}/${calcRows.length}] ${row.reg_no} -> RENDER_FAILED (${error.message})`);
    }
  }

  const fullHtml = buildHtmlDocument(rendered.join('\n'));
  fs.writeFileSync(FILES.html, fullHtml, 'utf8');
  log(`HTML written: ${FILES.html}`);

  if (!rendered.length) {
    log('No student pages rendered. PDF skipped.');
    return;
  }

  await renderPdf(FILES.html, FILES.pdf);
  log(`PDF written: ${FILES.pdf}`);
}

main().catch((error) => {
  log(`FATAL: ${error.stack || error.message}`);
  process.exit(1);
});
