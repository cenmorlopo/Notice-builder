const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');

const FILES = {
  calc: path.join(__dirname, 'penalty_calc_output.txt'),
  audit: path.join(__dirname, 'penalty_audit.txt'),
  summaryHtml: path.join(__dirname, 'notice_summary.html'),
  allHtml: path.join(__dirname, 'all_notices.html'),
  pdf: path.join(__dirname, 'all_notices.pdf'),
  manifest: path.join(__dirname, 'notice_manifest.txt'),
  failed: path.join(__dirname, 'notice_failed.txt'),
  log: path.join(__dirname, 'notice_log.txt')
};

const CONFIG = {
  oldHtmlBase: 'http://results.beup.ac.in/ResultsBTech2ndSem2024_B2023Pub.aspx',
  currentResult: {
    year: '2025',
    semester: 'II',
    examHeld: 'November/2025'
  },
  timeoutMs: 30000,
  maxRetries: 3,
  retryDelayMs: 1500,
  politeDelayMs: 250
};

function ensureFile(filePath, defaultContent = '') {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, defaultContent, 'utf8');
  }
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(FILES.log, line + '\n', 'utf8');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function splitMulti(v) {
  return String(v || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
}

function parsePipeLine(line) {
  return line.split('|').map(x => x.trim());
}

function parseNumber(raw) {
  const cleaned = String(raw ?? '').replace(/[^\d.\-]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function buildOldUrl(regNo) {
  return `${CONFIG.oldHtmlBase}?Sem=II&RegNo=${regNo}`;
}

function buildNewApiUrl(regNo) {
  const u = new URL('https://beu-bih.ac.in/backend/v1/result/get-result');
  u.searchParams.set('year', CONFIG.currentResult.year);
  u.searchParams.set('redg_no', regNo);
  u.searchParams.set('semester', CONFIG.currentResult.semester);
  u.searchParams.set('exam_held', CONFIG.currentResult.examHeld);
  return u.toString();
}

function buildNewFrontendUrl(regNo) {
  const u = new URL('https://beu-bih.ac.in/result-three');
  u.searchParams.set('name', 'B.Tech. 2nd Semester Examination, 2025 (Old)');
  u.searchParams.set('semester', CONFIG.currentResult.semester);
  u.searchParams.set('session', CONFIG.currentResult.year);
  u.searchParams.set('regNo', regNo);
  u.searchParams.set('exam_held', CONFIG.currentResult.examHeld);
  return u.toString();
}

async function fetchWithRetries(url, expectJson = false) {
  let delay = CONFIG.retryDelayMs;
  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout: CONFIG.timeoutMs,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': expectJson ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml'
        },
        validateStatus: status => status >= 200 && status < 500
      });

      if (response.status !== 200) {
        return { kind: 'ERROR', error: `HTTP ${response.status}` };
      }

      if (expectJson) {
        if (!response.data || response.data.status !== 200 || !response.data.data) {
          return { kind: 'NO_RECORD' };
        }
        return { kind: 'FOUND', data: response.data.data };
      }

      if (typeof response.data === 'string' && !response.data.includes('No Record Found !!!')) {
        return { kind: 'FOUND', html: response.data };
      }
      return { kind: 'NO_RECORD' };
    } catch (error) {
      if (attempt === CONFIG.maxRetries) {
        return { kind: 'ERROR', error: error.message };
      }
      await sleep(delay);
      delay *= 2;
    }
  }
  return { kind: 'ERROR', error: 'Unknown fetch error' };
}

function loadPenaltyCalc() {
  const raw = fs.readFileSync(FILES.calc, 'utf8')
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean)
    .filter(line => !/^reg_no\s*\|/i.test(line));

  return raw.map(line => {
    const p = parsePipeLine(line);
    return {
      reg_no: p[0] || '',
      branch_code: p[1] || '',
      penalized_subject_codes: splitMulti(p[2] || ''),
      subject_names: splitMulti(p[3] || ''),
      old_shown_grades: splitMulti(p[4] || ''),
      new_shown_grades: splitMulti(p[5] || ''),
      should_be_grades: splitMulti(p[6] || ''),
      shown_sgpa: p[7] || '',
      corrected_sgpa: p[8] || '',
      shown_cgpa: p[9] || '',
      corrected_cgpa: p[10] || '',
      status: p[11] || ''
    };
  }).filter(x => x.reg_no);
}

function loadAudit() {
  const raw = fs.readFileSync(FILES.audit, 'utf8')
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean)
    .filter(line => !/^reg_no\s*\|/i.test(line));

  const byReg = new Map();
  for (const line of raw) {
    const p = parsePipeLine(line);
    const row = {
      reg_no: p[0] || '',
      sem: p[1] || '',
      subject_code: p[2] || '',
      subject_name: p[3] || '',
      credit: p[4] || '',
      old_shown_grade: p[5] || '',
      new_shown_grade: p[6] || '',
      should_be_grade: p[7] || '',
      shown_gp: p[8] || '',
      corrected_gp: p[9] || '',
      delta_points: p[10] || ''
    };
    if (!byReg.has(row.reg_no)) byReg.set(row.reg_no, []);
    byReg.get(row.reg_no).push(row);
  }
  return byReg;
}

function parseOldHtml(html) {
  const $ = cheerio.load(html);

  function label(id) {
    return normalize($(`#${id}`).text());
  }

  const meta = {
    reg_no: label('ContentPlaceHolder1_DataList1_RegistrationNoLabel_0'),
    student_name: label('ContentPlaceHolder1_DataList1_StudentNameLabel_0'),
    father_name: label('ContentPlaceHolder1_DataList1_FatherNameLabel_0'),
    mother_name: label('ContentPlaceHolder1_DataList1_MotherNameLabel_0'),
    college_name: label('ContentPlaceHolder1_DataList1_CollegeNameLabel_0'),
    course_name: label('ContentPlaceHolder1_DataList1_CourseLabel_0'),
    exam_name: label('ContentPlaceHolder1_DataList4_Exam_Name_0'),
    semester: label('ContentPlaceHolder1_DataList2_Exam_Name_0') || 'II',
    exam_held: normalize($('#ContentPlaceHolder1_DataList2 td:nth-of-type(2)').text().split(':').pop()),
    shown_sgpa: label('ContentPlaceHolder1_DataList5_GROSSTHEORYTOTALLabel_0'),
    shown_cgpa: normalize($('#ContentPlaceHolder1_GridView3 tr:nth-child(2) td:last-child').text()),
    remarks: normalize($('#ContentPlaceHolder1_lblRemarks').text()) || normalize($('body').text().match(/Remarks\s*:?\s*([^\n]+)/i)?.[1] || '')
  };

  const theory = [];
  $('#ContentPlaceHolder1_GridView1 tr').slice(1).each((_, el) => {
    const tds = $(el).find('td');
    if (tds.length >= 7) {
      theory.push({
        code: normalize($(tds[0]).text()),
        name: normalize($(tds[1]).text()),
        ese: normalize($(tds[2]).text()),
        ia: normalize($(tds[3]).text()),
        total: normalize($(tds[4]).text()),
        grade: normalize($(tds[5]).text()),
        credit: normalize($(tds[6]).text())
      });
    }
  });

  const practical = [];
  $('#ContentPlaceHolder1_GridView2 tr').slice(1).each((_, el) => {
    const tds = $(el).find('td');
    if (tds.length >= 7) {
      practical.push({
        code: normalize($(tds[0]).text()),
        name: normalize($(tds[1]).text()),
        ese: normalize($(tds[2]).text()),
        ia: normalize($(tds[3]).text()),
        total: normalize($(tds[4]).text()),
        grade: normalize($(tds[5]).text()),
        credit: normalize($(tds[6]).text())
      });
    }
  });

  return { meta, theory, practical };
}

function parseNewJson(data) {
  const meta = {
    reg_no: String(data.redg_no || ''),
    student_name: String(data.name || ''),
    father_name: String(data.father_name || ''),
    mother_name: String(data.mother_name || ''),
    college_name: String(data.college_name || ''),
    course_name: String(data.course || ''),
    exam_name: 'B.Tech. 2nd Semester Examination, 2025 (Old)',
    semester: String(data.semester || 'II'),
    exam_held: String(data.exam_held || ''),
    shown_sgpa: String((data.sgpa && data.sgpa[1]) || ''),
    shown_cgpa: String(data.cgpa || ''),
    remarks: String(data.fail_any || '')
  };

  const theory = (data.theorySubjects || []).map(s => ({
    code: String(s.code || ''),
    name: String(s.name || ''),
    ese: String(s.ese || ''),
    ia: String(s.ia || ''),
    total: String(s.total || ''),
    grade: String(s.grade || ''),
    credit: String(s.credit || '')
  }));

  const practical = (data.practicalSubjects || []).map(s => ({
    code: String(s.code || ''),
    name: String(s.name || ''),
    ese: String(s.ese || ''),
    ia: String(s.ia || ''),
    total: String(s.total || ''),
    grade: String(s.grade || ''),
    credit: String(s.credit || '')
  }));

  return { meta, theory, practical };
}

function normalize(v) {
  return String(v || '').trim();
}

function renderMetaBlock(meta) {
  return `
    <div class="meta-grid">
      <div><b>Registration No:</b> ${esc(meta.reg_no)}</div>
      <div><b>Student Name:</b> ${esc(meta.student_name)}</div>
      <div><b>Father's Name:</b> ${esc(meta.father_name)}</div>
      <div><b>Mother's Name:</b> ${esc(meta.mother_name)}</div>
      <div><b>College Name:</b> ${esc(meta.college_name)}</div>
      <div><b>Course Name:</b> ${esc(meta.course_name)}</div>
      <div><b>Semester:</b> ${esc(meta.semester)}</div>
      <div><b>Examination:</b> ${esc(meta.exam_held)}</div>
    </div>
  `;
}

function renderResultTable(title, subjects, penalizedSet, shouldMap, mode) {
  const rows = subjects.map(s => {
    const isPen = penalizedSet.has(s.code);
    const shownGrade = isPen ? `<span class="grade-oval">${esc(s.grade)}</span>` : esc(s.grade);
    const shouldGrade = isPen && mode === 'new'
      ? `<span class="grade-should">${esc(shouldMap.get(s.code) || '-')}</span>`
      : '<span class="muted">—</span>';

    return `
      <tr class="${isPen ? 'row-issue' : ''}">
        <td>${esc(s.code)}</td>
        <td>${esc(s.name)}</td>
        <td>${esc(s.ese)}</td>
        <td>${esc(s.ia)}</td>
        <td>${esc(s.total)}</td>
        <td>${shownGrade}</td>
        <td>${esc(s.credit)}</td>
        <td>${shouldGrade}</td>
      </tr>
    `;
  }).join('');

  return `
    <div class="result-section">
      <h4>${esc(title)}</h4>
      <table>
        <thead>
          <tr>
            <th>Subject Code</th>
            <th>Subject Name</th>
            <th>ESE</th>
            <th>IA</th>
            <th>Total</th>
            <th>Grade</th>
            <th>Credit</th>
            <th>Correct Grade</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderResultBlock(label, parsed, penalizedSet, shouldMap, mode, link) {
  return `
    <section class="report-box">
      <div class="report-head">
        <div>
          <h3>${esc(label)}</h3>
          <div class="subtitle">${esc(parsed.meta.exam_name || '')}</div>
        </div>
        <div class="link-box"><a href="${esc(link)}">Open Source</a></div>
      </div>
      ${renderMetaBlock(parsed.meta)}
      ${renderResultTable(`${label} - Theory`, parsed.theory, penalizedSet, shouldMap, mode)}
      ${renderResultTable(`${label} - Practical`, parsed.practical, penalizedSet, shouldMap, mode)}
      <div class="sg-block">
        <div><b>SGPA:</b> ${esc(parsed.meta.shown_sgpa)}</div>
        <div><b>Current CGPA:</b> ${esc(parsed.meta.shown_cgpa)}</div>
        <div><b>Remarks:</b> ${esc(parsed.meta.remarks)}</div>
      </div>
    </section>
  `;
}

function renderDiscrepancyTable(auditRows) {
  const rows = auditRows.map(a => `
    <tr>
      <td>${esc(a.subject_code)}</td>
      <td>${esc(a.subject_name)}</td>
      <td>${esc(a.credit)}</td>
      <td><span class="grade-oval">${esc(a.old_shown_grade)}</span></td>
      <td><span class="grade-oval">${esc(a.new_shown_grade)}</span></td>
      <td><span class="grade-should">${esc(a.should_be_grade)}</span></td>
      <td>${esc(a.delta_points)}</td>
    </tr>
  `).join('');

  return `
    <section class="impact-panel">
      <h3>Discrepancy Details</h3>
      <table>
        <thead>
          <tr>
            <th>Subject Code</th>
            <th>Subject Name</th>
            <th>Credit</th>
            <th>Original Grade</th>
            <th>Updated Shown Grade</th>
            <th>Correct Grade</th>
            <th>Delta Points</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  `;
}

function renderImpactBox(student) {
  const shownS = parseNumber(student.shown_sgpa);
  const corrS = parseNumber(student.corrected_sgpa);
  const shownC = parseNumber(student.shown_cgpa);
  const corrC = parseNumber(student.corrected_cgpa);
  const dS = Number.isFinite(corrS - shownS) ? (corrS - shownS).toFixed(2) : '-';
  const dC = Number.isFinite(corrC - shownC) ? (corrC - shownC).toFixed(2) : '-';

  return `
    <section class="impact-box">
      <h3>Academic Impact After Removing Penalty</h3>
      <div class="impact-grid">
        <div><b>Shown SGPA:</b> ${esc(student.shown_sgpa)}</div>
        <div><b>Corrected SGPA:</b> <span class="impact-value">${esc(student.corrected_sgpa)}</span></div>
        <div><b>SGPA Increase:</b> ${esc(dS)}</div>
        <div><b>Shown Current CGPA:</b> ${esc(student.shown_cgpa)}</div>
        <div><b>Corrected Current CGPA:</b> <span class="impact-value">${esc(student.corrected_cgpa)}</span></div>
        <div><b>CGPA Increase:</b> ${esc(dC)}</div>
      </div>
    </section>
  `;
}

function renderCase(student, auditRows, oldParsed, newParsed) {
  const penalizedSet = new Set(student.penalized_subject_codes);
  const shouldMap = new Map(auditRows.map(a => [a.subject_code, a.should_be_grade]));
  const oldUrl = buildOldUrl(student.reg_no);
  const newUrl = buildNewFrontendUrl(student.reg_no);

  const topMeta = newParsed.meta.student_name ? newParsed.meta : oldParsed.meta;

  return `
    <article class="case">
      <div class="report-title">
        <div class="report-title-main">Bihar Engineering University, Patna</div>
        <div class="report-title-sub">Discrepancy Report - Original Result vs Updated Result</div>
        <div class="report-reg"><b>Registration No:</b> ${esc(student.reg_no)} &nbsp; <b>Branch Code:</b> ${esc(student.branch_code)}</div>
      </div>

      <div class="identity-box">
        <div><b>Student Name:</b> ${esc(topMeta.student_name)}</div>
        <div><b>Father's Name:</b> ${esc(topMeta.father_name)}</div>
        <div><b>Mother's Name:</b> ${esc(topMeta.mother_name)}</div>
        <div><b>College:</b> ${esc(topMeta.college_name)}</div>
        <div><b>Course:</b> ${esc(topMeta.course_name)}</div>
      </div>

      ${renderResultBlock('Original Result', oldParsed, penalizedSet, shouldMap, 'old', oldUrl)}
      ${renderResultBlock('Updated Result', newParsed, penalizedSet, shouldMap, 'new', newUrl)}
      ${renderDiscrepancyTable(auditRows)}
      ${renderImpactBox(student)}
    </article>
  `;
}

function buildPage(title, bodyHtml) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${esc(title)}</title>
  <style>
    @page { size: A4 portrait; margin: 8mm; }
    body { font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 10.2px; line-height: 1.25; }
    h1,h2,h3,h4,p { margin: 0; }
    .report-title { text-align: center; border: 2px solid #111; padding: 8px; margin-bottom: 8px; }
    .report-title-main { font-size: 18px; font-weight: 700; }
    .report-title-sub { font-size: 13px; font-weight: 700; margin-top: 4px; }
    .report-reg { margin-top: 4px; font-size: 11px; }
    .identity-box, .report-box, .impact-box, .impact-panel, .summary-card { border: 1.8px solid #111; padding: 8px; margin-bottom: 8px; }
    .identity-box div { margin: 2px 0; }
    .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 10px; margin-top: 6px; }
    .report-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px; }
    .subtitle { font-size: 11px; font-weight: 700; margin-top: 2px; }
    .link-box a { font-size: 10px; }
    table { width: 100%; border-collapse: collapse; margin-top: 6px; }
    th, td { border: 1px solid #333; padding: 3px 4px; vertical-align: top; }
    th { background: #f1f1f1; font-size: 9.8px; }
    .row-issue { background: #fff2cc; }
    .grade-oval { display: inline-block; padding: 1px 8px; border: 2.5px solid #eab308; border-radius: 999px; background: #fff7cc; font-weight: 700; }
    .grade-should { display: inline-block; padding: 1px 7px; border: 2.5px solid #16a34a; border-radius: 5px; background: #dcfce7; font-weight: 700; }
    .impact-value { display: inline-block; padding: 1px 6px; border: 2px solid #b91c1c; background: #fee2e2; font-weight: 700; }
    .impact-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 5px 10px; margin-top: 6px; }
    .sg-block { display: grid; grid-template-columns: 1fr 1fr 2fr; gap: 6px; margin-top: 6px; border-top: 1px solid #aaa; padding-top: 6px; }
    .muted { color: #777; }
    .case { page-break-after: always; }
    .toc li { margin-bottom: 2px; }
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

function summarize(calcRows, auditMap) {
  const totalStudents = calcRows.length;
  let totalSubjects = 0;
  let totalDeltaSgpa = 0;
  let totalDeltaCgpa = 0;
  const branchCount = new Map();
  const subjectCount = new Map();

  for (const row of calcRows) {
    totalSubjects += row.penalized_subject_codes.length;
    branchCount.set(row.branch_code, (branchCount.get(row.branch_code) || 0) + 1);

    const ds = parseNumber(row.corrected_sgpa) - parseNumber(row.shown_sgpa);
    const dc = parseNumber(row.corrected_cgpa) - parseNumber(row.shown_cgpa);
    if (Number.isFinite(ds)) totalDeltaSgpa += ds;
    if (Number.isFinite(dc)) totalDeltaCgpa += dc;

    const audits = auditMap.get(row.reg_no) || [];
    for (const a of audits) {
      subjectCount.set(a.subject_code, (subjectCount.get(a.subject_code) || 0) + 1);
    }
  }

  return {
    totalStudents,
    totalSubjects,
    avgDeltaSgpa: totalStudents ? (totalDeltaSgpa / totalStudents).toFixed(2) : '0.00',
    avgDeltaCgpa: totalStudents ? (totalDeltaCgpa / totalStudents).toFixed(2) : '0.00',
    topBranches: Array.from(branchCount.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10),
    topSubjects: Array.from(subjectCount.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10)
  };
}

function renderSummaryPage(summary) {
  const branches = summary.topBranches.map(([code, count]) => `<tr><td>${esc(code)}</td><td>${esc(count)}</td></tr>`).join('');
  const subjects = summary.topSubjects.map(([code, count]) => `<tr><td>${esc(code)}</td><td>${esc(count)}</td></tr>`).join('');

  return buildPage('BEU Discrepancy Summary', `
    <div class="report-title">
      <div class="report-title-main">Bihar Engineering University, Patna</div>
      <div class="report-title-sub">Summary of Grade Discrepancy Cases</div>
    </div>
    <div class="summary-card">
      <div><b>Total Affected Students:</b> ${esc(summary.totalStudents)}</div>
      <div><b>Total Penalized Subject Rows:</b> ${esc(summary.totalSubjects)}</div>
      <div><b>Average SGPA Increase:</b> ${esc(summary.avgDeltaSgpa)}</div>
      <div><b>Average CGPA Increase:</b> ${esc(summary.avgDeltaCgpa)}</div>
    </div>
    <div class="summary-card">
      <h3>Top Branches</h3>
      <table><thead><tr><th>Branch Code</th><th>Students</th></tr></thead><tbody>${branches}</tbody></table>
    </div>
    <div class="summary-card">
      <h3>Top Subject Codes</h3>
      <table><thead><tr><th>Subject Code</th><th>Count</th></tr></thead><tbody>${subjects}</tbody></table>
    </div>
  `);
}

async function renderPdfFromHtml(htmlPath, pdfPath) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  try {
    const page = await browser.newPage();
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '8mm', right: '6mm', bottom: '8mm', left: '6mm' }
    });
  } finally {
    await browser.close();
  }
}

async function main() {
  ensureFile(FILES.failed, '');
  ensureFile(FILES.log, '');
  ensureFile(FILES.manifest, '');

  const calcRows = loadPenaltyCalc().filter(r => (r.status || '').toUpperCase().includes('PENALTY'));
  const auditMap = loadAudit();
  log(`Loaded ${calcRows.length} confirmed penalty students`);

  const summaryHtml = renderSummaryPage(summarize(calcRows, auditMap));
  fs.writeFileSync(FILES.summaryHtml, summaryHtml, 'utf8');

  const cases = [];
  const manifest = [];

  for (let i = 0; i < calcRows.length; i++) {
    const student = calcRows[i];
    const regNo = student.reg_no;
    const oldUrl = buildOldUrl(regNo);
    const newUrl = buildNewApiUrl(regNo);

    const oldFetched = await fetchWithRetries(oldUrl, false);
    if (oldFetched.kind !== 'FOUND') {
      fs.appendFileSync(FILES.failed, `${regNo} | OLD_FETCH_FAILED | ${oldUrl}\n`, 'utf8');
      log(`[${i + 1}/${calcRows.length}] ${regNo} -> OLD_FETCH_FAILED`);
      continue;
    }

    const newFetched = await fetchWithRetries(newUrl, true);
    if (newFetched.kind !== 'FOUND') {
      fs.appendFileSync(FILES.failed, `${regNo} | NEW_FETCH_FAILED | ${newUrl}\n`, 'utf8');
      log(`[${i + 1}/${calcRows.length}] ${regNo} -> NEW_FETCH_FAILED`);
      continue;
    }

    const oldParsed = parseOldHtml(oldFetched.html);
    const newParsed = parseNewJson(newFetched.data);
    const auditRows = auditMap.get(regNo) || [];

    cases.push(renderCase(student, auditRows, oldParsed, newParsed));
    manifest.push(`${regNo} | OK | ${oldUrl} | ${buildNewFrontendUrl(regNo)}`);
    log(`[${i + 1}/${calcRows.length}] ${regNo} -> NOTICE_READY`);
    await sleep(CONFIG.politeDelayMs);
  }

  const allHtml = buildPage('All Discrepancy Notices', `
    <div class="report-title">
      <div class="report-title-main">Bihar Engineering University, Patna</div>
      <div class="report-title-sub">Consolidated Discrepancy Report</div>
    </div>
    ${cases.join('\n')}
  `);

  fs.writeFileSync(FILES.allHtml, allHtml, 'utf8');
  fs.writeFileSync(FILES.manifest, manifest.join('\n') + '\n', 'utf8');

  log('Rendering final PDF...');
  await renderPdfFromHtml(FILES.allHtml, FILES.pdf);
  log(`PDF ready: ${FILES.pdf}`);
}

main().catch(err => {
  log(`FATAL ${err.stack || err.message}`);
  process.exit(1);
});
